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
        let waiting = ParkedNotice.Waiting(
            response: response, latitude: coordinate.latitude, longitude: coordinate.longitude,
            savedAt: AppClock.now, shown: nil
        )
        startLifecycleReporting(waiting: waiting)
        // Already on foot when the park was detected (walking away is one
        // of the ways a park is confirmed): CoreMotion won't say so again.
        let walked = request.signals.contains(RawDetectorSignal.motionWalking.rawValue)
            || (detector.lastOnFootAt ?? .distantPast) >= request.ts
        if walked { await reporter.note(.leftCar) }
    }

    /// Wire the reporter for the lifecycle and start it. A session already
    /// running keeps reporting; the waiting park rides along until the
    /// server says what became of it.
    private func startLifecycleReporting(waiting: ParkedNotice.Waiting?) {
        reporter.onResponse = { [weak self] response in
            await self?.handleLocationResponse(response)
        }
        reporter.start(api: api, carCoordinate: carCoordinate, waiting: waiting)
    }

    /// Launch, or detection re-armed: pick a waiting park back up. iOS
    /// ends a backgrounded app between the park and the walk-away all the
    /// time; the relaunch for the next location event lands here.
    func resumeParkLifecycle() {
        reporter.onResponse = { [weak self] response in
            await self?.handleLocationResponse(response)
        }
        detector.onWalking = { [weak self] in
            Task { await self?.phoneLeftCar() }
        }
        detector.onCarPlayConnected = { [weak self] in
            Task { await self?.phoneReturnedToCar() }
        }
        PushManager.shared.onWalkAwayAction = { [weak self] tap in
            await self?.handleWalkAwayTap(tap)
        }
        guard activeSession == nil, !reporter.isRunning, let waiting = ParkedNotice.restoreWaiting() else { return }
        carCoordinate = waiting.coordinate
        startLifecycleReporting(waiting: waiting)
    }

    /// Motion has the driver on foot. Only a park still waiting at the car
    /// cares; the server weighs it against the fix that goes with it.
    func phoneLeftCar() async {
        guard reporter.waiting != nil, activeSession == nil else { return }
        await reporter.note(.leftCar)
    }

    /// Driving again, or CarPlay back: the phone is in the car. The server
    /// ends the session (or drops the unpaid park) only when the fix that
    /// goes with it is at the car.
    func phoneReturnedToCar() async {
        guard reporter.isRunning else { return }
        await reporter.note(.returnedToCar)
    }

    // MARK: - The server's answer to a fix

    func handleLocationResponse(_ response: LocationResponse) async {
        if let ended = response.ended {
            sessionEndedAtReturn(ended)
            return
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
            reporter.setWaiting(waiting)
            await present(prompt, for: waiting)
        default:
            // Cancelled (back at the car unpaid, or drove off), free now,
            // expired, failed: nothing left to ask or pay.
            forgetWaitingPark(parkedEventId: park.parkedEventId)
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

    private func sessionEndedAtReturn(_ ended: LocationResponse.Ended) {
        if !ended.stopped, let error = ended.error {
            // The provider didn't stop it: still running, and Stop in the
            // app still works. Nothing more is bought for it.
            sessionActionError = error == "executor_failed" ? .executorFailed(code: nil) : .refused(code: error)
            return
        }
        reporter.stop()
        activeSession = nil
        carCoordinate = nil
        distanceFromCarMeters = nil
        Task { await wallet.load(api: api) }
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
                pendingParked = nil
                Haptics.success()
            case .freePeriod(let notice):
                freePeriodNotice = notice ?? "Meters here are free right now."
            }
        } catch {
            paymentError = error as? APIError ?? .transport(error)
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
                // Kept for the next walk-away (the phone is back at the
                // car), or free now: nothing was paid, nothing failed.
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
