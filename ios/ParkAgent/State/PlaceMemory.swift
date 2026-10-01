import CoreLocation
import Foundation

/// The driver's own places — home, work, a garage they use — for the place
/// classifier's first and strongest answer (FR-53). It changes only when
/// the driver confirms what a place is (#179's correction call, never a
/// park on its own): a spot confirmed twice as the same class becomes a
/// saved place. "Not my car" quiets a spot for two hours and teaches it
/// nothing. It stays on the phone: /parked hears only that a saved place
/// matched, never its name or where it is.
struct PlaceMemory: Codable, Equatable, Sendable {
    struct Place: Codable, Equatable, Sendable, Identifiable {
        var id: UUID
        var latitude: Double
        var longitude: Double
        var radiusM: Double
        var placeClass: PlaceClass
        var name: String?
        /// Confirmations of this class here.
        var visits: Int
        var lastAt: Date

        var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
        var isSaved: Bool { visits >= PlaceMemory.confirmationsToSave }
    }

    struct Suppression: Codable, Equatable, Sendable {
        var latitude: Double
        var longitude: Double
        var until: Date
    }

    static let radiusM = 60.0
    static let confirmationsToSave = 2
    static let notMyCarFor: TimeInterval = 2 * 3_600
    static let maxPlaces = 50

    private(set) var places: [Place] = []
    private(set) var suppressions: [Suppression] = []

    /// The nearest saved place (two confirmations) within its radius.
    func place(near point: CLLocationCoordinate2D) -> Place? {
        places.filter(\.isSaved)
            .map { ($0, Self.distance($0.coordinate, point)) }
            .filter { $0.1 <= $0.0.radiusM }
            .min { $0.1 < $1.1 }?.0
    }

    /// The driver says this spot is `placeClass`. The same class again
    /// counts toward saving it (its center moves to the average); a
    /// different class starts it over at one confirmation, so one tap
    /// can't silently change what the phone does at a saved place.
    mutating func confirm(_ placeClass: PlaceClass, at point: CLLocationCoordinate2D, name: String? = nil, now: Date) {
        guard placeClass != .unknown else { return }
        let nearest = places.indices
            .map { ($0, Self.distance(places[$0].coordinate, point)) }
            .filter { $0.1 <= places[$0.0].radiusM }
            .min { $0.1 < $1.1 }?.0
        if let index = nearest {
            var place = places[index]
            if place.placeClass == placeClass {
                let weight = Double(place.visits)
                place.latitude = (place.latitude * weight + point.latitude) / (weight + 1)
                place.longitude = (place.longitude * weight + point.longitude) / (weight + 1)
                place.visits += 1
            } else {
                place.placeClass = placeClass
                place.latitude = point.latitude
                place.longitude = point.longitude
                place.visits = 1
            }
            if let name { place.name = name }
            place.lastAt = now
            places[index] = place
        } else {
            places.append(Place(
                id: UUID(), latitude: point.latitude, longitude: point.longitude, radiusM: Self.radiusM,
                placeClass: placeClass, name: name, visits: 1, lastAt: now
            ))
        }
        if places.count > Self.maxPlaces {
            places = Array(places.sorted { $0.lastAt > $1.lastAt }.prefix(Self.maxPlaces))
        }
    }

    /// "Not my car" (a passenger in someone else's): quiet this spot for
    /// two hours. Not a place, and nothing learned.
    mutating func notMyCar(at point: CLLocationCoordinate2D, now: Date) {
        suppressions.removeAll { $0.until <= now }
        suppressions.append(Suppression(
            latitude: point.latitude, longitude: point.longitude, until: now.addingTimeInterval(Self.notMyCarFor)
        ))
    }

    func isSuppressed(at point: CLLocationCoordinate2D, now: Date) -> Bool {
        suppressions.contains { suppression in
            suppression.until > now
                && Self.distance(CLLocationCoordinate2D(latitude: suppression.latitude, longitude: suppression.longitude), point) <= Self.radiusM
        }
    }

    private static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude).distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }
}

/// PlaceMemory on disk, in the app's Documents. Written only through
/// `update`; cleared at sign-out with the rest of the account's detector
/// state (ParkDetector.disarm).
@MainActor
final class PlaceMemoryStore {
    let fileURL: URL
    private(set) var memory: PlaceMemory

    init(directory: URL? = nil) {
        let dir = directory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = dir.appendingPathComponent("place-memory.json")
        // A missing or damaged file is an empty memory, not a failed launch.
        memory = (try? Data(contentsOf: fileURL)).flatMap { try? JSONDecoder().decode(PlaceMemory.self, from: $0) } ?? PlaceMemory()
    }

    func update(_ change: (inout PlaceMemory) -> Void) {
        change(&memory)
        guard let data = try? JSONEncoder().encode(memory) else { return }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Read by the detector in the background, often with the phone locked.
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func clear() {
        memory = PlaceMemory()
        try? FileManager.default.removeItem(at: fileURL)
    }
}
