import CoreLocation
import Foundation
import Testing

@testable import ParkAgent

/// The app's half of the street session lifecycle (FR-55) when a reply is
/// lost: a Pay tapped at the car starts on a /location request, and that
/// request's answer is the only one that says `started` (#226). The next
/// answer names the session and no park; the app must take the session up
/// and show Stop, not keep the park "waiting".
@MainActor
struct ParkLifecycleTests {
    func waitingPark(id: String = "pe1", confirmed: Bool = true) -> ParkedNotice.Waiting {
        var held = MockFixtures.singleQuote(zoneNumber: "417371")
        held.parkedEventId = id
        held.awaitsWalkAway = true
        var waiting = ParkedNotice.Waiting(
            response: held, latitude: 40.7784, longitude: -73.9819, savedAt: AppClock.now, shown: nil
        )
        waiting.parkedAt = AppClock.now
        waiting.confirmed = confirmed
        return waiting
    }

    /// The Activity feed with the running session at its head.
    func activity(sessionId: String = "s9", status: String = "active") -> ActivityPage {
        let started = Date(timeIntervalSince1970: 1_800_000_000)
        var item = ActivityItem(id: "session:\(sessionId)", kind: "session", at: started, createdAt: started)
        item.sessionId = sessionId
        item.zoneNumber = "417371"
        item.status = status
        item.totalUsd = 3.65
        item.startedAt = started
        item.expiresAt = started.addingTimeInterval(90 * 60)
        item.paymentSource = "provider_card"
        return ActivityPage(items: [item], nextCursor: nil)
    }

    /// A model holding a park that waits for its walk-away, reporting.
    func modelWaiting(_ waiting: ParkedNotice.Waiting) -> AppModel {
        ActiveSession.store(nil)
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        model.reporter.start(send: { _ in LocationResponse() }, carCoordinate: waiting.coordinate, waiting: waiting)
        return model
    }

    func tearDown(_ model: AppModel) {
        model.reporter.stop()
        model.activeSession = nil
        ActiveSession.store(nil)
    }

    /// Today's server: the session, and no park (it isn't open any more).
    @Test func aLostStartedReplyIsTakenUpFromTheNextAnswer() async {
        let model = modelWaiting(waitingPark())
        defer { tearDown(model) }
        var reads = 0
        await model.handleLocationResponse(LocationResponse(sessionId: "s9")) {
            reads += 1
            return activity()
        }
        #expect(reads == 1)
        #expect(model.activeSession?.sessionId == "s9", "The session never reached the app: no Stop")
        #expect(model.activeSession?.zoneNumber == "417371")
        #expect(model.activeSession?.expiresAt == Date(timeIntervalSince1970: 1_800_000_000 + 90 * 60))
        #expect(model.activeSession?.amountUsd == 3.65)
        #expect(model.reporter.waiting == nil, "Still \"waiting\" for a park that started")
        #expect(model.reporter.isRunning, "The same fixes now tell the server when the phone comes back")
        #expect(ParkedNotice.restoreWaiting() == nil)
    }

    /// A server that says which session the park became.
    @Test func aStartedParkThatNamesItsSessionIsTakenUp() async {
        let model = modelWaiting(waitingPark())
        defer { tearDown(model) }
        let answer = LocationResponse(
            sessionId: "s9", park: .init(parkedEventId: "pe1", status: "started", sessionId: "s9")
        )
        await model.handleLocationResponse(answer) { activity() }
        #expect(model.activeSession?.sessionId == "s9")
        #expect(model.reporter.waiting == nil)
    }

