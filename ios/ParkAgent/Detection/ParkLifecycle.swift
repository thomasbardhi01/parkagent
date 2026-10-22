import CoreLocation
import Foundation
import UIKit

/// The street session lifecycle on the phone (FR-55).
///
/// A street park the server holds (`ParkedResponse.awaitsWalkAway`) shows
/// nothing while the phone is at the car: no notification, no sheet. The
/// phone reports where it is (LocationReporter), and the server's answer
/// to those reports is what happens next:
///
///  - the phone has left the car → the server's prompt, shown word for
///    word: a notification with Pay · Not now · Wrong spot when the app is
///    in a pocket, the Parked sheet when it is open;
///  - a Pay tapped at the car was kept, and started at walk-away;
///  - the phone came back → the session ended, or the unpaid park is gone.
///
/// Every payment goes through POST /parked/:id/confirm with the total that
/// was on screen. The server decides whether the phone has left the car;
/// nothing here pays on the phone's own say-so.
extension AppModel {
    /// /parked answered a park that waits for the walk-away: keep it,
    /// start reporting, and say nothing.
    func awaitWalkAway(_ response: ParkedResponse, for request: ParkedRequest) async {
        let coordinate = CLLocationCoordinate2D(latitude: request.lat, longitude: request.lng)
        carCoordinate = coordinate
        // An older park's prompt, sheet, or held notice is about a spot
        // the car has left.
        pendingParked = nil
        ParkedNotice.withdraw()
        var waiting = ParkedNotice.Waiting(
            response: response, latitude: coordinate.latitude, longitude: coordinate.longitude,
            savedAt: AppClock.now, shown: nil
        )
        waiting.parkedAt = request.ts
        startLifecycleReporting(waiting: waiting)
        // Already on foot when the park was detected (walking away is one
        // of the ways a park is confirmed): CoreMotion won't say so again.
        // Only the newest confident reading counts, and only one since the
        // car stopped: a walk to the trunk and back into the car, or a walk
        // from before the drive, is not a walk-away (#226).
        if let walk = WalkAway.since(
            stop: detector.lastParkStopAt, parkedAt: request.ts, newest: detector.lastConfidentMotion
        ) {
            await reporter.note(.leftCar, at: walk.at)
        }
    }

    /// Wire the reporter for the lifecycle and start it. A session already
    /// running keeps reporting; the waiting park rides along until the
    /// server says what became of it.
    private func startLifecycleReporting(waiting: ParkedNotice.Waiting?) {
        wireLifecycleReporter()
        reporter.start(api: api, carCoordinate: carCoordinate, waiting: waiting)
    }

    private func wireLifecycleReporter() {
        reporter.onResponse = { [weak self] response in
            await self?.handleLocationResponse(response)
        }
        // A `left_car` not yet taken stands only while motion still has
        // the driver on foot.
        reporter.stillOnFoot = { [weak self] in self?.detector.isOnFootNow ?? false }
    }

    /// Launch, or detection re-armed: pick a waiting park back up. iOS
    /// ends a backgrounded app between the park and the walk-away all the
    /// time; the relaunch for the next location event lands here.
    func resumeParkLifecycle() {
        wireLifecycleReporter()
        detector.onWalking = { [weak self] walkedAt in
            Task { await self?.phoneLeftCar(at: walkedAt) }
        }
        // The car's audio coming back sends nothing by itself (#226): it
        // wakes the detector, and the drive CoreMotion then sees is the
        // return (`drivingResumed`).
        detector.onCarAudioConnected = nil
        PushManager.shared.onWalkAwayAction = { [weak self] tap in
            await self?.handleWalkAwayTap(tap)
        }
        guard activeSession == nil, !reporter.isRunning, let waiting = ParkedNotice.restoreWaiting() else { return }
        carCoordinate = waiting.coordinate
        startLifecycleReporting(waiting: waiting)
    }

