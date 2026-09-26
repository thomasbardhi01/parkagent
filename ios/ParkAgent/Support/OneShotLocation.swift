import CoreLocation
import Foundation

/// One current-location fix for centering the map and detecting the city.
/// Takes the first fix accurate to `goodEnoughM`, or the best one seen when
/// `timeout` runs out (city detection is happy with a rough one). nil when
/// location isn't allowed or nothing arrived; the caller says so and
/// retries.
@MainActor
enum OneShotLocation {
    static func request(
        goodEnoughM: Double = 100,
        timeout: Duration = .seconds(10)
    ) async -> CLLocationCoordinate2D? {
        await requestLocation(goodEnoughM: goodEnoughM, timeout: timeout)?.coordinate
    }

    /// The fix itself, accuracy and time included (Diagnostics' self-test).
    static func requestLocation(
        goodEnoughM: Double = 100,
        timeout: Duration = .seconds(10)
    ) async -> CLLocation? {
        let status = CLLocationManager().authorizationStatus
        guard status == .authorizedWhenInUse || status == .authorizedAlways else { return nil }
        // The reader keeps the best fix so far; the timer cancels it, which
        // ends the updates and hands back that best one.
        let reader = Task { @MainActor () -> CLLocation? in
            var best: CLLocation?
            do {
                for try await update in CLLocationUpdate.liveUpdates() {
                    guard let location = update.location, location.horizontalAccuracy >= 0 else { continue }
                    if best.map({ location.horizontalAccuracy < $0.horizontalAccuracy }) ?? true { best = location }
                    if location.horizontalAccuracy <= goodEnoughM { return location }
                }
            } catch {}
            return best
        }
        let timer = Task {
            try? await Task.sleep(for: timeout)
            reader.cancel()
        }
        let location = await reader.value
        timer.cancel()
        return location
    }
}