    /// The record can't be read (offline): nothing changes, and the next
    /// answer tries again.
    @Test func nothingChangesUntilTheSessionCanBeRead() async {
        let model = modelWaiting(waitingPark())
        defer { tearDown(model) }
        await model.handleLocationResponse(LocationResponse(sessionId: "s9")) {
            throw APIError.transport(URLError(.notConnectedToInternet))
        }
        #expect(model.activeSession == nil)
        #expect(model.reporter.waiting?.response.parkedEventId == "pe1")

        // The feed doesn't have it running (it ended meanwhile): not shown.
        await model.handleLocationResponse(LocationResponse(sessionId: "s9")) { activity(status: "stopped") }
        #expect(model.activeSession == nil)

        await model.handleLocationResponse(LocationResponse(sessionId: "s9")) { activity() }
        #expect(model.activeSession?.sessionId == "s9")
        #expect(model.reporter.waiting == nil)
    }

    /// On foot during a running session: told to the server too, which
    /// clears its memory of the phone beside the car. Without it, a phone
    /// standing at a bus stop near the car (no valid speed) and then on a
    /// bus reads as the car driving off.
    @Test func aWalkDuringASessionIsToldToTheServer() async {
        ActiveSession.store(nil)
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        defer { tearDown(model) }
        var reports: [LocationReport] = []
        model.activeSession = ActiveSession(
            sessionId: "s9", zoneNumber: "417371", zoneLabel: "Zone 417371", startedAt: .now,
            expiresAt: .now.addingTimeInterval(3_600), amountUsd: 3.65, extendCount: 0,
            maxExtendCount: 2, maxStayReached: false
        )
        model.reporter.start(
            send: { reports.append($0); return LocationResponse(sessionId: "s9") },
            carCoordinate: CLLocationCoordinate2D(latitude: 40.7784, longitude: -73.9819)
        )
        await model.reporter.handle(ParkFix(latitude: 40.7786, longitude: -73.9819, accuracy: 6, at: .now))
        #expect(reports.count == 1)
        await model.phoneLeftCar(at: .now)
        #expect(reports.count == 2)
        #expect(reports.last?.event == "left_car")
    }

    /// Pay on the lock-screen notification, answered "kept for the walk-away"
    /// (the phone was back near the car since it left): iOS has already
    /// taken the notification away, so the tap is answered with a notice,
    /// and the park remembers the Pay, so an hour with no walk-away is said
    /// rather than forgotten.
    @Test func aPayKeptFromTheNotificationIsRememberedAndSaid() async throws {
        let model = modelWaiting(waitingPark(confirmed: false))
        defer { tearDown(model) }
        let tap = PushManager.WalkAwayTap(
            action: .pay, parkedEventId: "pe1", zoneId: "nyc-417371", zoneNumber: "417371", shownTotalUsd: 3.65
        )
        await model.notificationTapAnswered(.waitingForWalkAway, tap: tap)
        #expect(model.reporter.waiting?.confirmed == true)
        #expect(ParkedNotice.restoreWaiting()?.confirmed == true)

        let said = try #require(ParkedNotice.tapAnswerContent(.waitingForWalkAway, zoneNumber: "417371", paysAtWalkAway: true))
        #expect(said.body == "Kept. ParkAgent pays when you walk away.")
        #expect(said.title.contains("417371"))
        #expect(ParkedNotice.tapAnswerContent(.freePeriod(notice: nil), zoneNumber: "417371", paysAtWalkAway: true)?.body.contains("Nothing was paid") == true)
    }

    /// The tap relaunched the app in the background with the park only on
    /// disk: remembered there.
    @Test func aPayKeptWithTheParkOnlyOnDiskIsRememberedThere() async {
        ActiveSession.store(nil)
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        defer {
            tearDown(model)
            ParkedNotice.storeWaiting(nil)
        }
        ParkedNotice.storeWaiting(waitingPark(confirmed: false))
        #expect(model.reporter.waiting == nil)
        await model.keepTappedPark("pe1")
        #expect(ParkedNotice.restoreWaiting()?.confirmed == true)
        // Another park's tap changes nothing.
        ParkedNotice.storeWaiting(waitingPark(confirmed: false))
        await model.keepTappedPark("pe-other")
        #expect(ParkedNotice.restoreWaiting()?.confirmed == false)
    }

