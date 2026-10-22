import CoreLocation
import Foundation
import Observation

/// While a session is active, streams location and POSTs /location — the
/// extension worker's only view of whether the driver walked away from the
/// car or is heading back (server `jobs/extendTick.ts`, which ignores fixes
/// older than ten minutes). Also keeps the walking-distance-from-car figure
/// fresh.
///
/// It also runs for a park the server is holding until the phone leaves
/// the car (FR-55): these fixes are how the server sees the walk-away
/// (and asks) and the return (and ends the session). The server's answer
/// to each report says where the park or session stands; `onResponse`
/// hands it on. What the app itself saw (on foot after the park; the
/// car's audio back, or driving) rides on the next report as its `event`.
///
/// `left_car` is what starts a Pay tapped at the car (#226), so it goes
/// only with a fix that can show it: measured since the park, at walking
/// pace, while motion still has the driver on foot. It is said again until
/// the server's answer shows it took it. `returned_to_car` goes with the
/// fix that best shows where the phone was when it got back in the car.
///
/// It must keep working with the app in a pocket: updates never auto-pause
/// (iOS pauses a still phone and then never resumes in the background),
/// background delivery is on with Always, and a CLBackgroundActivitySession
/// holds the app while it reports.
@MainActor
@Observable
final class LocationReporter: NSObject, CLLocationManagerDelegate {
    /// Report at least this often (the heartbeat, so a driver standing
    /// still doesn't go stale on the server).
    static let heartbeat: TimeInterval = 60
    /// …and sooner after moving this far, but not more often than
    /// `minInterval`.
    static let moveThresholdM: Double = 25
    static let minInterval: TimeInterval = 15
    /// A fix faster than this (CLLocation.speed) is a car moving, and
    /// never carries `left_car` (the server's MAX_WALK_MPS).
    static let walkingPaceMaxMps: Double = 3
    /// The server reads no fix blurrier than this (FIX_USABLE_ACCURACY_M).
    static let usableAccuracyM: Double = 65
    /// `returned_to_car` looks this far either side of the moment it was
    /// seen for the fix to send with it.
    static let returnFixWindow: TimeInterval = 60
    /// Fixes kept for that choice.
    static let recentFixesKept: TimeInterval = 5 * 60
    /// The server reads no fix measured longer ago than five minutes
    /// (LIFECYCLE_FIX_MAX_AGE_MS); this leaves a minute for the trip.
    static let readableFixMaxAge: TimeInterval = 4 * 60

    /// Fresh distance to the car, meters.
    @ObservationIgnored var onDistance: ((Double) -> Void)?
    /// The server says there is no active session any more (it expired,
    /// or was stopped elsewhere): stop reporting and drop it locally.
    @ObservationIgnored var onSessionEnded: (() -> Void)?
    /// The server's answer to a report: the walk-away prompt, a session
    /// started or ended, a waiting park cancelled.
    @ObservationIgnored var onResponse: ((LocationResponse) async -> Void)?
    /// Whether motion still has the driver on foot. A `left_car` not yet
    /// taken is dropped once it doesn't (back in the car, or standing
    /// still); the next walk says it again. Nil: not checked (tests).
    @ObservationIgnored var stillOnFoot: (() -> Bool)?

    /// What the app saw of the phone and the car (LocationReport.event).
    enum PhoneEvent: String, Sendable {
        case leftCar = "left_car"
        case returnedToCar = "returned_to_car"
    }

    private(set) var isRunning = false
    private(set) var lastReport: (at: Date, fix: ParkFix)?
    /// The park the server is holding for its walk-away, while it waits:
    /// Home shows it passively, and its prompt lands on it.
    private(set) var waiting: ParkedNotice.Waiting?

