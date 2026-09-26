import CoreLocation
import Foundation

/// Every raw detector observation, as fed to the engine and (when the
/// Diagnostics switch is on) written to the on-device signal log. The raw
/// values are the log's vocabulary; the replay parser reads them back.
enum RawDetectorSignal: String, CaseIterable, Sendable {
    // Engine inputs. `motion`, `audio_disconnect[_ignored]`,
    // `location_fix`/`fix_rejected`, and `visit_arrival` lines are what a
    // replay feeds back in (SignalTrace); the rest are what was decided.
    case motionSample = "motion"
    case motionDriving = "motion_driving"
    case motionStop = "motion_stop"
    case motionWalking = "motion_walking"
    case audioDisconnect = "audio_disconnect"
    /// A Bluetooth route dropped with no drive behind it (headphones at a desk).
    case audioIgnored = "audio_disconnect_ignored"
    case fix = "location_fix"
    case fixRejected = "fix_rejected"
    case visitArrival = "visit_arrival"
    case visitDeparture = "visit_departure"
    // Engine decisions.
    case locationSettled = "location_settled"
    case parkFired = "park_fired"
    /// Enough evidence of a park, but no fix good enough to say where.
    case parkUnlocated = "park_unlocated"
    case debounced = "debounced"
    case drivingResumedCleared = "driving_resumed_cleared"
    case pendingExpired = "pending_expired"
    // The detector's own lifecycle, so a field log shows what was running.
    case armed = "armed"
    case wake = "wake"
    case trackingStarted = "tracking_started"
    case trackingStopped = "tracking_stopped"
    case burstStarted = "burst_started"
    case burstStopped = "burst_stopped"
    case historyReplayed = "history_replayed"
    case preciseRequested = "precise_requested"
}

/// One motion-activity reading (CoreMotion's, or a replayed one).
struct MotionSample: Codable, Equatable, Sendable {
    enum Confidence: Int, Codable, Sendable { case low, medium, high }

    var at: Date
    var automotive = false
    var stationary = false
    var walking = false
    var running = false
    var cycling = false
    var confidence: Confidence = .high

    /// In a vehicle. CoreMotion keeps `automotive` true at a red light
    /// (stationary AND automotive), which is what keeps a light from
    /// looking like a park.
    var isDriving: Bool { automotive && confidence != .low }
    var isOnFoot: Bool { (walking || running) && confidence != .low }
    var isStill: Bool { stationary && !automotive }
}

/// The park fusion, free of every system framework so it runs under
/// injected sources in unit tests and replays recorded field traces.
///
/// A **stop** begins when driving ends (motion leaves automotive), or when
/// the car's audio drops after a drive. Evidence then collects in three
/// kinds: motion (the stop, walking away), audio (CarPlay/Bluetooth gone),
/// and location (the burst's fixes settling, or iOS reporting a visit).
/// A park fires when the stop has
///
/// 1. two of the three kinds,
/// 2. something a red light never produces: walking away, the car's
///    audio dropping, iOS's own "you arrived" visit, or the stop simply
///    lasting `sustainedStop`, and
/// 3. a fix good enough to say which block (`FixGate`).
///
/// Driving again clears the stop, so a light or a drive-through leaves
/// nothing behind to pair with later. A park fires at most once per
/// `debounce`. Every signal carries its own time: replayed CoreMotion
/// history and late visits are judged by when they happened, not by when
/// the app heard about them.
@MainActor
final class ParkFusionEngine {
    struct Config: Sendable {
        /// Audio must drop within this of the motion stop to count with it.
        var agreementWindow: TimeInterval = 90
        var debounce: TimeInterval = 3 * 60
        var settleFixCount = 3
        var settleRadiusM: Double = 20
        /// Standing still this long after a drive counts as parked even
        /// with no walking, audio, or visit (someone waiting in the car).
        var sustainedStop: TimeInterval = 150
        /// A stop that never confirms (or never gets a fix) is dropped
        /// after this. Long enough for iOS's visit, which can locate a
        /// stop the app slept through, to arrive.
        var stopTTL: TimeInterval = 15 * 60
        /// The high-accuracy burst gives up this long after the last stop
        /// signal if it never settles, so the radio isn't held open.
        var burstTimeout: TimeInterval = 90
        /// Bluetooth audio dropping counts only this soon after driving.
        var recentDriveWindow: TimeInterval = 10 * 60
        /// A fix this fast is a drive, for phones without motion data.
        var drivingSpeedMps: Double = 6
        var fixGate = FixGate.Config()
    }

