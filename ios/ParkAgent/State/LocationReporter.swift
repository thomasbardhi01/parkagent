import CoreLocation
import Foundation
import Observation

/// While a session is active, streams location and POSTs /location — the
/// extension worker's only view of whether the driver walked away from the
/// car or is heading back (server `jobs/extendTick.ts`, which ignores fixes
/// older than ten minutes). Also keeps the walking-distance-from-car figure
/// fresh.
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

    private(set) var isRunning = false
    private(set) var lastReport: (at: Date, fix: ParkFix)?

    @ObservationIgnored private let locationManager = CLLocationManager()
    @ObservationIgnored private var backgroundSession: CLBackgroundActivitySession?
    @ObservationIgnored private var heartbeatTask: Task<Void, Never>?
    @ObservationIgnored private var lastFix: ParkFix?
    @ObservationIgnored private var carCoordinate: CLLocationCoordinate2D?
    @ObservationIgnored private var send: ((LocationReport) async throws -> Void)?
    @ObservationIgnored private var inFlight = false
    @ObservationIgnored private var capabilities = DetectionCapabilities()
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let usesSystemLocation: Bool

    /// `usesSystemLocation: false` for unit tests, which feed fixes by hand.
    init(now: @escaping () -> Date = { Date() }, usesSystemLocation: Bool = true) {
        self.now = now
        self.usesSystemLocation = usesSystemLocation
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        locationManager.distanceFilter = 10
        locationManager.activityType = .fitness
        locationManager.pausesLocationUpdatesAutomatically = false
    }

    func start(api: any APIClient, carCoordinate: CLLocationCoordinate2D?) {
        start(send: { try await api.reportLocation($0) }, carCoordinate: carCoordinate)
    }

    func start(send: @escaping (LocationReport) async throws -> Void, carCoordinate: CLLocationCoordinate2D?) {
        stop()
        self.send = send
        self.carCoordinate = carCoordinate
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
        isRunning = false
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
        do {
            try await send(LocationReport(lat: fix.latitude, lng: fix.longitude, accuracy: fix.accuracy, ts: at))
            lastReport = (at, fix)
        } catch APIError.refused(code: "no_active_session") {
            // The worker expired it, or it was stopped from another device.
            onSessionEnded?()
        } catch {
            // Transient; the next fix or heartbeat tries again.
        }
    }

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