    @ObservationIgnored private let locationManager = CLLocationManager()
    @ObservationIgnored private var backgroundSession: CLBackgroundActivitySession?
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored private var lastFix: ParkFix?
    @ObservationIgnored private var carCoordinate: CLLocationCoordinate2D?
    @ObservationIgnored private var send: ((LocationReport) async throws -> LocationResponse)?
    @ObservationIgnored private var inFlight = false
    /// Seen by the app, not yet delivered with a report.
    @ObservationIgnored private var pendingEvent: PhoneEvent?
    /// When it was seen (a drive dates from its start).
    @ObservationIgnored private var pendingEventAt: Date?
    /// It already rode on a report the server didn't take it from.
    @ObservationIgnored private var pendingEventTried = false
    /// The last few minutes of fixes, oldest first.
    @ObservationIgnored private var recentFixes: [ParkFix] = []
    /// When a usable fix last had the phone within reach of the car (the
    /// server's AT_CAR_RADIUS_M): a walk older than it is over.
    @ObservationIgnored private(set) var lastNearCarAt: Date?
    static let nearCarM: Double = 30
    @ObservationIgnored private var capabilities = DetectionCapabilities()
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let usesSystemLocation: Bool

    /// A UI test walks by hand (the simulator's own location is wherever
    /// Xcode left it, usually far from the fixture car); the detector's
    /// route test drives the real thing.
    static var systemLocationByDefault: Bool {
        #if DEBUG
        !LaunchOverrides.uiTesting || LaunchOverrides.detectorSimulation
        #else
        true
        #endif
    }

    /// `usesSystemLocation: false` for unit tests, which feed fixes by hand.
    init(now: @escaping () -> Date = { Date() }, usesSystemLocation: Bool = LocationReporter.systemLocationByDefault) {
        self.now = now
        self.usesSystemLocation = usesSystemLocation
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        locationManager.distanceFilter = 10
        locationManager.activityType = .fitness
        locationManager.pausesLocationUpdatesAutomatically = false
    }

    func start(api: any APIClient, carCoordinate: CLLocationCoordinate2D?, waiting: ParkedNotice.Waiting? = nil) {
        start(send: { try await api.reportParkLocation($0) }, carCoordinate: carCoordinate, waiting: waiting)
    }