    enum AudioPort: String, Codable, Sendable {
        /// CarPlay: only ever a car.
        case carPlay
        /// Any Bluetooth route: a car or a pair of headphones.
        case bluetooth
    }

    /// Everything that must survive a relaunch mid-stop (see DetectorStore).
    struct State: Codable, Equatable, Sendable {
        struct Stop: Codable, Equatable, Sendable {
            var startedAt: Date
            var stopAt: Date?
            var walkAt: Date?
            var audioAt: Date?
            var settled: ParkFix?
            var visit: ParkFix?
            var burstFixes: [ParkFix] = []
            /// Fixes the burst received for this stop, good or not. Zero
            /// means no burst ever ran (the stop was rebuilt from motion
            /// history after a suspension), which is not "no GPS".
            var fixesSeen = 0
            var unlocatedReported = false
        }

        var wasDriving = false
        var lastDrivingAt: Date?
        var stop: Stop?
        var burstActive = false
        var burstStartedAt: Date?
        var lastFired: Date?
    }

    let config: Config
    private let now: @MainActor () -> Date
    private(set) var state = State()
    private var gate: FixGate
    /// Fixes from the last half minute before any stop (tracking mode).
    /// Motion reports a stop some seconds after the car actually stopped,
    /// so the burst starts late; the near-still fixes from just before it
    /// are the car's spot too.
    private var recentFixes: [ParkFix] = []
    /// Motion arrives many times a minute; the log keeps the changes.
    private var lastLoggedMotion: (kinds: String, at: Date)?

    /// The resting fix and the agreeing signal names, for /parked.
    var onPark: ((ParkFix, [String]) -> Void)?
    /// A confirmed park with no usable fix (Precise off, no GPS).
    var onUnlocatedPark: (([String]) -> Void)?
    var onStartBurst: (() -> Void)?
    var onStopBurst: (() -> Void)?
    /// Every raw observation, timestamped — the signal log.
    var onRawSignal: ((RawDetectorSignal, Date, String?) -> Void)?
    /// After anything that changes `state`, so the wrapper can persist it.
    var onStateChange: ((State) -> Void)?

    init(config: Config = Config(), now: @escaping @MainActor () -> Date = { Date() }) {
        self.config = config
        self.now = now
        gate = FixGate(config: config.fixGate)
    }

    // MARK: - Persistence

    /// Picks up where a previous process left off. A stop older than its
    /// TTL is dropped rather than resumed.
    func restore(_ saved: State) {
        state = saved
        if let stop = state.stop, now().timeIntervalSince(stop.startedAt) > config.stopTTL {
            state.stop = nil
            state.burstActive = false
        }
    }

    var hasPendingStop: Bool { state.stop != nil }

    /// What happened since the last sample is unknown (the app was gone
    /// longer than CoreMotion history is replayed): "was driving" is no
    /// longer something to build a stop on. Without this, a relaunch the
    /// next morning turned its first "stationary" reading into a stop.
    func forgetDriving() {
        guard state.wasDriving else { return }
        state.wasDriving = false
        changed()
    }

    // MARK: - Inputs

    func motion(_ sample: MotionSample) {
        let at = sample.at
        let kinds = Self.describeKinds(sample)
        // Changes, plus one a minute of the same: a replay needs to see a
        // long drive continuing, not only its first sample.
        if kinds != lastLoggedMotion?.kinds || at.timeIntervalSince(lastLoggedMotion?.at ?? .distantPast) >= 60 {
            lastLoggedMotion = (kinds, at)
            emit(.motionSample, now(), "\(kinds)\(Self.age(of: at, at: now()))")
        }
        if sample.isDriving {
            state.lastDrivingAt = at
            let resumed = !state.wasDriving
            if resumed {
                state.wasDriving = true
                emit(.motionDriving, at)
            }
            // Back on the road: a light, a drive-through, a pickup lane. A
            // stop started by audio alone (no motion stop yet) is cleared by
            // any driving after it too: the car's Bluetooth dropped mid-drive.
            if let stop = state.stop, resumed || (stop.stopAt == nil && at > stop.startedAt) {
                clearStop()
                emit(.drivingResumedCleared, at)
            }
            changed()
            return
        }
        if state.wasDriving, sample.isStill || sample.isOnFoot {
            state.wasDriving = false
            beginStop(at: at)
            state.stop?.stopAt = at
            emit(.motionStop, at)
        }
        if sample.isOnFoot, var stop = state.stop, stop.stopAt != nil, stop.walkAt == nil {
            stop.walkAt = at
            state.stop = stop
            emit(.motionWalking, at)
        }
        evaluate(at: at)
    }

