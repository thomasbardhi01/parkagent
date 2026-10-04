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

    /// Fresh distance to the car, meters.
    @ObservationIgnored var onDistance: ((Double) -> Void)?
    /// The server says there is no active session any more (it expired,
    /// or was stopped elsewhere): stop reporting and drop it locally.
    @ObservationIgnored var onSessionEnded: (() -> Void)?
    /// The server's answer to a report: the walk-away prompt, a session
    /// started or ended, a waiting park cancelled.
    @ObservationIgnored var onResponse: ((LocationResponse) async -> Void)?

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
        pendingEvent = nil
        setWaiting(nil)
        isRunning = false
    }

    /// The waiting park, kept on disk with it (see ParkedNotice.Waiting).
    func setWaiting(_ waiting: ParkedNotice.Waiting?) {
        self.waiting = waiting
        ParkedNotice.storeWaiting(waiting)
    }

    /// The app saw the phone leave the car, or come back to it. Sent with
    /// the freshest fix at once, or with the next one when there is none
    /// yet; the server decides what it means from where that fix is.
    func note(_ event: PhoneEvent) async {
        guard isRunning else { return }
        pendingEvent = event
        if let fix = lastFix { await report(fix) }
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
        lastFix = fix
        if let car = carCoordinate {
            onDistance?(fix.distance(to: ParkFix(coordinate: car, accuracy: 0, at: fix.at)))
        }
        guard let last = lastReport else {
            await report(fix)
            return
        }
        let elapsed = now().timeIntervalSince(last.at)
        let moved = fix.distance(to: last.fix)
        if elapsed >= Self.heartbeat || (moved >= Self.moveThresholdM && elapsed >= Self.minInterval) {
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
        let event = pendingEvent
        do {
            let response = try await send(LocationReport(
                lat: fix.latitude, lng: fix.longitude, accuracy: fix.accuracy, ts: at, event: event?.rawValue
            ))
            lastReport = (at, fix)
            // Delivered; one seen meanwhile waits for the next report.
            if pendingEvent == event { pendingEvent = nil }
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
        lastFix = fix
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
