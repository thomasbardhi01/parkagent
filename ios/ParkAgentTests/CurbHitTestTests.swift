import CoreLocation
import XCTest
@testable import ParkAgent

/// The tapped-curb-line hit test. The regression this pins: selection used
/// the nearest VERTEX, and a simplified block has vertices only at its ends,
/// so tapping the middle of a long NYC block selected nothing.
final class CurbHitTestTests: XCTestCase {
    /// A straight ~150 m block face along a Manhattan avenue: two vertices,
    /// exactly what ST_Simplify leaves of a straight curb.
    private static let longBlock = zone(
        "nyc-long",
        [[-73.9818, 40.7784], [-73.9808, 40.7797]]
    )
    /// A parallel block ~60 m east — close, but not the one tapped.
    private static let neighbour = zone(
        "nyc-neighbour",
        [[-73.9811, 40.7784], [-73.9801, 40.7797]]
    )

    private static func zone(_ id: String, _ coordinates: [[Double]]) -> NearbyZone {
        NearbyZone(
            zoneId: id,
            city: "nyc",
            providerZoneNumber: "",
            street: nil,
            rateFirstHourUsd: 5,
            rateAdditionalHourUsd: 8.25,
            maxStayMinutes: nil,
            distanceM: 0,
            enforcedNow: true,
            todayHours: [],
            hours: [],
            centerline: [coordinates]
        )
    }

    private static let midpoint = CLLocationCoordinate2D(latitude: 40.77905, longitude: -73.9813)

    func testTheMiddleOfALongBlockSelectsIt() {
        // Both ends are ~80 m away, far outside the tolerance — a vertex
        // test finds nothing here.
        let ends = Self.longBlock.polylines[0]
        for end in ends {
            let metres = CLLocation(latitude: end.latitude, longitude: end.longitude)
                .distance(from: CLLocation(latitude: Self.midpoint.latitude, longitude: Self.midpoint.longitude))
            XCTAssertGreaterThan(metres, 60, "fixture: the tap must be far from both vertices")
        }
        let hit = CurbHitTest.nearestZone(to: Self.midpoint, in: [Self.longBlock], toleranceM: 27)
        XCTAssertEqual(hit?.zoneId, "nyc-long")
    }

    func testTheCloserOfTwoParallelBlocksWins() {
        let hit = CurbHitTest.nearestZone(
            to: Self.midpoint,
            in: [Self.neighbour, Self.longBlock],
            toleranceM: 80
        )
        XCTAssertEqual(hit?.zoneId, "nyc-long")
    }

    func testATapOffTheEndOfALineIsMeasuredToTheEndpoint() {
        // 30 m past the northern end, on the line's own bearing: the clamp
        // must measure to the endpoint, not the infinite line.
        let past = CLLocationCoordinate2D(latitude: 40.77992, longitude: -73.98062)
        let metres = CurbHitTest.distanceM(from: past, to: Self.longBlock.polylines[0])
        XCTAssertEqual(metres, 29, accuracy: 3)
        XCTAssertNil(CurbHitTest.nearestZone(to: past, in: [Self.longBlock], toleranceM: 20))
    }

    func testNothingNearbySelectsNothing() {
        let far = CLLocationCoordinate2D(latitude: 40.7900, longitude: -73.9700)
        XCTAssertNil(CurbHitTest.nearestZone(to: far, in: [Self.longBlock, Self.neighbour], toleranceM: 27))
    }
}