    func audioDisconnected(port: AudioPort, at: Date? = nil) {
        let at = at ?? now()
        // Headphones coming off at a desk look exactly like a car's
        // Bluetooth going away; only a recent drive (or CarPlay, which is
        // never headphones) makes it a car.
        guard port == .carPlay || recentlyDriving(at: at) else {
            emit(.audioIgnored, at, port.rawValue)
            return
        }
        beginStop(at: at)
        state.stop?.audioAt = at
        emit(.audioDisconnect, at, port.rawValue)
        evaluate(at: at)
    }

    func fixReceived(_ fix: ParkFix) {
        let receivedAt = now()
        if let speed = fix.speed, speed >= config.drivingSpeedMps {
            state.lastDrivingAt = fix.at
        }
        let described = Self.describe(fix) + Self.age(of: fix.at, at: receivedAt)
        guard state.burstActive, var stop = state.stop else {
            emit(.fix, receivedAt, described)
            recentFixes.append(fix)
            recentFixes.removeAll { fix.at.timeIntervalSince($0.at) > Self.seedWindow }
            return
        }
        // After the walk away starts, a fix is where the driver is, not
        // the car: it counts as seen, never as the spot.
        if let walkAt = stop.walkAt, fix.at > walkAt {
            stop.fixesSeen += 1
            state.stop = stop
            emit(.fix, receivedAt, described)
            evaluate(at: receivedAt)
            return
        }
        // Only a fix taken around the stop describes where the car is. One
        // from minutes later (a stop rebuilt from history on a late wake)
        // is wherever the driver walked to.
        guard fix.at <= newestStopSignal(stop).addingTimeInterval(config.burstTimeout) else {
            emit(.fix, receivedAt, described)
            evaluate(at: receivedAt)
            return
        }
        stop.fixesSeen += 1
        state.stop = stop
        switch gate.evaluate(fix, receivedAt: receivedAt) {
        case .reject(let reason):
            emit(.fixRejected, receivedAt, "\(reason.rawValue) \(described)")
            evaluate(at: receivedAt)
            return
        case .accept:
            emit(.fix, receivedAt, described)
        }
        stop.burstFixes.append(fix)
        // Only the last few matter for settling; keep the record small.
        if stop.burstFixes.count > 30 { stop.burstFixes.removeFirst(stop.burstFixes.count - 30) }
        if stop.settled == nil, let resting = settledFix(stop.burstFixes) {
            stop.settled = resting
            emit(.locationSettled, resting.at, Self.describe(resting))
        }
        state.stop = stop
        evaluate(at: receivedAt)
    }

    /// iOS's visit monitoring: an arrival is its judgment that you stopped
    /// somewhere and stayed. It arrives minutes late, so it's placed at its
    /// own arrival time.
    func visitArrived(_ fix: ParkFix) {
        emit(.visitArrival, now(), Self.describe(fix) + Self.age(of: fix.at, at: now()))
        guard var stop = state.stop, fix.at.timeIntervalSince(stop.startedAt) <= config.stopTTL,
              fix.at >= stop.startedAt.addingTimeInterval(-config.agreementWindow)
        else { return }
        stop.visit = fix
        state.stop = stop
        evaluate(at: now())
    }

    /// Time passing matters on its own (a sustained stop, a TTL, a burst
    /// that never settles). The wrapper calls this at `nextDeadline`.
    func tick() {
        let at = now()
        if let stop = state.stop, at.timeIntervalSince(stop.startedAt) > config.stopTTL {
            clearStop()
            emit(.pendingExpired, at)
            changed()
            return
        }
        evaluate(at: at)
    }

    /// Run the burst again for a stop still waiting on a fix: Precise
    /// Location was just granted for the session, or the app came to the
    /// foreground in time.
    func requestFixes() {
        guard var stop = state.stop else { return }
        stop.unlocatedReported = false
        state.stop = stop
        state.burstActive = false
        startBurst(at: now())
        changed()
    }

