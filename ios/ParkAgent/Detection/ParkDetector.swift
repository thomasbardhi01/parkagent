import AVFoundation
import CoreLocation
import CoreMotion
import Foundation
import Observation

/// Wires the system signal sources into `ParkFusionEngine` (which owns the
/// two-of-three rule, settling, and debounce — see that file):
///
/// - CMMotionActivityManager: automotive → stationary/walking transitions.
/// - AVAudioSession route changes: the car's CarPlay/Bluetooth output
///   disappearing (reason `oldDeviceUnavailable`) — the "car turned off"
///   proxy.
/// - CLLocationManager: a burst of high-accuracy fixes on demand, plus
///   significant-change monitoring so iOS relaunches the app (and re-arms
///   the detector via startBackgroundWork) after a terminate.
///
/// Missing permissions never crash detection — the remaining signals keep
/// running (two still suffice) — but are surfaced via `missingPermissions`
/// so Home can prompt for Settings.
@MainActor
@Observable
final class ParkDetector: NSObject, CLLocationManagerDelegate {
    /// What Home's banner needs to say; empty when fully armed.
    enum MissingPermission: String {
        case locationAlways = "Location (Always)"
        case motion = "Motion & Fitness"
    }

    /// Fires with the resting fix and the signal names for /parked.
    var onPark: ((CLLocationCoordinate2D, Double, [String]) -> Void)?

    private(set) var isRunning = false
    private(set) var missingPermissions: [MissingPermission] = []

    private let engine: ParkFusionEngine
    private let signalLog: SignalLog
    private let motionManager = CMMotionActivityManager()
    private let locationManager = CLLocationManager()
    private var routeChangeObserver: (any NSObjectProtocol)?
    private var burstDeadline: Task<Void, Never>?

    init(engine: ParkFusionEngine = ParkFusionEngine(), signalLog: SignalLog = .shared) {
        self.engine = engine
        self.signalLog = signalLog
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBest

        engine.onPark = { [weak self] fix, signals in
            self?.onPark?(fix.coordinate, fix.accuracy, signals)
        }
        engine.onStartBurst = { [weak self] in self?.startBurst() }
        engine.onStopBurst = { [weak self] in self?.stopBurst() }
        engine.onRawSignal = { [weak self] signal, at, detail in
            self?.signalLog.append(signal, at: at, detail: detail)
        }
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true

        // Detection needs fixes after the app is backgrounded; ask for the
        // Always upgrade once the when-in-use grant from onboarding exists.
        if locationManager.authorizationStatus == .authorizedWhenInUse {
            locationManager.requestAlwaysAuthorization()
        }
        // iOS relaunches the app on a significant move (~500 m); RootView
        // calls startBackgroundWork on every launch, so this is the re-arm
        // path after a terminate.
        locationManager.startMonitoringSignificantLocationChanges()

        if CMMotionActivityManager.isActivityAvailable() {
            motionManager.startActivityUpdates(to: .main) { [weak self] activity in
                guard let activity else { return }
                let driving = activity.automotive && activity.confidence != .low
                let stopped = activity.stationary || activity.walking
                Task { @MainActor in
                    self?.engine.motionEvent(driving: driving, stopped: stopped)
                }
            }
        }

        routeChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: nil
        ) { [weak self] note in
            guard
                let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable,
                let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey]
                    as? AVAudioSessionRouteDescription
            else { return }
            let carPorts: Set<AVAudioSession.Port> = [
                .carAudio, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
            ]
            let wasCar = previous.outputs.contains { carPorts.contains($0.portType) }
            guard wasCar else { return }
            Task { @MainActor in
                self?.engine.audioDisconnected()
            }
        }

        refreshPermissions()
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        motionManager.stopActivityUpdates()
        locationManager.stopMonitoringSignificantLocationChanges()
        stopBurst()
        if let routeChangeObserver {
            NotificationCenter.default.removeObserver(routeChangeObserver)
        }
        routeChangeObserver = nil
    }

    /// Recompute what Home's Settings banner should show. Detection keeps
    /// running on whatever signals remain (two of three still fire).
    func refreshPermissions() {
        var missing: [MissingPermission] = []
        if locationManager.authorizationStatus != .authorizedAlways {
            missing.append(.locationAlways)
        }
        if CMMotionActivityManager.isActivityAvailable(),
           CMMotionActivityManager.authorizationStatus() == .denied
            || CMMotionActivityManager.authorizationStatus() == .restricted {
            missing.append(.motion)
        }
        missingPermissions = missing
    }

    // MARK: - Location burst

    private func startBurst() {
        // Continuous updates (not requestLocation) so settling sees a run
        // of fixes; background delivery needs the Always grant.
        if locationManager.authorizationStatus == .authorizedAlways {
            locationManager.allowsBackgroundLocationUpdates = true
        }
        locationManager.startUpdatingLocation()
        // Belt and braces beside the engine's own timeout: never leave the
        // radio in high-accuracy mode more than two minutes.
        burstDeadline?.cancel()
        burstDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            guard !Task.isCancelled else { return }
            self?.stopBurst()
        }
    }

    private func stopBurst() {
        burstDeadline?.cancel()
        burstDeadline = nil
        locationManager.stopUpdatingLocation()
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        for location in locations where location.horizontalAccuracy >= 0 {
            let latitude = location.coordinate.latitude
            let longitude = location.coordinate.longitude
            let accuracy = location.horizontalAccuracy
            let at = location.timestamp
            Task { @MainActor in
                self.engine.fixReceived(ParkFix(
                    coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
                    accuracy: accuracy,
                    at: at
                ))
            }
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didFailWithError error: any Error
    ) {
        // A failed burst just means we fall back to the other two signals.
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            self.refreshPermissions()
        }
    }
}
