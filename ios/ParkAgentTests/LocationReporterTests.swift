import CoreLocation
import Foundation
import Testing

@testable import ParkAgent

/// The session's location reports are the extension worker's only view of
/// the driver. Walk the test route's 300 m away and back through the
/// reporter and check what reaches the server.
@MainActor
struct LocationReporterTests {
    @MainActor
    final class Clock {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
    }

    @MainActor
    final class Server {
        var reports: [LocationReport] = []
        var answer: APIError?
        /// What the server says back to a report it took.
        var reply = LocationResponse()
        func receive(_ report: LocationReport) throws -> LocationResponse {
            if let answer { throw answer }
            reports.append(report)
            return reply
        }
    }

    func route() throws -> RouteFixture {
        try RouteFixture.load(from: Bundle(for: BundleMarker.self))
    }

    func distance(_ report: LocationReport, from car: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: report.lat, longitude: report.lng)
            .distance(from: CLLocation(latitude: car.latitude, longitude: car.longitude))
    }

    @Test func theWalkAwayAndBackReachesTheServer() async throws {
        let route = try route()
        let spot = try #require(route.points(in: "park").first)
        let car = CLLocationCoordinate2D(latitude: spot.latitude, longitude: spot.longitude)
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: car)

        let start = clock.now
        let walk = route.points.filter { ["park", "walk_away", "far", "walk_back", "back"].contains($0.phase) }
        let t0 = try #require(walk.first).offset
        for point in walk {
            clock.now = start.addingTimeInterval(point.offset - t0)
            await reporter.handle(ParkFix(latitude: point.latitude, longitude: point.longitude, accuracy: 5, at: clock.now))
        }

        let distances = server.reports.map { distance($0, from: car) }
        #expect(server.reports.count >= 10, "Too few reports to see a walk: \(distances)")
        // Out to the far end of the walk…
        #expect((distances.max() ?? 0) > 270, "Never reported the far end: \(distances)")
        // …and back to the car.
        #expect((distances.last ?? .infinity) < 30, "Never reported the return: \(distances)")
        // The worker judges heading from consecutive reports: on the way
        // out every report is farther than the last.
        let farthest = distances.firstIndex(of: distances.max()!)!
        #expect(zip(distances[..<farthest], distances[1...farthest]).allSatisfy { $0 <= $1 + 1 })
        // Never faster than the throttle allows.
        let times = server.reports.map(\.ts)
        #expect(zip(times, times.dropFirst()).allSatisfy { $1.timeIntervalSince($0) >= LocationReporter.minInterval - 0.5 })
        reporter.stop()
    }

    @Test func standingStillStillReportsOnTheHeartbeat() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(server.reports.count == 1)
        // No new fixes (standing still, distance filter): nothing sooner…
        clock.now += 30
        await reporter.heartbeatDue()
        #expect(server.reports.count == 1)
        // …but a minute on, "still here", so the worker's view doesn't age out.
        let measured = server.reports[0].ts
        clock.now += 31
        await reporter.heartbeatDue()
        #expect(server.reports.count == 2)
        #expect(server.reports[1].ts == clock.now)
        // The same measurement, sent again: the server must be able to
        // tell, or one GPS jump would count as two fixes away from the car.
        #expect(server.reports[0].measuredAt == measured)
        #expect(server.reports[1].measuredAt == measured)
        reporter.stop()
    }

    @Test func theServerEndingTheSessionStopsTheReporter() async {
        let clock = Clock()
        let server = Server()
        server.answer = .refused(code: "no_active_session")
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        var ended = false
        reporter.onSessionEnded = { ended = true }
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(ended)
    }

    @Test func aNetworkBlipRetriesOnTheNextFix() async {
        let clock = Clock()
        let server = Server()
        server.answer = .transport(URLError(.notConnectedToInternet))
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(server.reports.isEmpty)
        server.answer = nil
        clock.now += 1
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(server.reports.count == 1, "A failed report must not count as sent")
        reporter.stop()
    }

    // MARK: - The street session lifecycle (FR-55)

    private func prompt(_ title: String = "Pay $3.65 for zone 417371?") -> ParkPrompt {
        ParkPrompt(
            kind: "confirm", parkedEventId: "pe1", title: title, body: "1 h 30 m · ends 3:31 PM",
            zoneId: "nyc-417371", zoneNumber: "417371", amountUsd: 3.65, minutes: 90, dryRun: true
        )
    }

    @Test func whatTheAppSawRidesOnAReportAtOnceAndOnlyOnce() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(server.reports.last?.event == nil)

        // On foot: reported now, with the freshest fix, not at the next heartbeat.
        clock.now += 3
        await reporter.note(.leftCar)
        #expect(server.reports.count == 2)
        #expect(server.reports.last?.event == "left_car")

        // Delivered: the next report carries nothing.
        clock.now += 61
        await reporter.heartbeatDue()
        #expect(server.reports.count == 3)
        #expect(server.reports.last?.event == nil)
        reporter.stop()
    }

    @Test func anEventSeenBeforeAnyFixWaitsForTheFirstOne() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.note(.leftCar)
        #expect(server.reports.isEmpty, "There is no fix to send it with yet")
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(server.reports.map(\.event) == ["left_car"])
        reporter.stop()
    }

    @Test func anEventThatDidNotGetOutIsSentAgain() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        server.answer = .transport(URLError(.networkConnectionLost))
        await reporter.note(.returnedToCar)
        #expect(server.reports.count == 1)
        server.answer = nil
        clock.now += 20
        await reporter.handle(ParkFix(latitude: 42.3503, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(server.reports.last?.event == "returned_to_car")
        reporter.stop()
    }

    @Test func theServersAnswerIsHandedOn() async {
        let clock = Clock()
        let server = Server()
        let asked = prompt()
        server.reply = LocationResponse(park: .init(parkedEventId: "pe1", status: "prompted"), prompt: asked)
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        var answers: [LocationResponse] = []
        reporter.onResponse = { answers.append($0) }
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(ParkFix(latitude: 42.35, longitude: -71.07, accuracy: 5, at: clock.now))
        #expect(answers.count == 1)
        #expect(answers.first?.prompt == asked)
        #expect(answers.first?.park?.status == "prompted")
        reporter.stop()
    }

    // MARK: - Walk-away and drive-off (#226)

    /// A park held at the car, parked at `parkedAt`.
    private func waitingPark(parkedAt: Date, id: String = "pe1") -> ParkedNotice.Waiting {
        var held = MockFixtures.singleQuote()
        held.parkedEventId = id
        held.awaitsWalkAway = true
        var waiting = ParkedNotice.Waiting(
            response: held, latitude: 42.35, longitude: -71.07, savedAt: parkedAt, shown: nil
        )
        waiting.parkedAt = parkedAt
        return waiting
    }

    /// `meters` north of the car at 42.35, -71.07.
    private func fix(_ meters: Double, at: Date, accuracy: Double = 6, speed: Double? = nil) -> ParkFix {
        ParkFix(latitude: 42.35 + meters / 111_320, longitude: -71.07, accuracy: accuracy, at: at, speed: speed)
    }

    @Test func everyFixCarriesItsSpeedOrSaysItHasNone() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(fix(0, at: clock.now, speed: 1.4))
        clock.now += 61
        await reporter.handle(fix(1, at: clock.now))
        #expect(server.reports.map(\.speedMps) == [1.4, nil])
        reporter.stop()
    }

    /// CoreLocation's first fix after a start is often a cached one from
    /// before the park. The server reads nothing measured before the park,
    /// so a `left_car` sent with it was lost, and CoreMotion never says
    /// "walking" twice.
    @Test func aLeftCarWhoseFixPredatesTheParkWaitsForAFreshOne() async {
        let clock = Clock()
        let server = Server()
        server.reply = LocationResponse(park: .init(parkedEventId: "pe1", status: "at_car"))
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        let parkedAt = clock.now
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil, waiting: waitingPark(parkedAt: parkedAt))
        // The cached fix: two minutes older than the park.
        await reporter.handle(fix(0, at: parkedAt.addingTimeInterval(-120)))
        #expect(server.reports.count == 1)

        clock.now += 2
        await reporter.note(.leftCar)
        #expect(server.reports.allSatisfy { $0.event == nil }, "Sent with a fix the server reads as nothing")

        // The first fix since the park takes it, without waiting for the
        // usual cadence.
        clock.now += 3
        server.reply = LocationResponse(park: .init(parkedEventId: "pe1", status: "prompted"))
        await reporter.handle(fix(12, at: clock.now, speed: 1.3))
        let carried = server.reports.filter { $0.event == "left_car" }
        #expect(carried.count == 1)
        #expect((carried.first?.measuredAt ?? .distantPast) >= parkedAt)
        reporter.stop()
    }

    /// At the car's door with a sharp fix the server keeps the park at the
    /// car: the walk-away is said again with the next fix, until the
    /// server's answer shows it took it.
    @Test func aLeftCarTheServerDidNotTakeIsSaidAgain() async {
        let clock = Clock()
        let server = Server()
        server.reply = LocationResponse(park: .init(parkedEventId: "pe1", status: "confirmed"))
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil, waiting: waitingPark(parkedAt: clock.now))
        clock.now += 1
        await reporter.handle(fix(4, at: clock.now))
        await reporter.note(.leftCar)
        #expect(server.reports.last?.event == "left_car")

        // Still "confirmed": not taken. Said again with the next fix.
        clock.now += 16
        server.reply = LocationResponse(park: .init(parkedEventId: "pe1", status: "starting"))
        await reporter.handle(fix(18, at: clock.now, speed: 1.4))
        #expect(server.reports.filter { $0.event == "left_car" }.count == 2)

        // Taken: the next report carries nothing.
        clock.now += 61
        await reporter.heartbeatDue()
        #expect(server.reports.last?.event == nil)
        reporter.stop()
    }

    /// A walk to the trunk, then back in the car: once motion no longer
    /// has the driver on foot, a `left_car` not yet taken is dropped.
    @Test func aLeftCarIsDroppedOnceMotionNoLongerHasTheDriverOnFoot() async {
        let clock = Clock()
        let server = Server()
        server.reply = LocationResponse(park: .init(parkedEventId: "pe1", status: "confirmed"))
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        var onFoot = true
        reporter.stillOnFoot = { onFoot }
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil, waiting: waitingPark(parkedAt: clock.now))
        clock.now += 1
        await reporter.handle(fix(3, at: clock.now))
        await reporter.note(.leftCar)
        #expect(server.reports.last?.event == "left_car")

        onFoot = false
        clock.now += 20
        await reporter.handle(fix(40, at: clock.now))
        #expect(server.reports.count == 3)
        #expect(server.reports.last?.event == nil, "A red light 40 m on is not a walk-away")
        reporter.stop()
    }

    @Test func aLeftCarNeverRidesOnAFixAtDrivingSpeed() async {
        let clock = Clock()
        let server = Server()
        server.reply = LocationResponse(park: .init(parkedEventId: "pe1", status: "confirmed"))
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil, waiting: waitingPark(parkedAt: clock.now))
        clock.now += 1
        await reporter.handle(fix(30, at: clock.now, speed: 9))
        await reporter.note(.leftCar)
        clock.now += 20
        await reporter.handle(fix(200, at: clock.now, speed: 11))
        #expect(server.reports.allSatisfy { $0.event == nil })
        // Walking pace again: now it goes.
        clock.now += 20
        await reporter.handle(fix(210, at: clock.now, speed: 1.2))
        #expect(server.reports.last?.event == "left_car")
        reporter.stop()
    }

    /// Back in the car and driving off within the minute: by the time
    /// CoreMotion says "automotive" the latest fix is down the street. The
    /// report goes with the fix from when the drive began, at the car.
    @Test func returnedToCarGoesWithTheFixFromWhenTheDriveBegan() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        let atCar = clock.now
        await reporter.handle(fix(5, at: atCar, accuracy: 8))
        clock.now += 20
        await reporter.handle(fix(90, at: clock.now, accuracy: 10, speed: 8))
        clock.now += 20
        await reporter.handle(fix(240, at: clock.now, accuracy: 10, speed: 12))
        await reporter.note(.returnedToCar, at: atCar.addingTimeInterval(2))
        let report = server.reports.last
        #expect(report?.event == "returned_to_car")
        #expect(report.map { distance($0, from: CLLocationCoordinate2D(latitude: 42.35, longitude: -71.07)) } ?? .infinity < 10)
        #expect(report?.measuredAt == atCar)
        reporter.stop()
    }

    /// A blurry fix is all there is (CarPlay connecting in a garage): it
    /// goes at once, and the server judges it.
    @Test func returnedToCarGoesAtOnceWithAPoorFix() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(fix(10, at: clock.now, accuracy: 140))
        clock.now += 3
        await reporter.note(.returnedToCar)
        #expect(server.reports.count == 2)
        #expect(server.reports.last?.event == "returned_to_car")
        #expect(server.reports.last?.accuracy == 140)
        reporter.stop()
    }

    // MARK: - Review of #231 (#226)

    /// A drive's start reaches the app a minute or two late, and the fix
    /// from around then can be older than the server reads. That return
    /// went once and was gone; it's said again with the next fix the
    /// server can read.
    @Test func aReturnSentWithAFixTooOldToReadIsSaidAgain() async {
        let clock = Clock()
        let server = Server()
        server.reply = LocationResponse(sessionId: "s1")
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        let atCar = clock.now
        await reporter.handle(fix(4, at: atCar))
        // Six minutes on, CoreMotion's drive (dated from its start) arrives.
        clock.now += 6 * 60
        await reporter.note(.returnedToCar, at: atCar)
        #expect(server.reports.last?.event == "returned_to_car")
        #expect(server.reports.last?.measuredAt == atCar)

        clock.now += 20
        await reporter.handle(fix(60, at: clock.now, speed: 9))
        #expect(server.reports.last?.event == "returned_to_car", "A return the server couldn't read was dropped")
        #expect(server.reports.last?.measuredAt == clock.now)

        // Read this time (a readable fix the server judged): done.
        clock.now += 61
        await reporter.heartbeatDue()
        #expect(server.reports.last?.event == nil)
        reporter.stop()
    }

    /// …but not once the answer ended the session.
    @Test func aReturnTheServerEndedOnIsNotSaidAgain() async {
        let clock = Clock()
        let server = Server()
        server.reply = LocationResponse(sessionId: "s1", ended: .init(reason: "returned", stopped: true))
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil)
        await reporter.handle(fix(4, at: clock.now, accuracy: 120))
        clock.now += 3
        await reporter.note(.returnedToCar)
        clock.now += 20
        await reporter.handle(fix(40, at: clock.now))
        #expect(server.reports.filter { $0.event == "returned_to_car" }.count == 1)
        reporter.stop()
    }

    /// CarPlay connects with a report in flight, and a wake tells an old
    /// walk: the walk used to replace the return, and go out on the fix at
    /// the car, where it can start a confirmed park as the car pulls away.
    @Test func aWalkToldMeanwhileDoesNotReplaceAReturnNotYetSaid() async {
        let clock = Clock()
        let server = Server()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        reporter.start(send: { try await server.receive($0) }, carCoordinate: nil, waiting: waitingPark(parkedAt: clock.now))
        // No fix yet: the return waits for one.
        await reporter.note(.returnedToCar)
        await reporter.note(.leftCar)
        clock.now += 1
        await reporter.handle(fix(3, at: clock.now))
        #expect(server.reports.map(\.event) == ["returned_to_car"])
        reporter.stop()
    }

    @Test func aWaitingParkIsKeptOnDiskAndDroppedWhenReportingStops() {
        let clock = Clock()
        let reporter = LocationReporter(now: { clock.now }, usesSystemLocation: false)
        var held = MockFixtures.singleQuote()
        held.awaitsWalkAway = true
        let waiting = ParkedNotice.Waiting(
            response: held, latitude: 42.35, longitude: -71.07, savedAt: AppClock.now, shown: nil
        )
        reporter.start(send: { _ in LocationResponse() }, carCoordinate: waiting.coordinate, waiting: waiting)
        #expect(reporter.waiting?.response.parkedEventId == held.parkedEventId)
        // A relaunch between the park and the walk-away finds it again.
        #expect(ParkedNotice.restoreWaiting()?.response.parkedEventId == held.parkedEventId)
        reporter.stop()
        #expect(reporter.waiting == nil)
        #expect(ParkedNotice.restoreWaiting() == nil)
    }
}

/// Finds the unit-test bundle (its resources hold the route and traces).
final class BundleMarker {}
