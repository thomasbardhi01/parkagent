// UI tests only; compiled out of Release like the rest of the mock.
#if DEBUG
import CoreLocation
import Foundation
import Observation

/// What the mock server heard from the real detector and reporter, for the
/// detector UI test to read off a probe label: how many parks were
/// reported, and how far the /location fixes got from the car. That is
/// the extension worker's whole view of "walked away" — the server's own
/// test (extendTick route test) turns the same walk into a decision.
@MainActor
@Observable
final class MockDetectorProbe {
    static let shared = MockDetectorProbe()

    private(set) var parkedCount = 0
    private(set) var car: CLLocationCoordinate2D?
    private(set) var reportCount = 0
    private(set) var farthestM: Double = 0
    private(set) var lastM: Double = 0

    func parked(_ request: ParkedRequest) {
        parkedCount += 1
        car = CLLocationCoordinate2D(latitude: request.lat, longitude: request.lng)
    }

    func located(_ report: LocationReport) {
        reportCount += 1
        guard let car else { return }
        let meters = CLLocation(latitude: report.lat, longitude: report.lng)
            .distance(from: CLLocation(latitude: car.latitude, longitude: car.longitude))
        lastM = meters
        farthestM = max(farthestM, meters)
    }

    /// "parked=1 reports=7 farthest=298 last=12"
    var summary: String {
        "parked=\(parkedCount) reports=\(reportCount) farthest=\(Int(farthestM.rounded())) last=\(Int(lastM.rounded()))"
    }
}
#endif
