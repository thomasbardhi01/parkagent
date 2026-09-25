import CoreLocation
import Foundation

/// One raw detector observation, as fed to the fusion engine and (when the
/// Diagnostics switch is on) written to the on-device signal log.
enum RawDetectorSignal: String {
    case motionDriving = "motion_driving"
    case motionStop = "motion_stop"
    case audioDisconnect = "audio_disconnect"
    case fix = "location_fix"
    case locationSettled = "location_settled"
    case parkFired = "park_fired"
    case debounced = "debounced"
    case drivingResumedCleared = "driving_resumed_cleared"
}

struct ParkFix {
    var coordinate: CLLocationCoordinate2D
    var accuracy: Double
    var at: Date
}

/// The three-signal park fusion, free of every system framework so it can
/// run under injected fake sources in unit tests:
///
/// 1. Motion: the transition out of automotive into stationary/walking.
/// 2. Audio: the car's CarPlay/Bluetooth audio route going away.
/// 3. Location settling: after either of the other signals starts a burst
///    of high-accuracy fixes, the last `settleFixCount` fixes staying
///    within `settleRadiusM` of each other — the resting car coordinate.
///
/// A park fires when any two of the three land within `agreementWindow` of
/// each other, at most once per `debounce`; driving resuming clears every
/// pending signal, so a red light or drive-through never leaves a stale
/// half-agreement behind.
@MainActor
final class ParkFusionEngine {
    struct Config {
        var agreementWindow: TimeInterval = 60
        var debounce: TimeInterval = 3 * 60
        var settleFixCount = 3
        var settleRadiusM: Double = 20
        /// Give up on a burst that never settles (bad GPS) this long after
        /// the last pending signal, so the radio isn't held open forever.
        var burstTimeout: TimeInterval = 90
    }

    let config: Config
    private let now: @MainActor () -> Date

    /// Fires with the resting fix and the agreeing signal names for /parked.
    var onPark: ((ParkFix, [String]) -> Void)?
    /// The wrapper starts/stops the high-accuracy location burst.
    var onStartBurst: (() -> Void)?
    var onStopBurst: (() -> Void)?
    /// Every raw observation, timestamped — the Debug signal log.
    var onRawSignal: ((RawDetectorSignal, Date, String?) -> Void)?

    private var wasDriving = false
    private var lastMotionStop: Date?
    private var lastAudioDisconnect: Date?
    private var settled: ParkFix?
    private var burstFixes: [ParkFix] = []
    private var burstActive = false
    private var lastFired: Date?

    init(config: Config = Config(), now: @escaping @MainActor () -> Date = { Date() }) {
        self.config = config
        self.now = now
    }

    // MARK: - Signal inputs

    func motionEvent(driving: Bool, stopped: Bool) {
        let at = now()
        if driving {
            if !wasDriving {
                emit(.motionDriving, at)
                // Back on the road: whatever was accumulating toward a park
                // (a red light, a drive-through window) is void.
                if hasPendingSignals {
                    clearPending()
                    emit(.drivingResumedCleared, at)
                }
            }
            wasDriving = true
            return
        }
        // Only the transition out of driving counts, not standing still at
        // a desk all day.
        guard wasDriving, stopped else { return }
        wasDriving = false
        lastMotionStop = at
        emit(.motionStop, at)
        startBurst()
        evaluate(at)
    }

    func audioDisconnected() {
        let at = now()
        lastAudioDisconnect = at
        emit(.audioDisconnect, at)
        startBurst()
        evaluate(at)
    }

    func fixReceived(_ fix: ParkFix) {
        emit(.fix, fix.at, String(format: "±%.0fm", fix.accuracy))
        guard burstActive else { return }
        burstFixes.append(fix)
        if settled == nil, let resting = settledFix() {
            settled = resting
            emit(.locationSettled, resting.at, String(format: "±%.0fm", resting.accuracy))
        }
        let at = now()
        if burstShouldStop(at) { stopBurst() }
        evaluate(at)
    }

    // MARK: - Fusion

    private var hasPendingSignals: Bool {
        lastMotionStop != nil || lastAudioDisconnect != nil || settled != nil
    }

    private func clearPending() {
        lastMotionStop = nil
        lastAudioDisconnect = nil
        settled = nil
        burstFixes = []
        stopBurst()
    }

    private func startBurst() {
        guard !burstActive else { return }
        burstActive = true
        burstFixes = []
        onStartBurst?()
    }

    private func stopBurst() {
        guard burstActive else { return }
        burstActive = false
        onStopBurst?()
    }

    /// Settled = the last `settleFixCount` burst fixes all inside
    /// `settleRadiusM` of the newest one; the resting coordinate is the
    /// most accurate of that window.
    private func settledFix() -> ParkFix? {
        guard burstFixes.count >= config.settleFixCount else { return nil }
        let window = burstFixes.suffix(config.settleFixCount)
        let anchor = window.last!
        let anchorLoc = CLLocation(
            latitude: anchor.coordinate.latitude,
            longitude: anchor.coordinate.longitude
        )
        let allNear = window.allSatisfy { fix in
            CLLocation(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude)
                .distance(from: anchorLoc) <= config.settleRadiusM
        }
        guard allNear else { return nil }
        return window.min { $0.accuracy < $1.accuracy }
    }

    private func burstShouldStop(_ at: Date) -> Bool {
        if settled != nil { return true }
        let newestSignal = [lastMotionStop, lastAudioDisconnect].compactMap { $0 }.max()
        guard let newestSignal else { return true }
        return at.timeIntervalSince(newestSignal) > config.burstTimeout
    }

    private func evaluate(_ at: Date) {
        if let lastFired, at.timeIntervalSince(lastFired) < config.debounce {
            emit(.debounced, at)
            return
        }

        var signals: [String] = []
        if let lastMotionStop, at.timeIntervalSince(lastMotionStop) <= config.agreementWindow {
            signals.append("motion_stop")
        }
        if let lastAudioDisconnect,
           at.timeIntervalSince(lastAudioDisconnect) <= config.agreementWindow {
            signals.append("audio_disconnect")
        }
        if let settled, at.timeIntervalSince(settled.at) <= config.agreementWindow {
            signals.append("location_settled")
        }
        guard signals.count >= 2 else { return }
        // /parked needs a coordinate: the settled fix, else the best fix the
        // burst has produced so far (motion+audio can agree before settling).
        let fix = settled ?? burstFixes.min { $0.accuracy < $1.accuracy }
        guard let fix else { return }

        lastFired = at
        clearPending()
        emit(.parkFired, at, signals.joined(separator: "+"))
        onPark?(fix, signals)
    }

    private func emit(_ signal: RawDetectorSignal, _ at: Date, _ detail: String? = nil) {
        onRawSignal?(signal, at, detail)
    }
}
