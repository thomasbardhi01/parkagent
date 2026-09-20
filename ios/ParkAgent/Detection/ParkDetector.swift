import AVFoundation
import CoreLocation
import CoreMotion
import Foundation
import Observation

/// Detects "the car just parked" from three independent signals:
///
/// 1. Motion: CoreMotion reports automotive → stationary/walking.
/// 2. Location: a burst fix settles (the resting coordinate).
/// 3. Audio: the car's Bluetooth/CarPlay audio route disconnects.
///
/// A park fires when two of the three land within 60 seconds of each other,
/// at most once every 3 minutes. The location burst is started by either of
/// the other signals so the fix is fresh at the moment we need it.
@MainActor
@Observable
final class ParkDetector: NSObject, CLLocationManagerDelegate {
    static let agreementWindow: TimeInterval = 60
    static let debounce: TimeInterval = 3 * 60

    /// Fires with the resting fix and the signal names for /parked.
    var onPark: ((CLLocationCoordinate2D, Double, [String]) -> Void)?

    private(set) var isRunning = false

    private let motionManager = CMMotionActivityManager()
    private let locationManager = CLLocationManager()
    private var routeChangeObserver: (any NSObjectProtocol)?

    private var wasDriving = false
    private var lastMotionStop: Date?
    private var lastAudioDisconnect: Date?
    private var lastFix: (coordinate: CLLocationCoordinate2D, accuracy: Double, at: Date)?
    private var lastFired: Date?

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true

        // Detection needs fixes after the app is backgrounded; ask for the
        // Always upgrade once the when-in-use grant from onboarding exists.
        if locationManager.authorizationStatus == .authorizedWhenInUse {
            locationManager.requestAlwaysAuthorization()
        }

        if CMMotionActivityManager.isActivityAvailable() {
            motionManager.startActivityUpdates(to: .main) { [weak self] activity in
                guard let activity else { return }
                let driving = activity.automotive && activity.confidence != .low
                let stopped = activity.stationary || activity.walking
                Task { @MainActor in
                    self?.handleMotion(driving: driving, stopped: stopped)
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
                let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            else { return }
            let carPorts: Set<AVAudioSession.Port> = [.carAudio, .bluetoothA2DP, .bluetoothHFP]
            let wasCar = previous.outputs.contains { carPorts.contains($0.portType) }
            guard wasCar else { return }
            Task { @MainActor in
                self?.handleAudioDisconnect()
            }
        }
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        motionManager.stopActivityUpdates()
        if let routeChangeObserver {
            NotificationCenter.default.removeObserver(routeChangeObserver)
        }
        routeChangeObserver = nil
    }

    // MARK: - Signals

    private func handleMotion(driving: Bool, stopped: Bool) {
        if driving {
            wasDriving = true
            return
        }
        // Only the transition out of driving counts, not standing still
        // at a desk all day.
        guard wasDriving, stopped else { return }
        wasDriving = false
        lastMotionStop = .now
        requestBurstFix()
        evaluate()
    }

    private func handleAudioDisconnect() {
        lastAudioDisconnect = .now
        requestBurstFix()
        evaluate()
    }

    private func requestBurstFix() {
        locationManager.requestLocation()
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let latitude = location.coordinate.latitude
        let longitude = location.coordinate.longitude
        let accuracy = location.horizontalAccuracy
        Task { @MainActor in
            self.lastFix = (CLLocationCoordinate2D(latitude: latitude, longitude: longitude), accuracy, .now)
            self.evaluate()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        // A failed burst just means we fall back to the other two signals.
    }

    // MARK: - Decision

    private func evaluate() {
        let now = Date.now
        if let lastFired, now.timeIntervalSince(lastFired) < Self.debounce { return }

        var signals: [String] = []
        if let lastMotionStop, now.timeIntervalSince(lastMotionStop) <= Self.agreementWindow {
            signals.append("motion_stop")
        }
        if let lastAudioDisconnect, now.timeIntervalSince(lastAudioDisconnect) <= Self.agreementWindow {
            signals.append("audio_disconnect")
        }
        if let lastFix, now.timeIntervalSince(lastFix.at) <= Self.agreementWindow {
            signals.append("location_fix")
        }
        guard signals.count >= 2, let fix = lastFix else { return }

        lastFired = now
        lastMotionStop = nil
        lastAudioDisconnect = nil
        onPark?(fix.coordinate, fix.accuracy, signals)
    }
}
