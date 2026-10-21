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

        let said = try #require(ParkedNotice.tapAnswerContent(.waitingForWalkAway, zoneNumber: "417371"))
        #expect(said.body == "Kept. ParkAgent pays when you walk away.")
        #expect(said.title.contains("417371"))
        #expect(ParkedNotice.tapAnswerContent(.freePeriod(notice: nil), zoneNumber: "417371")?.body.contains("Nothing was paid") == true)
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
        model.keepTappedPark("pe1")
        #expect(ParkedNotice.restoreWaiting()?.confirmed == true)
        // Another park's tap changes nothing.
        ParkedNotice.storeWaiting(waitingPark(confirmed: false))
        model.keepTappedPark("pe-other")
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
}