    /// Motion has the driver walking away (CoreMotion, walking or running
    /// at medium confidence or better, in no vehicle), since `walkedAt`.
    /// Never distance: a car at a red light is two still fixes away from
    /// where it parked (#226). A park waiting at the car takes it as the
    /// walk-away; a running session as "not in the car", which clears the
    /// server's memory of the phone beside it, so a bus pulling away from
    /// a stop near the car is not read as the car driving off.
    func phoneLeftCar(at walkedAt: Date? = nil) async {
        guard reporter.isRunning, reporter.waiting != nil || activeSession != nil else { return }
        if await !reporter.note(.leftCar, at: walkedAt) {
            // Turned down while a return was still to be said: told again
            // at the next wake, if the driver is still on that walk.
            detector.forgetToldWalk()
        }
    }

    /// Driving again (since `seenAt`, when CoreMotion dates the drive), or
    /// the car's audio back: the phone is in the car. Sent at once, with the
    /// fix that best shows where the phone was then, however blurry; the
    /// server ends the session (or drops the unpaid park) only when that
    /// fix is at the car.
    func phoneReturnedToCar(at seenAt: Date? = nil) async {
        guard reporter.isRunning else { return }
        await reporter.note(.returnedToCar, at: seenAt)
    }

    // MARK: - The server's answer to a fix

    /// `activity` reads the server's record of sessions (the Activity
    /// feed); tests hand in their own.
    func handleLocationResponse(
        _ response: LocationResponse,
        activity: (() async throws -> ActivityPage)? = nil
    ) async {
        if let ended = response.ended {
            await sessionEndedAtReturn(ended)
            return
        }
        if response.started == nil, let waiting = reporter.waiting,
           let unknown = LostStart.sessionToAdopt(response, waiting: waiting, holding: activeSession?.sessionId) {
            let read = activity ?? { [api] in try await api.walletActivity(cursor: nil) }
            await adoptRunningSession(unknown, waiting: waiting, activity: read)
            if reporter.waiting == nil { return }
        }
        guard var waiting = reporter.waiting, let park = response.park,
              park.parkedEventId == waiting.response.parkedEventId
        else { return }

        if let started = response.started {
            // Pay was tapped at the car; the server started it now.
            adoptSession(started, parked: waiting.presentable, zoneId: nil)
            return
        }
        switch park.status {
        case "at_car", "confirmed", "starting":
            return
        case "prompted":
            guard let prompt = response.prompt, prompt != waiting.shown else { return }
            waiting.shown = prompt
            // Asked again (a Pay kept at the car that left by distance):
            // that Pay no longer stands, and an hour with no answer is not
            // said as a walk-away that never came.
            waiting.confirmed = false
            reporter.setWaiting(waiting)
            await present(prompt, for: waiting)
        default:
            // Cancelled (back at the car unpaid, or drove off), free now,
            // covered by a running session, expired, failed: nothing left
            // to ask or pay.
            let unpaidPromise = park.status == "expired" && waiting.confirmed
            let guessedDriveOff = ParkedNotice.driveOffGuessContent(park, waiting: waiting)
            forgetWaitingPark(parkedEventId: park.parkedEventId)
            if let guessedDriveOff {
                // Dropped on a guess: said, not withdrawn in silence.
                await ParkedNotice.postPayFailed(guessedDriveOff, parkedEventId: park.parkedEventId)
                return
            }
            if unpaidPromise {
                // An early Pay that never got its walk-away: say so.
                let zone = waiting.response.candidates.first?.providerZoneNumber
                await ParkedNotice.postPayFailed(
                    ParkedNotice.expiredContent(zoneNumber: zone?.isEmpty == false ? zone : nil),
                    parkedEventId: park.parkedEventId
                )
            }
        }
    }

    /// The walk-away prompt: the sheet when the app is open, and a
    /// notification when it isn't (the usual case).
    private func present(_ prompt: ParkPrompt, for waiting: ParkedNotice.Waiting) async {
        paymentError = nil
        pendingParked = waiting.presentable
        if UIApplication.shared.applicationState != .active {
            await ParkedNotice.post(ParkedNotice.walkAwayNotice(for: prompt))
        }
    }

