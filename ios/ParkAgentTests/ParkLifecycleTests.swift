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
    func waitingPark(id: String = "pe1") -> ParkedNotice.Waiting {
        var held = MockFixtures.singleQuote(zoneNumber: "417371")
        held.parkedEventId = id
        held.awaitsWalkAway = true
        var waiting = ParkedNotice.Waiting(
            response: held, latitude: 40.7784, longitude: -73.9819, savedAt: AppClock.now, shown: nil
        )
        waiting.parkedAt = AppClock.now
        waiting.confirmed = true
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
