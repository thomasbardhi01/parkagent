import CoreMotion
import Foundation

/// One barometer reading (CoreMotion's, or a replayed one).
struct AltitudeSample: Codable, Equatable, Sendable {
    var at: Date
    /// Meters up (negative: down) since the altimeter started.
    var relativeAltitudeM: Double
    /// Air pressure, kilopascals. A car door or window moves it for a
    /// moment without anyone changing level (ParkFusionEngine ignores it).
    var pressureKPa: Double
}

/// The barometer, for the place classifier's "went up or down a ramp".
/// Relative only: phones disagree by whole floors on absolute pressure,
/// but a change over a few minutes is reliable. It runs only in a stop's
/// window (ParkDetector starts it with the burst and stops it with the
/// burst) — never while idle or driving.
@MainActor
protocol AltimeterSource: AnyObject {
    var isAvailable: Bool { get }
    var isRunning: Bool { get }
    func start(_ handler: @escaping @MainActor (AltitudeSample) -> Void)
    func stop()
}

@MainActor
final class CoreMotionAltimeter: AltimeterSource {
    private let altimeter = CMAltimeter()
    private(set) var isRunning = false

    /// Only on a phone with a barometer, and only once motion access is
    /// granted: starting it while "not asked" would pop the Motion &
    /// Fitness prompt from the detector instead of onboarding.
    var isAvailable: Bool {
        CMAltimeter.isRelativeAltitudeAvailable() && CMAltimeter.authorizationStatus() == .authorized
    }

    func start(_ handler: @escaping @MainActor (AltitudeSample) -> Void) {
        guard !isRunning, isAvailable else { return }
        isRunning = true
        altimeter.startRelativeAltitudeUpdates(to: .main) { data, _ in
            guard let data else { return }
            // `timestamp` is seconds since boot.
            let at = Date(timeIntervalSinceNow: data.timestamp - ProcessInfo.processInfo.systemUptime)
            let sample = AltitudeSample(
                at: at,
                relativeAltitudeM: data.relativeAltitude.doubleValue,
                pressureKPa: data.pressure.doubleValue
            )
            MainActor.assumeIsolated { handler(sample) }
        }
    }

    func stop() {
        guard isRunning else { return }
        altimeter.stopRelativeAltitudeUpdates()
        isRunning = false
    }
}