    /// A Pay kept at the car whose park is asked about again (it left by
    /// distance, not CoreMotion's walk): the kept Pay no longer stands, so
    /// an hour with no answer isn't said as a walk-away that never came.
    @Test func aParkAskedAgainForgetsTheKeptPay() async {
        let model = modelWaiting(waitingPark(confirmed: true))
        defer { tearDown(model) }
        let asked = ParkPrompt(
            kind: "confirm", parkedEventId: "pe1", title: "Pay $3.65 for zone 417371?", body: "1 h 30 m",
            zoneId: "nyc-417371", zoneNumber: "417371", amountUsd: 3.65, minutes: 90, dryRun: true
        )
        await model.handleLocationResponse(LocationResponse(park: .init(parkedEventId: "pe1", status: "prompted"), prompt: asked))
        #expect(model.reporter.waiting?.confirmed == false)
        #expect(model.reporter.waiting?.shown == asked)
        #expect(ParkedNotice.restoreWaiting()?.confirmed == false)
    }

    /// A session the app already shows is not read again.
    @Test func aSessionAlreadyHeldIsNotReadAgain() {
        let waiting = waitingPark()
        #expect(LostStart.sessionToAdopt(LocationResponse(sessionId: "s9"), waiting: waiting, holding: "s9") == nil)
        #expect(LostStart.sessionToAdopt(LocationResponse(), waiting: waiting, holding: nil) == nil)
    }

    /// A park still open beside a running session keeps waiting: the
    /// session is shown, and the park is answered as before.
    @Test func aParkStillOpenBesideTheSessionKeepsWaiting() {
        let waiting = waitingPark()
        let open = LocationResponse(sessionId: "s9", park: .init(parkedEventId: "pe1", status: "at_car"))
        #expect(LostStart.sessionToAdopt(open, waiting: waiting, holding: nil) == .init(sessionId: "s9", parkClosed: false))
        let gone = LocationResponse(sessionId: "s9")
        #expect(LostStart.sessionToAdopt(gone, waiting: waiting, holding: nil) == .init(sessionId: "s9", parkClosed: true))
        let other = LocationResponse(sessionId: "s9", park: .init(parkedEventId: "pe2", status: "started", sessionId: "s7"))
        #expect(LostStart.sessionToAdopt(other, waiting: waiting, holding: nil) == .init(sessionId: "s9", parkClosed: false))
    }

    // MARK: - Review of #231 (#226)

    /// A model holding a waiting park, reporting to `reports`, with one fix
    /// `metersFromCar` north of the car.
    func modelReporting(
        _ waiting: ParkedNotice.Waiting, metersFromCar: Double, accuracy: Double = 5, fixAt: Date = .now,
        into reports: @escaping (LocationReport) -> Void
    ) async -> AppModel {
        ActiveSession.store(nil)
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        model.reporter.start(
            send: { reports($0); return LocationResponse(park: .init(parkedEventId: "pe1", status: "at_car")) },
            carCoordinate: waiting.coordinate, waiting: waiting
        )
        let fix = ParkFix(
            latitude: waiting.latitude + metersFromCar / 111_320, longitude: waiting.longitude,
            accuracy: accuracy, at: fixAt
        )
        await model.reporter.handle(fix)
        return model
    }

    /// The car's audio coming back (CarPlay, or a route learned as the
    /// car's, which can be headphones) is a hint only, never the return by
    /// itself: for a park still waiting at the car the server takes
    /// `returned_to_car` as the car driving off, wherever the phone is.
    /// The drive CoreMotion then sees is the return.
    @Test func theCarsAudioComingBackSendsNothingByItself() async throws {
        var events: [String?] = []
        let model = await modelReporting(waitingPark(confirmed: false), metersFromCar: 60) { events.append($0.event) }
        defer { tearDown(model) }
        model.resumeParkLifecycle()
        model.detector.carAudio.remember("stereo")
        model.detector.carAudioConnected(.carPlay, uid: nil)
        model.detector.carAudioConnected(.bluetooth, uid: "stereo")
        for _ in 0..<20 { await Task.yield() }
        try await Task.sleep(for: .milliseconds(100))
        #expect(!events.contains("returned_to_car"))
        model.detector.carAudio.forget()
    }

