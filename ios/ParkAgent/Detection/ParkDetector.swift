import AVFoundation
import CoreLocation
import CoreMotion
import Foundation
import Observation
import UIKit

/// Keeps park detection alive around the drive and feeds `ParkFusionEngine`
/// (which owns the rules — see that file).
///
/// iOS suspends a backgrounded app within seconds, and a suspended app
/// hears nothing: no motion, no car audio. So the detector runs in three
/// modes:
///
/// - **idle** (between drives): only significant-change and visit
///   monitoring, which cost almost nothing and make iOS wake or relaunch
///   the app. Each wake replays CoreMotion's own history (kept by the
///   system while we slept), so a drive that started while suspended is
///   noticed.
/// - **tracking** (driving, or a stop being judged): standard location
///   updates at modest accuracy under a CLBackgroundActivitySession. They
///   keep the app running, so motion and audio events arrive live.
///   Background updates are allowed only with Always.
/// - **burst** (around the stop itself): best accuracy, only until the car's
///   spot settles or the burst times out, to protect the battery.
///
/// The engine's pending state goes to disk after every change
/// (DetectorStore), and `AppServices` re-arms the detector when iOS
/// relaunches the app for a location event, so a relaunch mid-park loses
/// nothing.
@MainActor
@Observable
final class ParkDetector: NSObject, CLLocationManagerDelegate {
    enum Mode: String, Sendable {
        case idle, tracking, burst
    }

    enum WakeReason: String, Sendable {
        case arm, locationLaunch, foreground, significantChange, visitArrival, visitDeparture, carAudioConnected
    }

    /// Fires with the resting fix and the signal names, for /parked.
    @ObservationIgnored var onPark: ((ParkFix, [String]) -> Void)?
    /// A park with nowhere to point (Precise Location off, no GPS fix).
    @ObservationIgnored var onUnlocatedPark: ((_ preciseOff: Bool) -> Void)?
    /// Asks for full accuracy for this session (PermissionsManager).
    @ObservationIgnored var requestPrecise: (() async -> Bool)?

    private(set) var isArmed = false
    private(set) var mode: Mode = .idle
    private(set) var lastWake: (reason: WakeReason, at: Date)?
    private(set) var lastFix: ParkFix?
    private(set) var monitoringSignificantChanges = false
    private(set) var monitoringVisits = false
    private(set) var capabilities = DetectionCapabilities()

    @ObservationIgnored let engine: ParkFusionEngine
    @ObservationIgnored private let signalLog: SignalLog
    @ObservationIgnored private let store: DetectorStore
    @ObservationIgnored private let motion: any MotionSource
    @ObservationIgnored private let audio = CarAudioSource()
    @ObservationIgnored private let locationManager = CLLocationManager()
    @ObservationIgnored private var backgroundSession: CLBackgroundActivitySession?
    @ObservationIgnored private var motionHistoryThrough: Date?
    @ObservationIgnored private var lastDriveEvidenceAt: Date?
    @ObservationIgnored private var deadlineTask: Task<Void, Never>?
    @ObservationIgnored private var keepAliveTask: Task<Void, Never>?
    @ObservationIgnored private var burstDeadline: Task<Void, Never>?
    @ObservationIgnored private var lastSaved: DetectorStore.Snapshot?
    @ObservationIgnored private var foregroundObserver: (any NSObjectProtocol)?
    /// Motion handling runs one step at a time, in order: a live sample
    /// that arrives on resume must wait for the history of the gap before
    /// it (see `motionReceived`).
    @ObservationIgnored private var motionChain: Task<Void, Never>?
    /// Debug only: the simulator has no motion coprocessor, so motion is
    /// derived from the (GPX-driven) fixes' speed. See `-detectorSimulation`.
    @ObservationIgnored private let simulated: Bool

    /// With no drive evidence for this long, tracking hands back to idle.
    static let trackingIdleTimeout: TimeInterval = 5 * 60
    /// Never keep the best-accuracy radio on longer than this.
    static let burstHardStop: TimeInterval = 120
    /// How far back a wake replays CoreMotion history at most (the system
    /// keeps a week; the query is cheap). Past this, what happened while
    /// we were gone is unknown and "was driving" is forgotten.
    static let historyReach: TimeInterval = 3 * 60 * 60

