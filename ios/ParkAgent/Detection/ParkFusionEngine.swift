import CoreLocation
import Foundation

/// Every raw detector observation, as fed to the engine and (when the
/// Diagnostics switch is on) written to the on-device signal log. The raw
/// values are the log's vocabulary; the replay parser reads them back.
enum RawDetectorSignal: String, CaseIterable, Sendable {
    // Engine inputs. `motion`, `audio_disconnect[_ignored]`,
    // `location_fix`/`fix_rejected`, `visit_arrival`, and `altitude` lines
    // are what a replay feeds back in (SignalTrace); the rest are what was
    // decided.
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
    /// A barometer reading during a stop (`AltitudeSample`).
    case altitude = "altitude"
    // Engine decisions.
    case locationSettled = "location_settled"
    case parkFired = "park_fired"
    /// Enough evidence of a park, but no fix good enough to say where.
    case parkUnlocated = "park_unlocated"
    case debounced = "debounced"
    case drivingResumedCleared = "driving_resumed_cleared"
    case pendingExpired = "pending_expired"
    /// The stop's entry fix: the last good fix of the car still moving.
    case entryFix = "entry_fix"
    /// GPS went bad on the way in (a garage), at this line's time.
    case gpsLost = "gps_lost"
    /// What the place classifier made of a park (ParkDetector).
    case placeClassified = "place_classified"
    // The detector's own lifecycle, so a field log shows what was running.
    case armed = "armed"
    case wake = "wake"
    case trackingStarted = "tracking_started"
    case trackingStopped = "tracking_stopped"
    case burstStarted = "burst_started"
    case burstStopped = "burst_stopped"
    case altimeterStarted = "altimeter_started"
    case altimeterStopped = "altimeter_stopped"
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

/// A park as the engine saw it, with what the place classifier needs to
/// say what kind of place it is (FR-53).
struct ParkOutcome: Codable, Equatable, Sendable {
    /// Where the car is; nil for a park with no fix good enough to say
    /// (GPS gone in a garage, or Precise Location off).
    var fix: ParkFix?
    var signals: [String]
    /// When the car stopped.
    var stopAt: Date
    /// The last good fix of the car still moving in: which garage it
    /// entered when the spot itself has no fix.
    var entryFix: ParkFix?
    /// When GPS went bad on the way in, if it did and didn't come back.
    var gpsLossAt: Date?
    /// Net climb (negative: descent) over the stop window, meters.
    var baroDeltaM: Double?
    /// Seconds of parking-lot crawl just before the stop.
    var crawlS: TimeInterval?
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
        // The place classifier's evidence (docs/research/3-park-now.md §2).
        /// An entry fix is at least this good…
        var entryFixMaxAccuracyM: Double = 30
        /// …taken moving at least this fast (the car, not a still spot)…
        var entryFixMinSpeedMps: Double = 1
        /// …no longer than this before the stop.
        var entryFixMaxAge: TimeInterval = 120
        /// After a good fix, one worse than this is GPS lost (a garage).
        var gpsLossAccuracyM: Double = 65
        /// After a good fix, this long with no fix at all is GPS lost.
        var gpsLossWindow: TimeInterval = 45
        /// A barometer jump bigger than this (hPa) in under
        /// `baroSpikeWindow` is a door or a window, not a ramp.
        var baroSpikeHPa: Double = 0.5
        var baroSpikeWindow: TimeInterval = 2
        /// Moving no faster than this (and faster than the entry fix's
        /// minimum) is a parking-lot crawl.
        var crawlMaxSpeedMps: Double = 4.5
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
            // The place classifier's evidence. All optional, so a state
            // saved by an older build still restores.
            /// The last good fix of the car still moving in (accuracy ≤
            /// `entryFixMaxAccuracyM`, faster than `entryFixMinSpeedMps`,
            /// at most `entryFixMaxAge` before the stop).
            var entryFix: ParkFix?
            /// When GPS went bad on the way in: the first fix worse than
            /// `gpsLossAccuracyM`, or the last fix before `gpsLossWindow`
            /// of silence. Only after a good fix (Precise off never loses
            /// what it never had); a good fix while still driving (a
            /// tunnel) takes it back.
            var gpsLossAt: Date?
            /// Net climb over the stop window from the barometer, meters;
            /// nil when it never ran.
            var baroDeltaM: Double?
            /// Seconds of parking-lot crawl up to the stop.
            var crawlS: TimeInterval?
            /// The newest fix of any quality that could describe the car
            /// (not the walk), for judging silence.
            var lastCarFixAt: Date?
            /// A good fix was seen on the way in: only then can GPS be lost.
            var gpsWasGood: Bool?
            /// The last barometer reading counted; nil at each altimeter start.
            var baroBaseline: AltitudeSample?
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
    /// What the fixes said on the way to the next stop; handed to the stop
    /// when it begins. Like `recentFixes`, not persisted: a relaunch
    /// mid-drive just starts it over.
    private var approach = Approach()
    /// Motion arrives many times a minute; the log keeps the changes.
    private var lastLoggedMotion: (kinds: String, at: Date)?

