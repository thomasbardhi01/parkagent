import CoreLocation

/// Which curb line a tap on the map means. Pure geometry, so it is unit
/// tested without a map.
///
/// Distance is to the nearest SEGMENT, not the nearest vertex: the server
/// simplifies centerlines to ~2 m, which leaves a straight block with a
/// vertex only at each end. Measured on the dev data, 80% of NYC curb
/// segments are longer than 54 m, so a vertex test with a ~27 m tolerance
/// ignored taps along most of every block.
enum CurbHitTest {
    /// The zone whose line passes closest to `tap`, if any is within
    /// `toleranceM` metres.
    static func nearestZone(
        to tap: CLLocationCoordinate2D,
        in zones: [NearbyZone],
        toleranceM: Double
    ) -> NearbyZone? {
        var best: (zone: NearbyZone, metres: Double)?
        for zone in zones {
            for line in zone.polylines {
                let metres = distanceM(from: tap, to: line)
                if metres <= toleranceM, metres < (best?.metres ?? .greatestFiniteMagnitude) {
                    best = (zone, metres)
                }
            }
        }
        return best?.zone
    }

    /// Metres from `point` to the closest spot on `polyline`. Uses a local
    /// equirectangular projection around `point` — exact enough across the
    /// few hundred metres a tap tolerance spans.
    static func distanceM(from point: CLLocationCoordinate2D, to polyline: [CLLocationCoordinate2D]) -> Double {
        let metresPerDegreeLat = 111_320.0
        let metresPerDegreeLng = metresPerDegreeLat * cos(point.latitude * .pi / 180)
        func project(_ c: CLLocationCoordinate2D) -> (x: Double, y: Double) {
            ((c.longitude - point.longitude) * metresPerDegreeLng, (c.latitude - point.latitude) * metresPerDegreeLat)
        }
        let projected = polyline.map(project)
        guard let first = projected.first else { return .greatestFiniteMagnitude }
        guard projected.count > 1 else { return (first.x * first.x + first.y * first.y).squareRoot() }

        var best = Double.greatestFiniteMagnitude
        for (a, b) in zip(projected, projected.dropFirst()) {
            // The tap is the origin; clamp its projection onto a→b.
            let dx = b.x - a.x
            let dy = b.y - a.y
            let lengthSquared = dx * dx + dy * dy
            let t = lengthSquared == 0 ? 0 : max(0, min(1, -(a.x * dx + a.y * dy) / lengthSquared))
            let x = a.x + t * dx
            let y = a.y + t * dy
            best = min(best, (x * x + y * y).squareRoot())
        }
        return best
    }
}