    /// The park is over without a session: its prompt, sheet, pin, and
    /// reporting all go.
    func forgetWaitingPark(parkedEventId: String) {
        guard reporter.waiting?.response.parkedEventId == parkedEventId else { return }
        if pendingParked?.parkedEventId == parkedEventId { pendingParked = nil }
        ParkedNotice.withdraw()
        if activeSession == nil {
            reporter.stop()
            carCoordinate = nil
            distanceFromCarMeters = nil
        } else {
            reporter.setWaiting(nil)
        }
    }

    private func sessionEndedAtReturn(_ ended: LocationResponse.Ended) async {
        if !ended.stopped, let error = ended.error {
            // The provider didn't stop it: still running, and Stop in the
            // app still works. Nothing more is bought for it.
            sessionActionError = error == "executor_failed" ? .executorFailed(code: nil) : .refused(code: error)
            return
        }
        if let session = activeSession {
            await ParkedNotice.postSessionEnded(ParkedNotice.sessionEndedContent(
                zoneNumber: session.zoneNumber, stopped: ended.stopped, paidUntil: session.expiresAt,
                why: ended.why, readBy: ended.readBy
            ))
        }
        reporter.stop()
        activeSession = nil
        carCoordinate = nil
        distanceFromCarMeters = nil
        Task { await wallet.load(api: api) }
    }

    /// The answer names a running session this phone doesn't hold while a
    /// park waits: the reply that said `started` was lost, or a start that
    /// ran out of time here went through late (#226). Read the session
    /// from the server's own record and show it (with Stop). The waiting
    /// park goes once the server has no open park left (it became this
    /// session, or the session covers it). Nothing to read yet: the next
    /// answer tries again.
    private func adoptRunningSession(
        _ adopt: LostStart.Adoption,
        waiting: ParkedNotice.Waiting,
        activity: () async throws -> ActivityPage
    ) async {
        guard let page = try? await activity(),
              var session = LostStart.session(adopt.sessionId, in: page, parked: waiting.response)
        else { return }
        // Read while it was being fetched (a stop, another answer).
        guard reporter.waiting?.response.parkedEventId == waiting.response.parkedEventId,
              activeSession?.sessionId != adopt.sessionId
        else { return }
        session.maxExtendCount = policyResponse?.policy.autoExtend.maxCount ?? session.maxExtendCount
        activeSession = session
        Task { await wallet.load(api: api) }
        if carCoordinate == nil { carCoordinate = waiting.coordinate }
        if adopt.parkClosed {
            if pendingParked?.parkedEventId == waiting.response.parkedEventId { pendingParked = nil }
            ParkedNotice.withdraw()
            // Keep reporting: the same fixes now tell the server when the
            // phone comes back.
            reporter.setWaiting(nil)
        }
    }

    // MARK: - The tap

    /// A session the server started for a waiting park (the tap, or the
    /// walk-away of an early tap).
    private func adoptSession(_ started: SessionStartResponse, parked: ParkedResponse, zoneId: String?) {
        let candidate = parked.candidates.first { $0.zoneId == zoneId } ?? parked.candidates.first
        let zoneNumber = candidate?.providerZoneNumber ?? ""
        activeSession = ActiveSession(
            sessionId: started.sessionId,
            zoneNumber: zoneNumber,
            zoneLabel: "Zone \(zoneNumber)",
            startedAt: AppClock.now,
            expiresAt: started.expiresAt,
            amountUsd: started.amountUsd,
            extendCount: 0,
            maxExtendCount: policyResponse?.policy.autoExtend.maxCount ?? 2,
            maxStayReached: false,
            paymentSource: wallet.activeSource == .parkagentCard ? .parkagentCard : .providerCard
        )
        Task { await wallet.load(api: api) }
        #if DEBUG
        // The mock has no fixes behind it; give the session screen a distance.
        distanceFromCarMeters = useMockAPI ? 120 : nil
        #else
        distanceFromCarMeters = nil
        #endif
        pendingParked = nil
        ParkedNotice.withdraw()
        if carCoordinate == nil { carCoordinate = reporter.waiting?.coordinate }
        // Keep reporting: the same fixes now tell the server when the
        // phone comes back.
        if reporter.isRunning {
            reporter.setWaiting(nil)
        } else {
            startLifecycleReporting(waiting: nil)
        }
    }