    func start(
        send: @escaping (LocationReport) async throws -> LocationResponse,
        carCoordinate: CLLocationCoordinate2D?,
        waiting: ParkedNotice.Waiting? = nil
    ) {
        stop()
        self.send = send
        self.carCoordinate = carCoordinate
        setWaiting(waiting)
        isRunning = true
        if usesSystemLocation { startUpdates() }
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.heartbeat))
                guard let self, !Task.isCancelled else { return }
                await self.heartbeatDue()
            }
        }
    }

    func stop() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        if usesSystemLocation {
            locationManager.stopUpdatingLocation()
            locationManager.allowsBackgroundLocationUpdates = false
        }
        backgroundSession?.invalidate()
        backgroundSession = nil
        send = nil
        lastFix = nil
        lastReport = nil
        recentFixes = []
        lastNearCarAt = nil
        clearPendingEvent()
        setWaiting(nil)
        isRunning = false
    }

    /// The waiting park, kept on disk with it (see ParkedNotice.Waiting).
    func setWaiting(_ waiting: ParkedNotice.Waiting?) {
        self.waiting = waiting
        ParkedNotice.storeWaiting(waiting)
    }

    /// Report the freshest fix now, for the server's current answer (a
    /// prompt that was just re-quoted).
    func refresh() async {
        guard isRunning, let fix = lastFix else { return }
        await report(fix)
    }

    /// The app saw the phone leave the car, or come back to it, at `seenAt`
    /// (now when nil). Sent at once with a fix that can carry it, or with
    /// the next one; the server decides what it means from where that fix
    /// is.
    /// False when the event wasn't taken up (not reporting, or a walk that
    /// arrived while a return is still to be said): whoever told it tells
    /// it again later.
    @discardableResult
    func note(_ event: PhoneEvent, at seenAt: Date? = nil) async -> Bool {
        guard isRunning else { return false }
        // Back in the car, not yet said: a walk told meanwhile (a wake, a
        // stale reading) must not replace it. Sent with the fix at the
        // car, it could start a confirmed park as the car pulls away.
        if event == .leftCar, pendingEvent == .returnedToCar, !pendingEventTried { return false }
        pendingEvent = event
        pendingEventAt = seenAt ?? now()
        pendingEventTried = false
        guard let fix = lastFix, canCarry(event, fix) else { return true }
        await report(fix)
        return true
    }

    private func clearPendingEvent() {
        pendingEvent = nil
        pendingEventAt = nil
        pendingEventTried = false
    }

    /// Whether `fix` can say `event` to the server. A `left_car` with a fix
    /// measured before the park is read as nothing at all (CoreLocation's
    /// first fix after a start is often a cached one), and one at driving
    /// speed is a car pulling away.
    private func canCarry(_ event: PhoneEvent, _ fix: ParkFix) -> Bool {
        switch event {
        case .returnedToCar:
            // The first try goes with the best fix there is; a try again
            // (the first fix couldn't be read) only with one that can be.
            return !pendingEventTried || readable(fix)
        case .leftCar:
            if let parkedAt = waiting?.parkedAt, fix.at < parkedAt { return false }
            return (fix.speed ?? 0) <= Self.walkingPaceMaxMps
        }
    }

    /// Whether the server's answer shows it took the event. A `left_car`
    /// the park still waits at the car after (refused at the car's door)
    /// is said again with the next fix.
    ///
    /// A `returned_to_car` whose fix the server couldn't read (measured too
    /// long ago: a drive's start reaches the app a minute or two late, and
    /// the fix is from around then; or too blurry) is said again with the
    /// next fix that can be, unless the answer already ended the session
    /// or closed the park. A readable fix the server judged (far from the
    /// car, say) is its answer.
    private func taken(_ event: PhoneEvent, by response: LocationResponse, sent: ParkFix) -> Bool {
        let ours = waiting.flatMap { waiting in
            response.park.flatMap { $0.parkedEventId == waiting.response.parkedEventId ? $0 : nil }
        }
        switch event {
        case .leftCar:
            guard let park = ours else { return true }
            return park.status != "at_car" && park.status != "confirmed"
        case .returnedToCar:
            if response.ended != nil { return true }
            if let park = ours, !Self.openParkStatuses.contains(park.status) { return true }
            return readable(sent)
        }
    }

    private static let openParkStatuses: Set<String> = ["at_car", "prompted", "confirmed", "starting"]

    /// Measured recently enough, and sharp enough, for the server to read.
    private func readable(_ fix: ParkFix) -> Bool {
        now().timeIntervalSince(fix.at) <= Self.readableFixMaxAge && fix.accuracy <= Self.usableAccuracyM
    }

    /// The fix that best shows where the phone was when it got back in the
    /// car: the usable one measured nearest that moment (CoreMotion dates a
    /// drive from its start, while the phone was still at the car), else
    /// the sharpest around it, else the latest. A poor fix is still sent.
    private func returnFix(near moment: Date, latest: ParkFix) -> ParkFix {
        let around = recentFixes.filter { abs($0.at.timeIntervalSince(moment)) <= Self.returnFixWindow }
        let gap = { (fix: ParkFix) in abs(fix.at.timeIntervalSince(moment)) }
        if let usable = around.filter({ $0.accuracy <= Self.usableAccuracyM }).min(by: { gap($0) < gap($1) }) {
            return usable
        }
        return around.min { $0.accuracy < $1.accuracy } ?? latest
    }

    private func remember(_ fix: ParkFix) {
        lastFix = fix
        if let car = carCoordinate, fix.accuracy <= Self.usableAccuracyM,
           fix.distance(to: ParkFix(coordinate: car, accuracy: 0, at: fix.at)) <= Self.nearCarM {
            lastNearCarAt = max(lastNearCarAt ?? fix.at, fix.at)
        }
        recentFixes.append(fix)
        let since = fix.at.addingTimeInterval(-Self.recentFixesKept)
        recentFixes.removeAll { $0.at < since }
    }

    func capabilitiesChanged(_ capabilities: DetectionCapabilities) {
        self.capabilities = capabilities
        guard isRunning, usesSystemLocation else { return }
        startUpdates()
    }

    private func startUpdates() {
        guard capabilities.locationUsable else {
            locationManager.stopUpdatingLocation()
            return
        }
        // Background delivery only with Always; While Using carries on
        // behind the background activity session begun while open.
        locationManager.allowsBackgroundLocationUpdates = capabilities.location == .always
        locationManager.showsBackgroundLocationIndicator = false
        if backgroundSession == nil { backgroundSession = CLBackgroundActivitySession() }
        locationManager.startUpdatingLocation()
    }

    // MARK: - Reporting

    /// One fix from CoreLocation (or a test).
    func handle(_ fix: ParkFix) async {
        guard isRunning, fix.accuracy > 0 else { return }
        remember(fix)
        if let car = carCoordinate {
            onDistance?(fix.distance(to: ParkFix(coordinate: car, accuracy: 0, at: fix.at)))
        }
        guard let last = lastReport else {
            await report(fix)
            return
        }
        let elapsed = now().timeIntervalSince(last.at)
        let moved = fix.distance(to: last.fix)
        // An event held for a fix that can carry it goes with the first
        // one; one the server didn't take, at the usual pace.
        let eventDue = pendingEvent.map { canCarry($0, fix) && (!pendingEventTried || elapsed >= Self.minInterval) } ?? false
        if eventDue || elapsed >= Self.heartbeat || (moved >= Self.moveThresholdM && elapsed >= Self.minInterval) {
            await report(fix)
        }
    }

    /// Standing still produces no fixes (distance filter); resend the last
    /// one as "still here" so the worker's view doesn't age out.
    func heartbeatDue() async {
        guard let fix = lastFix else { return }
        // No location any more (revoked): "still here" would be a guess.
        guard !usesSystemLocation || capabilities.locationUsable else { return }
        if let last = lastReport, now().timeIntervalSince(last.at) < Self.heartbeat - 1 { return }
        await report(fix)
    }

    private func report(_ fix: ParkFix) async {
        guard let send, !inFlight else { return }
        inFlight = true
        defer { inFlight = false }
        let at = now()
        if pendingEvent == .leftCar, let stillOnFoot, !stillOnFoot() {
            // Back in the car, or standing: no walk-away to tell any more.
            clearPendingEvent()
        }
        var sent = fix
        if pendingEvent == .returnedToCar, !pendingEventTried {
            sent = returnFix(near: pendingEventAt ?? at, latest: fix)
        }
        let event = pendingEvent.flatMap { canCarry($0, sent) ? $0 : nil }
        do {
            let response = try await send(LocationReport(
                lat: sent.latitude, lng: sent.longitude, accuracy: sent.accuracy, ts: at,
                // Never later than the report itself (a fix stamped ahead
                // of this clock is still measured by now).
                measuredAt: min(sent.at, at), event: event?.rawValue,
                speedMps: sent.speed.flatMap { $0 >= 0 && $0.isFinite ? $0 : nil }
            ))
            lastReport = (at, sent)
            if let event, pendingEvent == event {
                // Delivered, unless the answer says otherwise; one seen
                // meanwhile waits for the next report.
                if taken(event, by: response, sent: sent) { clearPendingEvent() } else { pendingEventTried = true }
            }
            await onResponse?(response)
        } catch APIError.refused(code: "no_active_session") {
            // The worker expired it, it was stopped from another device,
            // or the park that was waiting is over.
            onSessionEnded?()
        } catch {
            // Transient; the next fix or heartbeat tries again (and the
            // event with it).
        }
    }

    #if DEBUG
    /// UI tests only: a fix reported at once, whatever the cadence says
    /// (the simulator has nowhere to walk).
    func report(now fix: ParkFix) async {
        guard isRunning else { return }
        remember(fix)
        await report(fix)
    }
    #endif

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let fix = ParkFix(location)
        Task { @MainActor in await self.handle(fix) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        // Keep running; fixes resume when CoreLocation recovers.
    }
}