    init(
        engine: ParkFusionEngine = ParkFusionEngine(),
        signalLog: SignalLog = .shared,
        store: DetectorStore = DetectorStore(),
        motion: (any MotionSource)? = nil,
        simulated: Bool = false
    ) {
        self.engine = engine
        self.signalLog = signalLog
        self.store = store
        self.simulated = simulated
        #if DEBUG
        self.motion = motion ?? (simulated ? SpeedDerivedMotionSource() : CoreMotionSource())
        #else
        self.motion = motion ?? CoreMotionSource()
        #endif
        super.init()
        locationManager.delegate = self

        engine.onPark = { [weak self] fix, signals in
            guard let self else { return }
            // The spot is known; the reporter takes over if a session
            // starts. Back to near-free monitoring until the next drive.
            self.endTracking(reason: "parked")
            self.onPark?(fix, signals)
        }
        engine.onUnlocatedPark = { [weak self] _ in
            guard let self else { return }
            self.onUnlocatedPark?(!self.capabilities.preciseLocation)
        }
        engine.onStartBurst = { [weak self] in self?.startBurst() }
        engine.onStopBurst = { [weak self] in self?.stopBurst() }
        engine.onRawSignal = { [weak self] signal, at, detail in
            self?.signalLog.append(signal, at: at, detail: detail)
        }
        engine.onStateChange = { [weak self] _ in
            self?.persist()
            self?.scheduleDeadline()
        }
    }

    // MARK: - Arming