    /// Pay on the Parked sheet, for a park the server holds. At the car it
    /// is kept and paid at walk-away; away from it, it pays now.
    func confirmPark(candidate: Candidate) async {
        guard let parked = pendingParked, !isPaying else { return }
        isPaying = true
        paymentError = nil
        Haptics.light()
        defer { isPaying = false }
        do {
            let outcome = try await api.confirmPark(
                parkedEventId: parked.parkedEventId, zoneId: candidate.zoneId,
                shownTotalUsd: candidate.quote.totalUsd
            )
            switch outcome {
            case .started(let started):
                adoptSession(started, parked: parked, zoneId: candidate.zoneId)
                Haptics.success()
            case .waitingForWalkAway:
                // Nothing is paid at the car. The sheet closes; the park
                // keeps waiting, and Home says what will happen.
                await keepTappedPark(parked.parkedEventId)
                pendingParked = nil
                Haptics.success()
            case .freePeriod(let notice):
                freePeriodNotice = notice ?? "Meters here are free right now."
            }
        } catch {
            let failure = error as? APIError ?? .transport(error)
            paymentError = failure
            // The server asked again at the new price: fetch that prompt
            // now, so the sheet shows the amount the next tap will send.
            if case .refused(code: "quote_changed") = failure { await reporter.refresh() }
        }
    }

    /// The sheet's "Not parked here" / "Not now" for a park the server
    /// holds: the server is told, so it stops waiting on this phone.
    func declineWaitingPark(_ parked: ParkedResponse) async {
        try? await api.declinePark(parkedEventId: parked.parkedEventId)
        forgetWaitingPark(parkedEventId: parked.parkedEventId)
    }

    /// The passive card's tap on Home: open the sheet for the park that is
    /// waiting. Nothing opens it by itself before the walk-away.
    func reviewWaitingPark() {
        guard let waiting = reporter.waiting else { return }
        paymentError = nil
        pendingParked = waiting.presentable
    }

    /// A button on the walk-away notification, possibly with the app
    /// relaunched in the background for it.
    func handleWalkAwayTap(_ tap: PushManager.WalkAwayTap) async {
        switch tap.action {
        case .wrongSpot:
            // The app is opening: the sheet has the other side, and "not
            // parked here".
            selectedTab = .park
            if pendingParked == nil, let waiting = reporter.waiting ?? ParkedNotice.restoreWaiting(),
               waiting.response.parkedEventId == tap.parkedEventId {
                pendingParked = waiting.presentable
            }
        case .notNow:
            try? await api.declinePark(parkedEventId: tap.parkedEventId)
            forgetWaitingPark(parkedEventId: tap.parkedEventId)
            if pendingParked?.parkedEventId == tap.parkedEventId { pendingParked = nil }
        case .pay:
            await payFromNotification(tap)
        }
    }

    /// A Pay the server kept for the walk-away: remembered with the park
    /// (in the reporter, or on disk when the tap relaunched the app without
    /// it), so an hour with no walk-away is said, not forgotten. A driver
    /// already walking when it's kept gets no new walking reading
    /// (CoreMotion reports changes): the walk they're on is told now, or the
    /// Pay would wait for a walk that already began (#226).
    func keepTappedPark(_ parkedEventId: String) async {
        let parkedAt: Date?
        if var waiting = reporter.waiting, waiting.response.parkedEventId == parkedEventId {
            waiting.confirmed = true
            reporter.setWaiting(waiting)
            parkedAt = waiting.parkedAt
        } else if var stored = ParkedNotice.restoreWaiting(), stored.response.parkedEventId == parkedEventId {
            stored.confirmed = true
            ParkedNotice.storeWaiting(stored)
            return
        } else {
            return
        }
        let walk = WalkAway.since(stop: detector.lastParkStopAt, parkedAt: parkedAt, newest: detector.lastConfidentMotion)
        if let walk = WalkAway.stillOn(walk, nearCarAt: reporter.lastNearCarAt, tappedAt: AppClock.now) {
            await reporter.note(.leftCar, at: walk.at)
        }
    }