    /// Pay kept while the driver is already walking: CoreMotion won't say
    /// "walking" again, so the walk they're on is told now, when it began
    /// after the last fix that had the phone at the car.
    @Test func aPayKeptWhileAlreadyWalkingIsTheWalkAway() async {
        var waiting = waitingPark(confirmed: false)
        waiting.parkedAt = Date.now.addingTimeInterval(-120)
        var events: [String?] = []
        let model = await modelReporting(waiting, metersFromCar: 5, fixAt: .now.addingTimeInterval(-60)) { events.append($0.event) }
        defer { tearDown(model) }
        model.detector.track(MotionSample(at: .now.addingTimeInterval(-30), walking: true), live: false)
        await model.keepTappedPark("pe1")
        #expect(events.last == "left_car")
    }

    /// Park, walk to the trunk, get back in the seat, tap Pay there: a
    /// phone in hand in a seat reads low or unknown, so the trunk walk is
    /// still the newest confident reading. The fix at the car since says
    /// that walk is over: nothing is told, and the seat's fix never pays.
    @Test func aPayKeptFromTheSeatAfterAWalkToTheTrunkIsNotTheWalkAway() async {
        var waiting = waitingPark(confirmed: false)
        waiting.parkedAt = Date.now.addingTimeInterval(-120)
        var events: [String?] = []
        let model = await modelReporting(waiting, metersFromCar: 5, fixAt: .now.addingTimeInterval(-10)) { events.append($0.event) }
        defer { tearDown(model) }
        model.detector.track(MotionSample(at: .now.addingTimeInterval(-60), walking: true), live: false)
        await model.keepTappedPark("pe1")
        #expect(!events.contains("left_car"))
        #expect(model.reporter.waiting?.confirmed == true, "The Pay is still kept")

        // A walk from long before the tap is not the one the driver is on.
        let parked = Date(timeIntervalSince1970: 1_800_000_000)
        let old = MotionSample(at: parked.addingTimeInterval(-200), walking: true)
        #expect(WalkAway.stillOn(old, nearCarAt: nil, tappedAt: parked) == nil)
        #expect(WalkAway.stillOn(old, nearCarAt: nil, tappedAt: parked.addingTimeInterval(-100)) != nil)
    }

    /// The only way back to the car now: CoreMotion's drive, through the
    /// engine's `motionDriving`, to `drivingResumed`, to `returned_to_car`.
    @Test func aDriveIsTheReturn() async throws {
        var events: [String?] = []
        let model = await modelReporting(waitingPark(confirmed: false), metersFromCar: 4) { events.append($0.event) }
        defer { tearDown(model) }
        // As AppModel.armDetection wires it.
        model.detector.onDrivingResumed = { [weak model] in model?.drivingResumed() }
        model.detector.engine.motion(MotionSample(at: .now, automotive: true))
        for _ in 0..<20 { await Task.yield() }
        try await Task.sleep(for: .milliseconds(100))
        #expect(events.last == "returned_to_car")
    }

    /// A walk turned down while a return was still to be said is told
    /// again at the next wake, not lost with that reading.
    @Test func aWalkTurnedDownForAPendingReturnIsToldAgain() async {
        ActiveSession.store(nil)
        let model = AppModel(authStore: AuthStore(credentials: InMemoryCredentialStore()))
        defer { tearDown(model) }
        let waiting = waitingPark(confirmed: true)
        model.reporter.start(send: { _ in LocationResponse() }, carCoordinate: waiting.coordinate, waiting: waiting)
        // No fix yet: the return waits, untried.
        await model.reporter.note(.returnedToCar)
        var told = 0
        model.detector.onWalking = { _ in told += 1 }
        let walk = MotionSample(at: .now, walking: true)
        model.detector.track(walk, live: true)
        #expect(told == 1)
        await model.phoneLeftCar(at: walk.at)
        model.detector.track(walk, live: true)
        #expect(told == 2, "The walk was turned down and never told again")
    }

