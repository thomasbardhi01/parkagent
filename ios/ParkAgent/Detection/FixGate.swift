import CoreLocation
import Foundation

/// One location fix as the detector sees it.
struct ParkFix: Codable, Equatable, Sendable {
    var latitude: Double
    var longitude: Double
    /// Horizontal accuracy in meters; negative means invalid.
    var accuracy: Double
    /// When CoreLocation measured it (not when it was delivered).
    var at: Date
    /// Meters per second; nil when CoreLocation had no valid speed.
    var speed: Double?

    init(latitude: Double, longitude: Double, accuracy: Double, at: Date, speed: Double? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.accuracy = accuracy
        self.at = at
        self.speed = speed
    }

    init(coordinate: CLLocationCoordinate2D, accuracy: Double, at: Date, speed: Double? = nil) {
        self.init(latitude: coordinate.latitude, longitude: coordinate.longitude, accuracy: accuracy, at: at, speed: speed)
    }

    init(_ location: CLLocation) {
        self.init(
            coordinate: location.coordinate,
            accuracy: location.horizontalAccuracy,
            at: location.timestamp,
            speed: location.speed >= 0 ? location.speed : nil
        )
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    func distance(to other: ParkFix) -> Double {
        CLLocation(latitude: latitude, longitude: longitude)
            .distance(from: CLLocation(latitude: other.latitude, longitude: other.longitude))
    }
}

/// Which fixes are good enough to say where a car is. A park is paid at
/// the zone its fix resolves to, and the server widens its search to the
/// fix's accuracy, so a blurred or stale fix can price the wrong block.
///
/// - Accuracy: worse than `maxAccuracyM` is out. That also rejects every
///   fix iOS blurs when Precise Location is off (kilometers wide).
/// - Age: a fix measured more than `maxAgeS` before it arrived is a cached
///   one from somewhere else.
/// - Outliers: a jump from the last accepted fix faster than
///   `maxImpliedSpeedMps` (after allowing both fixes' error) is multipath
///   or a Wi-Fi fix from across town, not the car moving.
struct FixGate: Sendable {
    struct Config: Sendable {
        var maxAccuracyM: Double = 50
        var maxAgeS: TimeInterval = 15
        var maxImpliedSpeedMps: Double = 70
    }

    enum Reason: String, Sendable {
        case invalid, coarse, stale, outlier
    }

    enum Verdict: Equatable, Sendable {
        case accept
        case reject(Reason)
    }

    let config: Config
    private(set) var lastAccepted: ParkFix?
    /// Fixes rejected as jumps. If several agree with each other, the jump
    /// was the anchor, not them (a bad first fix after a reset).
    private var suspects: [ParkFix] = []

    init(config: Config = Config()) {
        self.config = config
    }

    mutating func evaluate(_ fix: ParkFix, receivedAt: Date) -> Verdict {
        guard fix.accuracy > 0 else { return .reject(.invalid) }
        guard fix.accuracy <= config.maxAccuracyM else { return .reject(.coarse) }
        guard receivedAt.timeIntervalSince(fix.at) <= config.maxAgeS else { return .reject(.stale) }
        if let last = lastAccepted {
            let elapsed = max(1, fix.at.timeIntervalSince(last.at))
            let unexplained = max(0, fix.distance(to: last) - fix.accuracy - last.accuracy)
            if unexplained / elapsed > config.maxImpliedSpeedMps {
                suspects.append(fix)
                let agreeing = suspects.suffix(Self.reanchorCount)
                guard agreeing.count == Self.reanchorCount,
                      agreeing.allSatisfy({ $0.distance(to: fix) <= $0.accuracy + fix.accuracy })
                else { return .reject(.outlier) }
                // Three fixes agree with each other and not with the anchor:
                // the anchor was the outlier.
            }
        }
        suspects = []
        lastAccepted = fix
        return .accept
    }

    private static let reanchorCount = 3

    /// A stop's burst starts from a clean slate; the last fix of the drive
    /// says nothing about where the car rests.
    mutating func reset() {
        lastAccepted = nil
        suspects = []
    }
}