    /// Pay on the notification, answered without a session: kept for the
    /// next walk-away (the phone was back near the car since it left), or
    /// free now. Nothing was paid and nothing failed, but iOS has already
    /// taken the notification away: say what happened.
    func notificationTapAnswered(_ outcome: ParkConfirmOutcome, tap: PushManager.WalkAwayTap) async {
        if case .waitingForWalkAway = outcome { await keepTappedPark(tap.parkedEventId) }
        guard let content = ParkedNotice.tapAnswerContent(
            outcome, zoneNumber: tap.zoneNumber, paysAtWalkAway: permissions.capabilities.paysAtWalkAway
        ) else { return }
        await ParkedNotice.postTapAnswer(content, parkedEventId: tap.parkedEventId)
    }

    private func payFromNotification(_ tap: PushManager.WalkAwayTap) async {
        guard !isPaying else { return }
        isPaying = true
        defer { isPaying = false }
        let waiting = reporter.waiting ?? ParkedNotice.restoreWaiting()
        do {
            let outcome = try await api.confirmPark(
                parkedEventId: tap.parkedEventId, zoneId: tap.zoneId, shownTotalUsd: tap.shownTotalUsd
            )
            guard case .started(let started) = outcome else {
                await notificationTapAnswered(outcome, tap: tap)
                return
            }
            if let waiting, waiting.response.parkedEventId == tap.parkedEventId {
                adoptSession(started, parked: waiting.presentable, zoneId: tap.zoneId)
            } else {
                // Relaunched without the park on disk: the session is real
                // all the same, and the next launch shows it.
                activeSession = ActiveSession(
                    sessionId: started.sessionId,
                    zoneNumber: tap.zoneNumber ?? "",
                    zoneLabel: "Zone \(tap.zoneNumber ?? "")",
                    startedAt: AppClock.now,
                    expiresAt: started.expiresAt,
                    amountUsd: started.amountUsd,
                    extendCount: 0,
                    maxExtendCount: policyResponse?.policy.autoExtend.maxCount ?? 2,
                    maxStayReached: false
                )
            }
        } catch {
            let failure = error as? APIError ?? .transport(error)
            paymentError = failure
            // The prompt is gone with the tap. A provider failure gets the
            // server's own push; anything else is said here.
            if case .executorFailed = failure { return }
            let content = ParkedNotice.payFailedContent(
                zoneNumber: tap.zoneNumber,
                message: failure.paymentOutcomeUnknown
                    ? failure.startFailureMessage
                    : (failure.errorDescription ?? "Nothing was paid.")
            )
            await ParkedNotice.postPayFailed(content, parkedEventId: tap.parkedEventId)
        }
    }

    #if DEBUG
    /// UI tests only (Home's test-only button, mock API): the phone is 90 m
    /// from the car, twice, the way two fixes show a walk-away.
    func simulateWalkAway() async {
        guard let car = carCoordinate else { return }
        for meters in [70.0, 95.0] {
            let fix = ParkFix(
                coordinate: CLLocationCoordinate2D(latitude: car.latitude + meters / 111_320, longitude: car.longitude),
                accuracy: 8, at: AppClock.now
            )
            await reporter.report(now: fix)
        }
    }
    #endif
}

/// The `started` reply that never arrived (#226): what the next answers
/// say instead, and the session they name, read from the server's own
/// record of it.
enum LostStart {
    struct Adoption: Equatable {
        var sessionId: String
        /// The server has no open park left for this phone: the waiting
        /// one became this session, or the session covers it.
        var parkClosed: Bool
    }

