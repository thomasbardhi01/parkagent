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
        func receive(_ report: LocationReport) throws {
            if let answer { throw answer }
            reports.append(report)
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
        clock.now += 31
        await reporter.heartbeatDue()
        #expect(server.reports.count == 2)
        #expect(server.reports[1].ts == clock.now)
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
}

/// Finds the unit-test bundle (its resources hold the route and traces).
final class BundleMarker {}