    /// When `tick()` next has something to decide, if anything.
    var nextDeadline: Date? {
        guard let stop = state.stop else { return nil }
        var deadlines = [stop.startedAt.addingTimeInterval(config.stopTTL)]
        if let stopAt = stop.stopAt, stop.walkAt == nil, stop.audioAt == nil {
            deadlines.append(stopAt.addingTimeInterval(config.sustainedStop))
        }
        if state.burstActive {
            deadlines.append(newestStopSignal(stop).addingTimeInterval(config.burstTimeout))
        }
        return deadlines.min()
    }

    // MARK: - Fusion

    private func recentlyDriving(at: Date) -> Bool {
        guard let last = state.lastDrivingAt else { return state.wasDriving }
        return state.wasDriving || at.timeIntervalSince(last) <= config.recentDriveWindow
    }

    private func beginStop(at: Date) {
        guard state.stop == nil else { return }
        var stop = State.Stop(startedAt: at)
        // Seed with the near-still fixes from just before the stop was
        // noticed (see `recentFixes`); each still has to pass the gate.
        var seedGate = FixGate(config: config.fixGate)
        stop.burstFixes = recentFixes.filter { fix in
            at.timeIntervalSince(fix.at) <= Self.seedWindow
                && (fix.speed ?? 0) < Self.stillSpeedMps
                && seedGate.evaluate(fix, receivedAt: fix.at) == .accept
        }
        stop.settled = settledFix(stop.burstFixes)
        recentFixes = []
        state.stop = stop
        if let settled = stop.settled { emit(.locationSettled, settled.at, Self.describe(settled)) }
        startBurst(at: at)
    }

    private static let seedWindow: TimeInterval = 30
    /// Slower than this, a fix from before the stop is the car rolling to
    /// its spot rather than driving past it.
    private static let stillSpeedMps: Double = 2

    private func clearStop() {
        state.stop = nil
        stopBurst(at: now())
    }

    private func startBurst(at: Date) {
        guard !state.burstActive else { return }
        state.burstActive = true
        state.burstStartedAt = at
        gate.reset()
        emit(.burstStarted, at)
        onStartBurst?()
    }

    private func stopBurst(at: Date) {
        guard state.burstActive else { return }
        state.burstActive = false
        emit(.burstStopped, at)
        onStopBurst?()
    }

    /// The burst's clock: from the latest stop signal, or from a restart
    /// (`requestFixes`), whichever is later.
    private func newestStopSignal(_ stop: State.Stop) -> Date {
        [stop.startedAt, stop.stopAt, stop.audioAt, stop.walkAt, state.burstStartedAt]
            .compactMap { $0 }.max() ?? stop.startedAt
    }

    /// Where the car is, from the burst alone: fixes taken before walking
    /// away describe the car, later ones the walk. Most accurate of those.
    private func bestBurstFix(_ stop: State.Stop) -> ParkFix? {
        let beforeWalking = stop.burstFixes.filter { fix in stop.walkAt.map { fix.at <= $0 } ?? true }
        return (beforeWalking.isEmpty ? stop.burstFixes : beforeWalking)
            .min { $0.accuracy < $1.accuracy }
    }

    /// Settled = the last `settleFixCount` burst fixes all within
    /// `settleRadiusM` of the newest; the resting fix is the most accurate.
    private func settledFix(_ fixes: [ParkFix]) -> ParkFix? {
        guard fixes.count >= config.settleFixCount else { return nil }
        let window = fixes.suffix(config.settleFixCount)
        let anchor = window.last!
        guard window.allSatisfy({ $0.distance(to: anchor) <= config.settleRadiusM }) else { return nil }
        return window.min { $0.accuracy < $1.accuracy }
    }

    private func audioAgrees(_ stop: State.Stop) -> Bool {
        guard let audioAt = stop.audioAt else { return false }
        // Without a motion stop (no motion data) the audio drop IS the stop.
        guard let stopAt = stop.stopAt else { return true }
        return abs(audioAt.timeIntervalSince(stopAt)) <= config.agreementWindow
    }