    /// The session to take up, if the answer names one this phone doesn't
    /// hold while `waiting` waits. A server that says which session a
    /// park became puts it on the park; one that doesn't answers a running
    /// session, and no park once none is open.
    static func sessionToAdopt(
        _ response: LocationResponse, waiting: ParkedNotice.Waiting, holding: String?
    ) -> Adoption? {
        let ours = response.park.map { $0.parkedEventId == waiting.response.parkedEventId } ?? false
        if ours, let park = response.park, park.status == "started",
           let sessionId = park.sessionId ?? response.sessionId, sessionId != holding {
            return Adoption(sessionId: sessionId, parkClosed: true)
        }
        guard let sessionId = response.sessionId, sessionId != holding else { return nil }
        // A park still open beside it keeps waiting, and is answered as
        // before.
        return Adoption(sessionId: sessionId, parkClosed: response.park == nil)
    }

    /// The running session, as the Activity feed has it.
    static func session(_ sessionId: String, in page: ActivityPage, parked: ParkedResponse) -> ActiveSession? {
        guard let item = page.items.first(where: { $0.kind == "session" && $0.sessionId == sessionId }),
              item.status == "active", let expiresAt = item.expiresAt
        else { return nil }
        let zoneNumber = item.zoneNumber ?? parked.candidates.first?.providerZoneNumber ?? ""
        return ActiveSession(
            sessionId: sessionId,
            zoneNumber: zoneNumber,
            zoneLabel: "Zone \(zoneNumber)",
            startedAt: item.startedAt ?? item.at,
            expiresAt: expiresAt,
            amountUsd: item.totalUsd ?? 0,
            extendCount: item.timeline?.filter { $0.kind == "extended" }.count ?? 0,
            maxExtendCount: 2,
            maxStayReached: false,
            paymentSource: item.paymentSource == PaymentSource.parkagentCard.rawValue ? .parkagentCard : .providerCard
        )
    }
}

/// Which walk is a walk away from a park (#226): the newest confident
/// reading, on foot out of the car, begun since that park's car stopped.
/// A walk to the trunk before getting back in, or one from before the
/// drive, would otherwise ride the first fresh fix at the car, and a Pay
/// tapped from the seat would start at once.
enum WalkAway {
    /// Without the detector's own stop (a park delivered later from the
    /// outbox, a relaunch): the car stopped no earlier than this before
    /// the park's time.
    static let stopSlack: TimeInterval = 60
    /// A stop the detector saw longer than this before the park's time was
    /// another park's.
    static let stopReach: TimeInterval = 15 * 60

    static func since(stop: Date?, parkedAt: Date?, newest: MotionSample?) -> MotionSample? {
        guard let walk = newest, walk.isWalkingAway else { return nil }
        guard let parkedAt else { return walk }
        let seen = stop.flatMap { stop in
            stop <= parkedAt.addingTimeInterval(stopSlack) && parkedAt.timeIntervalSince(stop) <= stopReach ? stop : nil
        }
        let stoppedAt = seen ?? parkedAt.addingTimeInterval(-stopSlack)
        return walk.at >= stoppedAt ? walk : nil
    }

    /// A kept tap only seeds the walk the driver is still on: one begun
    /// after the last fix that had the phone at the car, and lately. A walk
    /// to the trunk and back into the seat leaves the trunk walk as the
    /// newest confident reading (a phone in hand in a seat reads low or
    /// unknown), and a `left_car` sent on the seat's fix would start the
    /// session there: a fix at the car never pays (#226).
    static let keptWalkReach: TimeInterval = 2 * 60

    static func stillOn(_ walk: MotionSample?, nearCarAt: Date?, tappedAt: Date) -> MotionSample? {
        guard let walk, walk.at >= tappedAt.addingTimeInterval(-keptWalkReach) else { return nil }
        if let nearCarAt, nearCarAt >= walk.at { return nil }
        return walk
    }
}
