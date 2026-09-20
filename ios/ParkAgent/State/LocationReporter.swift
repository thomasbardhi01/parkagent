import CoreLocation
import Foundation
import Observation

/// While a session is active, streams background location and POSTs
/// /location every 60 seconds. Phase 7's extender consumes the feed; until
/// then the server 501s and the reporter quietly keeps its cadence. Also
/// keeps the walking-distance-from-car figure fresh.
@MainActor
@Observable
final class LocationReporter: NSObject, CLLocationManagerDelegate {
    static let interval: TimeInterval = 60

    /// Fresh distance to the persisted car coordinate, meters.
    var onDistance: ((Double) -> Void)?

    private let locationManager = CLLocationManager()
    private var reportTask: Task<Void, Never>?
    private var lastFix: (lat: Double, lng: Double, accuracy: Double)?
    private var carCoordinate: CLLocationCoordinate2D?
    private var api: (any APIClient)?

    override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        locationManager.pausesLocationUpdatesAutomatically = true
        locationManager.activityType = .fitness
    }

    func start(api: any APIClient, carCoordinate: CLLocationCoordinate2D?) {
        stop()
        self.api = api
        self.carCoordinate = carCoordinate

        // Background delivery needs the Always grant; with when-in-use the
        // feed simply pauses when the app does.
        if locationManager.authorizationStatus == .authorizedAlways {
            locationManager.allowsBackgroundLocationUpdates = true
        }
        locationManager.startUpdatingLocation()

        reportTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.interval))
                await self?.report()
            }
        }
    }

    func stop() {
        reportTask?.cancel()
        reportTask = nil
        locationManager.stopUpdatingLocation()
        api = nil
        lastFix = nil
    }

    private func report() async {
        guard let api, let fix = lastFix else { return }
        do {
            try await api.reportLocation(LocationReport(
                lat: fix.lat,
                lng: fix.lng,
                accuracy: fix.accuracy,
                ts: .now
            ))
        } catch {
            // 501 until Phase 7, and transient network errors are expected
            // on the move; next tick retries either way.
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        let latitude = location.coordinate.latitude
        let longitude = location.coordinate.longitude
        let accuracy = location.horizontalAccuracy
        Task { @MainActor in
            self.lastFix = (latitude, longitude, accuracy)
            if let car = self.carCoordinate {
                let here = CLLocation(latitude: latitude, longitude: longitude)
                let there = CLLocation(latitude: car.latitude, longitude: car.longitude)
                self.onDistance?(here.distance(from: there))
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        // Keep running; fixes resume when CoreLocation recovers.
    }
}