    /// Start (or resume) detection. Idempotent: RootView calls it once the
    /// user is past onboarding, and AppServices calls it at launch —
    /// including when iOS relaunched the app in the background for a
    /// location event, where no screen is ever shown.
    func arm(capabilities: DetectionCapabilities, reason: WakeReason = .arm) {
        self.capabilities = capabilities
        guard !isArmed else {
            Task { await wake(reason) }
            return
        }
        isArmed = true
        log(.armed, reason.rawValue)
        if let saved = store.load() {
            engine.restore(saved.engine)
            motionHistoryThrough = saved.motionHistoryThrough
            if Date.now.timeIntervalSince(saved.savedAt) > Self.historyReach { engine.forgetDriving() }
        }
        startMonitoring()
        audio.start(
            onDisconnect: { [weak self] port in self?.engine.audioDisconnected(port: port) },
            onConnect: { [weak self] in Task { await self?.wake(.carAudioConnected) } }
        )
        if motion.isAvailable {
            motion.start { [weak self] sample in self?.motionReceived(sample) }
        }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                Task { await self.wake(.foreground) }
            }
        }
        Task { await wake(reason) }
    }

    /// Sign-out: nothing of this account's keeps running or stays on disk.
    func disarm() {
        guard isArmed else { return }
        isArmed = false
        motion.stop()
        audio.stop()
        locationManager.stopMonitoringSignificantLocationChanges()
        locationManager.stopMonitoringVisits()
        monitoringSignificantChanges = false
        monitoringVisits = false
        setMode(.idle)
        deadlineTask?.cancel()
        keepAliveTask?.cancel()
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        foregroundObserver = nil
        engine.restore(ParkFusionEngine.State())
        store.clear()
        lastSaved = nil
        motionHistoryThrough = nil
        lastDriveEvidenceAt = nil
        motionChain?.cancel()
        motionChain = nil
    }

    /// Permissions changed under us (granted in Settings, revoked, Precise
    /// flipped): reconfigure rather than wait for a relaunch.
    func capabilitiesChanged(_ capabilities: DetectionCapabilities) {
        let before = self.capabilities
        self.capabilities = capabilities
        guard isArmed else { return }
        if !capabilities.locationUsable {
            // Revoked: nothing location-based can run, and continuing to
            // hold a background session would be a lie.
            setMode(.idle)
        } else if mode != .idle {
            setMode(mode)
        }
        if before.location != capabilities.location || before.locationServicesEnabled != capabilities.locationServicesEnabled {
            startMonitoring()
        }
        if !before.preciseLocation, capabilities.preciseLocation, engine.hasPendingStop {
            engine.requestFixes()
        }
        if motion.isAvailable, before.motion != .authorized, capabilities.motion == .authorized {
            motion.start { [weak self] sample in self?.motionReceived(sample) }
        }
    }

    /// Significant-change and visit monitoring need Always; they are what
    /// makes iOS wake (or relaunch) the app between drives.
    private func startMonitoring() {
        let always = capabilities.locationServicesEnabled && capabilities.location == .always
        if always, CLLocationManager.significantLocationChangeMonitoringAvailable() {
            locationManager.startMonitoringSignificantLocationChanges()
            monitoringSignificantChanges = true
        } else {
            locationManager.stopMonitoringSignificantLocationChanges()
            monitoringSignificantChanges = false
        }
        if always {
            locationManager.startMonitoringVisits()
            monitoringVisits = true
        } else {
            locationManager.stopMonitoringVisits()
            monitoringVisits = false
        }
    }

    // MARK: - Waking

    /// Something woke us (a relaunch, a significant move, a visit, the
    /// app opening): catch up on what CoreMotion saw while we slept, then
    /// decide whether a drive is under way.
    func wake(_ reason: WakeReason) async {
        guard isArmed else { return }
        lastWake = (reason, .now)
        log(.wake, reason.rawValue)
        // A background wake gets seconds; ask for enough to finish.
        let task = UIApplication.shared.beginBackgroundTask(withName: "detector-wake")
        defer { if task != .invalid { UIApplication.shared.endBackgroundTask(task) } }
        await serially { await self.replayMotionHistory(through: .now) }
        let drivingRecently = lastDriveEvidenceAt.map { Date.now.timeIntervalSince($0) < 3 * 60 } ?? false
        if simulated || drivingRecently || engine.hasPendingStop
            || reason == .visitDeparture || reason == .carAudioConnected {
            beginTracking(reason: reason.rawValue)
        }
    }

    /// Runs `step` after every motion step already queued.
    private func serially(_ step: @escaping @MainActor () async -> Void) async {
        let previous = motionChain
        let task = Task { @MainActor in
            await previous?.value
            await step()
        }
        motionChain = task
        await task.value
    }

    /// CoreMotion's own record of what happened while we weren't
    /// listening, fed to the engine in order, once each (the cursor is the
    /// last sample handled, live or replayed).
    private func replayMotionHistory(through end: Date) async {
        guard motion.isAvailable, !simulated else { return }
        let reach = end.addingTimeInterval(-Self.historyReach)
        let from: Date
        if let through = motionHistoryThrough, through > reach {
            from = through
        } else {
            // Gone longer than the history we replay: the gap is unknown.
            engine.forgetDriving()
            from = reach
        }
        guard from < end else { return }
        let samples = await motion.history(from: from, to: end)
        let fresh = samples.filter { $0.at > from && $0.at <= end }.sorted { $0.at < $1.at }
        for sample in fresh { handle(sample, live: false) }
        if !fresh.isEmpty { log(.historyReplayed, "\(fresh.count)") }
        // The cursor is the last sample handled, not the query's end:
        // CoreMotion can hand over its newest activity live a moment before
        // writing it to history, and a cursor at "now" would drop it.
        if fresh.isEmpty, motionHistoryThrough == nil || motionHistoryThrough! < from {
            motionHistoryThrough = from
        }
        persist()
    }

    /// A live sample. If there's a gap since the last one handled (the app
    /// was suspended), the history of that gap goes in first, so the engine
    /// sees the drive before the walk and never the same sample twice.
    private func motionReceived(_ sample: MotionSample) {
        Task {
            await serially {
                if let through = self.motionHistoryThrough, sample.at.timeIntervalSince(through) > 30 {
                    await self.replayMotionHistory(through: sample.at.addingTimeInterval(-0.001))
                }
                if let through = self.motionHistoryThrough, sample.at <= through { return }
                self.handle(sample, live: true)
            }
        }
    }

    private func handle(_ sample: MotionSample, live: Bool) {
        if sample.isDriving {
            lastDriveEvidenceAt = max(lastDriveEvidenceAt ?? sample.at, sample.at)
            if live { beginTracking(reason: "driving") }
        }
        engine.motion(sample)
        motionHistoryThrough = max(motionHistoryThrough ?? sample.at, sample.at)
    }

    // MARK: - Modes

    private func beginTracking(reason: String) {
        guard capabilities.locationUsable else { return }
        // While Using can't start updates from the background; only a
        // session begun while the app is open carries on behind it.
        if capabilities.location != .always, UIApplication.shared.applicationState == .background {
            return
        }
        if mode == .idle {
            log(.trackingStarted, reason)
            setMode(.tracking)
        }
        startKeepAlive()
    }

    private func endTracking(reason: String) {
        guard mode != .idle, !simulated else { return }
        keepAliveTask?.cancel()
        keepAliveTask = nil
        setMode(.idle)
        log(.trackingStopped, reason)
    }

    /// While tracking, check every half minute whether there's still a
    /// reason to: a stop being judged, or a drive in the last few minutes.
    private func startKeepAlive() {
        guard keepAliveTask == nil else { return }
        keepAliveTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled else { return }
                if self.engine.hasPendingStop || self.mode == .burst { continue }
                let idleFor = Date.now.timeIntervalSince(self.lastDriveEvidenceAt ?? .distantPast)
                if idleFor > Self.trackingIdleTimeout {
                    self.keepAliveTask = nil
                    self.endTracking(reason: "no_drive")
                    return
                }
            }
        }
    }

    private func startBurst() {
        beginTracking(reason: "stop")
        // Refused (While Using, in the background): nothing can deliver.
        guard mode != .idle else { return }
        setMode(.burst)
        // Precise off means every fix is blurred beyond use. iOS will
        // grant full accuracy for this session, but only if we ask while
        // the app is on screen.
        if !capabilities.preciseLocation, UIApplication.shared.applicationState == .active, let requestPrecise {
            log(.preciseRequested)
            Task { [weak self] in
                if await requestPrecise() { self?.engine.requestFixes() }
            }
        }
        burstDeadline?.cancel()
        burstDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.burstHardStop))
            guard !Task.isCancelled, let self, self.mode == .burst else { return }
            self.setMode(.tracking)
        }
    }

    private func stopBurst() {
        burstDeadline?.cancel()
        burstDeadline = nil
        if mode == .burst { setMode(.tracking) }
    }

    private func setMode(_ next: Mode) {
        // The engine logs burst start/stop and begin/endTracking log the
        // rest, so this only applies the mode.
        let target = capabilities.locationUsable ? next : .idle
        mode = target
        switch target {
        case .idle:
            locationManager.stopUpdatingLocation()
            locationManager.allowsBackgroundLocationUpdates = false
            backgroundSession?.invalidate()
            backgroundSession = nil
        case .tracking, .burst:
            locationManager.activityType = .automotiveNavigation
            // A parked car is exactly when iOS would auto-pause: never.
            locationManager.pausesLocationUpdatesAutomatically = false
            // Accuracy is what costs battery; best only for the burst. Every
            // fix is delivered either way: a still car produces none past a
            // distance filter, and the stop's spot is exactly a still car.
            locationManager.desiredAccuracy = target == .burst ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
            locationManager.distanceFilter = kCLDistanceFilterNone
            // Background updates only with Always; While Using rides on the
            // background activity session begun in the foreground.
            locationManager.allowsBackgroundLocationUpdates = capabilities.location == .always
            locationManager.showsBackgroundLocationIndicator = false
            if backgroundSession == nil { backgroundSession = CLBackgroundActivitySession() }
            locationManager.startUpdatingLocation()
        }
    }

    // MARK: - Deadlines and persistence

    private func scheduleDeadline() {
        deadlineTask?.cancel()
        guard let deadline = engine.nextDeadline else { return }
        deadlineTask = Task { [weak self] in
            let delay = deadline.timeIntervalSinceNow
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled else { return }
            self?.engine.tick()
        }
    }

    private func persist() {
        let snapshot = DetectorStore.Snapshot(
            engine: engine.state,
            motionHistoryThrough: motionHistoryThrough,
            savedAt: .now
        )
        // savedAt always differs; compare the parts that matter.
        if let lastSaved, lastSaved.engine == snapshot.engine,
           lastSaved.motionHistoryThrough == snapshot.motionHistoryThrough {
            return
        }
        lastSaved = snapshot
        store.save(snapshot)
    }

    private func log(_ signal: RawDetectorSignal, _ detail: String? = nil) {
        signalLog.append(signal, at: .now, detail: detail)
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let fixes = locations.map(ParkFix.init)
        Task { @MainActor in
            let wasIdle = self.mode == .idle
            for fix in fixes {
                self.lastFix = fix
                if let speed = fix.speed, speed >= self.engine.config.drivingSpeedMps {
                    self.lastDriveEvidenceAt = fix.at
                }
                #if DEBUG
                if self.simulated, let sample = (self.motion as? SpeedDerivedMotionSource)?.sample(for: fix) {
                    self.handle(sample, live: true)
                }
                #endif
                self.engine.fixReceived(fix)
            }
            // Updates while idle are significant-change events: iOS woke
            // (or relaunched) us because the phone moved ~500 m.
            if wasIdle { await self.wake(.significantChange) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let arrival = visit.arrivalDate
        let departed = visit.departureDate != .distantFuture
        let fix = ParkFix(coordinate: visit.coordinate, accuracy: visit.horizontalAccuracy, at: arrival)
        Task { @MainActor in
            if departed {
                self.log(.visitDeparture)
                await self.wake(.visitDeparture)
            } else {
                // History first: the stop the visit confirms may have
                // happened while we were suspended.
                await self.wake(.visitArrival)
                self.engine.visitArrived(fix)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        // Transient (no fix yet); the burst's timeout covers a lasting one.
    }
}

// MARK: - Sources

/// Motion activity, live and from the system's own history.
@MainActor
protocol MotionSource: AnyObject {
    var isAvailable: Bool { get }
    func start(_ handler: @escaping @MainActor (MotionSample) -> Void)
    func stop()
    func history(from: Date, to: Date) async -> [MotionSample]
}

extension MotionSample {
    init(_ activity: CMMotionActivity) {
        let confidence: Confidence = switch activity.confidence {
        case .low: .low
        case .medium: .medium
        default: .high
        }
        self.init(
            at: activity.startDate,
            automotive: activity.automotive,
            stationary: activity.stationary,
            walking: activity.walking,
            running: activity.running,
            cycling: activity.cycling,
            confidence: confidence
        )
    }
}

@MainActor
final class CoreMotionSource: MotionSource {
    private let manager = CMMotionActivityManager()

    /// Only once granted: starting updates while "not asked" would pop the
    /// prompt from the detector instead of onboarding.
    var isAvailable: Bool {
        CMMotionActivityManager.isActivityAvailable()
            && CMMotionActivityManager.authorizationStatus() == .authorized
    }

    func start(_ handler: @escaping @MainActor (MotionSample) -> Void) {
        manager.startActivityUpdates(to: .main) { activity in
            guard let activity else { return }
            let sample = MotionSample(activity)
            MainActor.assumeIsolated { handler(sample) }
        }
    }

    func stop() {
        manager.stopActivityUpdates()
    }

    func history(from: Date, to: Date) async -> [MotionSample] {
        await withCheckedContinuation { continuation in
            manager.queryActivityStarting(from: from, to: to, to: .main) { activities, _ in
                continuation.resume(returning: (activities ?? []).map(MotionSample.init))
            }
        }
    }
}

#if DEBUG
/// The simulator's stand-in for CoreMotion (Debug, `-detectorSimulation`):
/// driving, walking, or still, judged from the fixes' own speed, so a GPX
/// route drives the real detector end to end.
@MainActor
final class SpeedDerivedMotionSource: MotionSource {
    private var previous: ParkFix?
    private var stillSince: Date?

    var isAvailable: Bool { true }
    func start(_ handler: @escaping @MainActor (MotionSample) -> Void) {}
    func stop() {}
    func history(from: Date, to: Date) async -> [MotionSample] { [] }

    func sample(for fix: ParkFix) -> MotionSample? {
        defer { previous = fix }
        let speed: Double
        if let reported = fix.speed {
            speed = reported
        } else if let previous, fix.at > previous.at {
            speed = fix.distance(to: previous) / fix.at.timeIntervalSince(previous.at)
        } else {
            return nil
        }
        if speed >= 4 {
            stillSince = nil
            return MotionSample(at: fix.at, automotive: true)
        }
        // GPS wobble on a still phone reads as a few tenths of a m/s.
        if speed >= 0.8 {
            stillSince = nil
            return MotionSample(at: fix.at, walking: true)
        }
        // Like CoreMotion, call it stationary only after a few seconds.
        let since = stillSince ?? fix.at
        stillSince = since
        return fix.at.timeIntervalSince(since) >= 3 ? MotionSample(at: fix.at, stationary: true) : nil
    }
}
#endif

/// The car's audio route: CarPlay or a Bluetooth output going away is the
/// "car turned off" signal; one appearing hints a drive is starting.
@MainActor
final class CarAudioSource {
    private var observer: (any NSObjectProtocol)?

    private nonisolated static let bluetooth: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]

    func start(
        onDisconnect: @escaping @MainActor (ParkFusionEngine.AudioPort) -> Void,
        onConnect: @escaping @MainActor () -> Void
    ) {
        guard observer == nil else { return }
        // queue: .main — AVAudioSession posts on a background thread, and
        // this block is main-actor code (a Swift 6 trap off-main).
        observer = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { note in
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            let previousPort = previous.flatMap(Self.port(of:))
            let currentPort = Self.port(of: AVAudioSession.sharedInstance().currentRoute)
            MainActor.assumeIsolated {
                if reason == .oldDeviceUnavailable, let previousPort {
                    onDisconnect(previousPort)
                } else if reason == .newDeviceAvailable, currentPort != nil {
                    onConnect()
                }
            }
        }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    nonisolated static func port(of route: AVAudioSessionRouteDescription) -> ParkFusionEngine.AudioPort? {
        if route.outputs.contains(where: { $0.portType == .carAudio }) { return .carPlay }
        if route.outputs.contains(where: { bluetooth.contains($0.portType) }) { return .bluetooth }
        return nil
    }
}