    private func evaluate(at: Date) {
        defer { changed() }
        guard var stop = state.stop else { return }

        let audio = audioAgrees(stop)
        var signals: [String] = []
        if stop.stopAt != nil { signals.append("motion_stop") }
        if stop.walkAt != nil { signals.append("motion_walking") }
        if audio { signals.append("audio_disconnect") }
        if stop.settled != nil { signals.append("location_settled") }
        if stop.visit != nil { signals.append("visit_arrival") }

        let kinds = [stop.stopAt != nil || stop.walkAt != nil, audio, stop.settled != nil || stop.visit != nil]
            .filter { $0 }.count
        let sustained = stop.stopAt.map { at.timeIntervalSince($0) >= config.sustainedStop } ?? false
        let confirmed = audio || stop.walkAt != nil || stop.visit != nil || sustained
        // Where: the settled fix, else a visit precise enough, else the
        // best burst fix — every candidate already through the fix gate
        // except the visit, which is held to the same accuracy bar here.
        let visitFix = stop.visit.flatMap { $0.accuracy > 0 && $0.accuracy <= config.fixGate.maxAccuracyM ? $0 : nil }
        let located = stop.settled ?? visitFix ?? bestBurstFix(stop)

        guard kinds >= 2, confirmed, let fix = located else {
            // A park with nowhere to point: the burst saw fixes and none
            // were good enough (Precise Location off, no sky). Stopping and
            // walking away is park enough to say so, once, when the burst
            // has had its chance. A burst that saw no fixes at all means
            // the stop was rebuilt from history after a suspension: stay
            // quiet and let a visit (or the TTL) settle it.
            let parkLike = (kinds >= 2 && confirmed) || (stop.stopAt != nil && stop.walkAt != nil)
            let burstDone = !state.burstActive || at.timeIntervalSince(newestStopSignal(stop)) >= config.burstTimeout
            if located == nil, parkLike, burstDone, stop.fixesSeen > 0, !stop.unlocatedReported {
                stop.unlocatedReported = true
                state.stop = stop
                emit(.parkUnlocated, at, signals.joined(separator: "+"))
                onUnlocatedPark?(signals)
            }
            stopBurstIfDone(stop, at: at)
            return
        }

        if let lastFired = state.lastFired, at.timeIntervalSince(lastFired) < config.debounce {
            emit(.debounced, at)
            clearStop()
            return
        }
        state.lastFired = at
        clearStop()
        emit(.parkFired, at, signals.joined(separator: "+"))
        onPark?(fix, signals)
    }

    /// The radio can rest once the car's spot is known, or when the burst
    /// has had its chance.
    private func stopBurstIfDone(_ stop: State.Stop, at: Date) {
        guard state.burstActive else { return }
        if stop.settled != nil || at.timeIntervalSince(newestStopSignal(stop)) >= config.burstTimeout {
            stopBurst(at: at)
        }
    }

    private func changed() {
        onStateChange?(state)
    }

    private func emit(_ signal: RawDetectorSignal, _ at: Date, _ detail: String? = nil) {
        onRawSignal?(signal, at, detail)
    }

    /// "lat,lng ±acc [speed]" — the signal log's fix format, which the
    /// replay parser reads back (see SignalTrace).
    static func describe(_ fix: ParkFix) -> String {
        var text = String(format: "%.6f,%.6f ±%.0fm", fix.latitude, fix.longitude, fix.accuracy)
        if let speed = fix.speed { text += String(format: " %.1fm/s", speed) }
        return text
    }

    /// " age=Ns" when the event happened a noticeable time before it was
    /// handled (cached fixes, CoreMotion history, late visits).
    static func age(of eventAt: Date, at handledAt: Date) -> String {
        let age = handledAt.timeIntervalSince(eventAt)
        return age >= 0.5 ? String(format: " age=%.0fs", age) : ""
    }

    /// "automotive,stationary high" — the kinds CoreMotion reported, and
    /// its confidence.
    static func describeKinds(_ sample: MotionSample) -> String {
        var kinds: [String] = []
        if sample.automotive { kinds.append("automotive") }
        if sample.stationary { kinds.append("stationary") }
        if sample.walking { kinds.append("walking") }
        if sample.running { kinds.append("running") }
        if sample.cycling { kinds.append("cycling") }
        let confidence = ["low", "medium", "high"][sample.confidence.rawValue]
        return "\(kinds.isEmpty ? "unknown" : kinds.joined(separator: ",")) \(confidence)"
    }
}