    private struct Approach {
        var entryFix: ParkFix?
        var gpsWasGood = false
        var lossAt: Date?
        var lastFixAt: Date?
        var crawlSince: Date?
        var crawlLastAt: Date?

        init() {}

        /// A stop that driving cleared, back into the way in it interrupted.
        init(resuming stop: State.Stop) {
            entryFix = stop.entryFix
            gpsWasGood = stop.gpsWasGood == true
            lossAt = stop.gpsLossAt
            lastFixAt = stop.lastCarFixAt
        }
    }

    /// The resting fix and the agreeing signal names, for /parked.
    var onPark: ((ParkFix, [String]) -> Void)?
    /// A confirmed park with no usable fix (Precise off, no GPS).
    var onUnlocatedPark: (([String]) -> Void)?
    /// Every park, located or not, with the place classifier's evidence;
    /// called just before `onPark` / `onUnlocatedPark`.
    var onOutcome: ((ParkOutcome) -> Void)?
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
                // A new drive: what the last one's fixes said is done.
                approach = Approach()
                emit(.motionDriving, at)
            }
            // Back on the road: a light, a drive-through, a pickup lane. A
            // stop started by audio alone (no motion stop yet) is cleared by
            // any driving after it too: the car's Bluetooth dropped mid-drive.
            if let stop = state.stop, resumed || (stop.stopAt == nil && at > stop.startedAt) {
                // Still the same way in (a garage's ticket gate): the entry
                // fix and the GPS it saw carry on to the real stop.
                approach = Approach(resuming: stop)
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
        if state.stop == nil { observeApproach(fix) }
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
        observeStopWindow(fix, in: &stop)
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

    /// A barometer reading. Only readings in a stop's window count, and the
    /// net change ignores a door or a window: a jump of more than
    /// `baroSpikeHPa` within `baroSpikeWindow` of the last reading counted
    /// is skipped, and the next reading is measured from before it.
    func altitude(_ sample: AltitudeSample) {
        emit(.altitude, now(), Self.describe(sample) + Self.age(of: sample.at, at: now()))
        guard state.burstActive, var stop = state.stop, sample.at >= stop.startedAt else { return }
        guard let base = stop.baroBaseline else {
            stop.baroBaseline = sample
            stop.baroDeltaM = stop.baroDeltaM ?? 0
            state.stop = stop
            return
        }
        let jumpHPa = abs(sample.pressureKPa - base.pressureKPa) * 10
        if jumpHPa > config.baroSpikeHPa, sample.at.timeIntervalSince(base.at) < config.baroSpikeWindow { return }
        stop.baroDeltaM = (stop.baroDeltaM ?? 0) + (sample.relativeAltitudeM - base.relativeAltitudeM)
        stop.baroBaseline = sample
        // Not persisted per reading (one a second): the next change
        // writes it, and a relaunch losing a few seconds of climb is fine.
        state.stop = stop
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
        takeApproach(into: &stop, at: at)
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
        // The altimeter starts with the burst, from zero: a new baseline.
        state.stop?.baroBaseline = nil
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
        noteSilence(at: at)
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
            // quiet and let a visit (or the TTL) settle it — unless the car
            // was seen driving in with good GPS just before (an entry fix):
            // then silence is a garage with no signal, not a suspension.
            let parkLike = (kinds >= 2 && confirmed) || (stop.stopAt != nil && stop.walkAt != nil)
            let burstDone = !state.burstActive || at.timeIntervalSince(newestStopSignal(stop)) >= config.burstTimeout
            let burstHeardSomething = stop.fixesSeen > 0 || stop.entryFix != nil
            if located == nil, parkLike, burstDone, burstHeardSomething, !stop.unlocatedReported {
                stop.unlocatedReported = true
                state.stop = stop
                emit(.parkUnlocated, at, signals.joined(separator: "+"))
                onOutcome?(outcome(of: stop, fix: nil, signals: signals))
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
        let fired = outcome(of: stop, fix: fix, signals: signals)
        clearStop()
        emit(.parkFired, at, signals.joined(separator: "+"))
        onOutcome?(fired)
        onPark?(fix, signals)
    }

    private func outcome(of stop: State.Stop, fix: ParkFix?, signals: [String]) -> ParkOutcome {
        ParkOutcome(
            fix: fix,
            signals: signals,
            stopAt: stop.stopAt ?? stop.startedAt,
            entryFix: stop.entryFix,
            gpsLossAt: stop.gpsLossAt,
            baroDeltaM: stop.baroDeltaM,
            crawlS: stop.crawlS
        )
    }

    // MARK: - Place evidence

    private func isEntryCandidate(_ fix: ParkFix) -> Bool {
        fix.accuracy > 0 && fix.accuracy <= config.entryFixMaxAccuracyM
            && (fix.speed ?? 0) > config.entryFixMinSpeedMps
    }

    private func isGood(_ fix: ParkFix) -> Bool {
        fix.accuracy > 0 && fix.accuracy <= config.entryFixMaxAccuracyM
    }

    /// A fix on the way to a stop: the entry fix, a GPS loss (or, while
    /// still driving, its recovery: a tunnel), and a parking-lot crawl.
    private func observeApproach(_ fix: ParkFix) {
        guard fix.accuracy > 0 else { return }
        let driving = state.wasDriving || recentlyDriving(at: fix.at)
        approach.lastFixAt = max(approach.lastFixAt ?? fix.at, fix.at)
        if isGood(fix) {
            approach.gpsWasGood = true
            if driving, approach.lossAt != nil { approach.lossAt = nil }
        } else if fix.accuracy > config.gpsLossAccuracyM, approach.gpsWasGood, approach.lossAt == nil, driving {
            approach.lossAt = fix.at
            emit(.gpsLost, fix.at, String(format: "accuracy ±%.0fm", fix.accuracy))
        }
        if isEntryCandidate(fix), fix.at >= (approach.entryFix?.at ?? .distantPast) {
            approach.entryFix = fix
        }
        if let speed = fix.speed {
            if speed > config.crawlMaxSpeedMps {
                approach.crawlSince = nil
                approach.crawlLastAt = nil
            } else if speed > config.entryFixMinSpeedMps {
                approach.crawlSince = approach.crawlSince ?? fix.at
                approach.crawlLastAt = fix.at
            }
        }
    }

    /// The approach becomes the stop's evidence, and a new one starts.
    private func takeApproach(into stop: inout State.Stop, at: Date) {
        if let entry = approach.entryFix, at.timeIntervalSince(entry.at) <= config.entryFixMaxAge {
            stop.entryFix = entry
            emit(.entryFix, entry.at, Self.describe(entry))
        }
        stop.gpsWasGood = approach.gpsWasGood ? true : nil
        stop.gpsLossAt = approach.lossAt
        stop.lastCarFixAt = approach.lastFixAt
        if let since = approach.crawlSince, let last = approach.crawlLastAt,
           at.timeIntervalSince(last) <= config.entryFixMaxAge {
            stop.crawlS = last.timeIntervalSince(since)
        }
        approach = Approach()
    }

    /// A fix in the stop's window that could still be the car (before the
    /// walk): a late entry fix (motion reports a stop some seconds after
    /// the car stopped), or GPS going bad at a spot with no good fix yet.
    /// Nothing here takes a loss back: a good fix now means the spot is
    /// known, and the classifier judges a located park by where it is.
    private func observeStopWindow(_ fix: ParkFix, in stop: inout State.Stop) {
        guard fix.accuracy > 0 else { return }
        stop.lastCarFixAt = max(stop.lastCarFixAt ?? fix.at, fix.at)
        let stoppedAt = stop.stopAt ?? stop.startedAt
        if isEntryCandidate(fix), fix.at <= stoppedAt, fix.at >= (stop.entryFix?.at ?? .distantPast) {
            stop.entryFix = fix
            emit(.entryFix, fix.at, Self.describe(fix))
        }
        if isGood(fix) { stop.gpsWasGood = true }
        if fix.accuracy > config.gpsLossAccuracyM, stop.gpsWasGood == true, stop.gpsLossAt == nil,
           stop.settled == nil, stop.burstFixes.isEmpty {
            stop.gpsLossAt = fix.at
            emit(.gpsLost, fix.at, String(format: "accuracy ±%.0fm", fix.accuracy))
        }
    }

    /// Fixes stopping altogether after good GPS on the way in — a ramp
    /// down, no sky — is a loss, dated from the last fix. Not once the
    /// spot has a good fix: then the burst has simply rested.
    private func noteSilence(at: Date) {
        guard var stop = state.stop, stop.gpsLossAt == nil, stop.gpsWasGood == true,
              stop.settled == nil, stop.burstFixes.isEmpty,
              let last = stop.lastCarFixAt, at.timeIntervalSince(last) >= config.gpsLossWindow
        else { return }
        stop.gpsLossAt = last
        state.stop = stop
        emit(.gpsLost, last, String(format: "silence %.0fs", at.timeIntervalSince(last)))
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

    /// "relm pressurekPa" — the signal log's barometer format.
    static func describe(_ sample: AltitudeSample) -> String {
        String(format: "%.2fm %.4fkPa", sample.relativeAltitudeM, sample.pressureKPa)
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
