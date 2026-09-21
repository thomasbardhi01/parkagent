import CoreLocation
import CoreMotion
import Foundation
import Observation
import UserNotifications

/// Requests and mirrors the three permissions the prototype needs: Always
/// location (background park detection), motion activity (driving vs
/// walking), and notifications (paid/expiring alerts).
@MainActor
@Observable
final class PermissionsManager: NSObject, CLLocationManagerDelegate {
    private let locationManager = CLLocationManager()
    private let motionManager = CMMotionActivityManager()

    var locationStatus: CLAuthorizationStatus = .notDetermined
    var motionStatus: CMAuthorizationStatus = CMMotionActivityManager.authorizationStatus()
    var notificationStatus: UNAuthorizationStatus = .notDetermined
    let motionAvailable = CMMotionActivityManager.isActivityAvailable()

    override init() {
        super.init()
        locationManager.delegate = self
        locationStatus = locationManager.authorizationStatus
        Task { await refreshNotificationStatus() }
    }

    var locationGranted: Bool {
        locationStatus == .authorizedWhenInUse || locationStatus == .authorizedAlways
    }

    var locationDenied: Bool {
        locationStatus == .denied || locationStatus == .restricted
    }

    var motionDenied: Bool {
        motionAvailable && (motionStatus == .denied || motionStatus == .restricted)
    }

    var notificationsGranted: Bool {
        notificationStatus == .authorized || notificationStatus == .provisional
    }

    var notificationsDenied: Bool {
        notificationStatus == .denied
    }

    /// Detection needs Always; from notDetermined iOS shows the when-in-use
    /// prompt and upgrades provisionally, offering the Always prompt later.
    func requestLocation() {
        locationManager.requestAlwaysAuthorization()
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

    func requestNotifications() {
        Task {
            _ = try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            await refreshNotificationStatus()
        }
    }

    func refreshNotificationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationStatus = settings.authorizationStatus
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.locationStatus = status
        }
    }
}
