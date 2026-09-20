import CoreLocation
import CoreMotion
import Foundation
import Observation

/// Requests and mirrors the two permissions the prototype needs. PR B asks
/// for when-in-use location; the Always upgrade ships with the background
/// detector in PR C.
@MainActor
@Observable
final class PermissionsManager: NSObject, CLLocationManagerDelegate {
    private let locationManager = CLLocationManager()
    private let motionManager = CMMotionActivityManager()

    var locationStatus: CLAuthorizationStatus = .notDetermined
    var motionStatus: CMAuthorizationStatus = CMMotionActivityManager.authorizationStatus()
    let motionAvailable = CMMotionActivityManager.isActivityAvailable()

    override init() {
        super.init()
        locationManager.delegate = self
        locationStatus = locationManager.authorizationStatus
    }

    var locationGranted: Bool {
        locationStatus == .authorizedWhenInUse || locationStatus == .authorizedAlways
    }

    var locationDenied: Bool {
        locationStatus == .denied || locationStatus == .restricted
    }

    func requestLocation() {
        locationManager.requestWhenInUseAuthorization()
    }

    /// There is no dedicated request API; a trivial query triggers the prompt.
    func requestMotion() {
        guard motionAvailable else { return }
        motionManager.queryActivityStarting(from: .now.addingTimeInterval(-60), to: .now, to: .main) { [weak self] _, _ in
            Task { @MainActor in
                self?.motionStatus = CMMotionActivityManager.authorizationStatus()
            }
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.locationStatus = status
        }
    }
}