    /// Which walk is a walk away from the park.
    @Test func onlyAWalkSinceTheCarStoppedIsAWalkAway() {
        let parked = Date(timeIntervalSince1970: 1_800_000_000)
        let walk = { (offset: TimeInterval) in MotionSample(at: parked.addingTimeInterval(offset), walking: true) }
        let stop = parked.addingTimeInterval(-20)
        #expect(WalkAway.since(stop: stop, parkedAt: parked, newest: walk(-10)) != nil)
        #expect(WalkAway.since(stop: stop, parkedAt: parked, newest: walk(-40)) == nil, "A walk to the trunk before the stop")
        // No stop seen: a minute before the park's time.
        #expect(WalkAway.since(stop: nil, parkedAt: parked, newest: walk(-50)) != nil)
        #expect(WalkAway.since(stop: nil, parkedAt: parked, newest: walk(-90)) == nil)
        // Another park's stop, long before: the minute rule instead.
        #expect(WalkAway.since(stop: parked.addingTimeInterval(-3_600), parkedAt: parked, newest: walk(-90)) == nil)
        #expect(WalkAway.since(stop: stop, parkedAt: parked, newest: MotionSample(at: parked, automotive: true)) == nil)
    }

    /// Without motion a Pay tapped at the car never starts on its own (no
    /// `left_car`); nothing may say it does.
    @Test func withoutMotionNothingPromisesToPayAtTheWalkAway() {
        var caps = DetectionCapabilities()
        caps.motion = .authorized
        #expect(caps.paysAtWalkAway)
        for motion in [DetectionCapabilities.Motion.denied, .restricted, .notDetermined, .unavailable] {
            caps.motion = motion
            #expect(!caps.paysAtWalkAway, "\(motion)")
        }
        #expect(ParkedNotice.walkAwayPromise(paysAtWalkAway: true) == "ParkAgent pays when you walk away.")
        #expect(ParkedNotice.walkAwayPromise(paysAtWalkAway: false) == "You'll be asked again when you walk away.")
        let kept = ParkedNotice.tapAnswerContent(.waitingForWalkAway, zoneNumber: "456", paysAtWalkAway: false)
        #expect(kept?.body == "Kept. You'll be asked again when you walk away.")
        #expect(ParkedNotice.payButtonTitle(totalUsd: 3.65, minutes: 90, heldAtCar: true, paysAtWalkAway: false)
            == "Pay $3.65 — you'll be asked again when you walk away")
        #expect(ParkedNotice.payButtonTitle(totalUsd: 3.65, minutes: 90, heldAtCar: true, paysAtWalkAway: true).hasPrefix("Pay $3.65 for"))
        #expect(ParkedNotice.payButtonTitle(totalUsd: 3.65, minutes: 90, heldAtCar: false, paysAtWalkAway: false).hasPrefix("Pay $3.65 for"))
        #expect(ParkedNotice.atCarNote(paysAtWalkAway: false).contains("Motion & Fitness"))
        #expect(!ParkedNotice.atCarNote(paysAtWalkAway: false).contains("pays when you walk away."))
        #expect(ParkedNotice.atCarNote(paysAtWalkAway: true).hasSuffix("ParkAgent pays when you walk away."))
        #expect(CapabilityIssue.motionDenied.consequence.contains("Pay tapped at the car is asked again"))
        #expect(CapabilityIssue.motionRestricted.consequence.contains("Pay tapped at the car is asked again"))
    }
}
