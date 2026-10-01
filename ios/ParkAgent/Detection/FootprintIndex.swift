import CoreLocation
import Foundation

/// A garage's or lot's outline, as the place classifier sees it. The
/// server's garages (WS-2, GET /garages/near) come from OSM
/// `amenity=parking`; street-side parking is a zone, never a footprint.
struct Footprint: Codable, Equatable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case multiStorey = "multi_storey"
        case underground, surface, rooftop, unknown

        /// A kind this build doesn't know is `unknown`, not a failure.
        init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }

        /// Somewhere the car drives into: GPS fades, ramps change level.
        var isStructure: Bool { self == .multiStorey || self == .underground || self == .rooftop }
    }

    var id: String
    var name: String?
    var kind: Kind
    /// OSM `fee`: true charges, false is free, nil nobody tagged it.
    var fee: Bool?
    /// OSM `access` ("private", "customers", …), nil when untagged.
    var access: String?
    /// The outer ring, GeoJSON [lng, lat] pairs.
    var polygon: [[Double]]
    /// Entrances, [lng, lat].
    var entrances: [[Double]]
    /// Rings cut out of the outline (a building in the middle of a lot);
    /// the server sends them only when there are some.
    var holes: [[[Double]]]? = nil
}

// MARK: - Geometry

extension Footprint {
    private static let metersPerDegree = 111_320.0

    /// Equirectangular meters east/north of `origin`: plenty for outlines
    /// a few hundred meters across.
    private static func project(_ pair: [Double], around origin: CLLocationCoordinate2D) -> (x: Double, y: Double)? {
        guard pair.count >= 2 else { return nil }
        let kx = metersPerDegree * cos(origin.latitude * .pi / 180)
        return ((pair[0] - origin.longitude) * kx, (pair[1] - origin.latitude) * metersPerDegree)
    }

    private typealias Ring = [(x: Double, y: Double)]

    private static func ring(_ pairs: [[Double]], around origin: CLLocationCoordinate2D) -> Ring {
        pairs.compactMap { project($0, around: origin) }
    }

    private func ring(around origin: CLLocationCoordinate2D) -> Ring {
        Self.ring(polygon, around: origin)
    }

    /// Ray cast from the origin (the point itself) along +x.
    private static func containsOrigin(_ ring: Ring) -> Bool {
        guard ring.count >= 3 else { return false }
        var inside = false
        var j = ring.count - 1
        for i in ring.indices {
            let a = ring[i], b = ring[j]
            if (a.y > 0) != (b.y > 0), 0 < (b.x - a.x) * (0 - a.y) / (b.y - a.y) + a.x {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    /// Meters from the origin to the ring's nearest side.
    private static func distanceToOrigin(_ ring: Ring) -> Double {
        guard ring.count >= 2 else { return .infinity }
        var best = Double.infinity
        for i in ring.indices {
            let a = ring[i], b = ring[(i + 1) % ring.count]
            let dx = b.x - a.x, dy = b.y - a.y
            let lengthSquared = dx * dx + dy * dy
            let t = lengthSquared > 0 ? max(0, min(1, -(a.x * dx + a.y * dy) / lengthSquared)) : 0
            let x = a.x + t * dx, y = a.y + t * dy
            best = min(best, (x * x + y * y).squareRoot())
        }
        return best
    }

    /// Inside the outline and not in one of its holes: the server's rule
    /// (garageLookup.describeFootprint), so both agree about an outline.
    func contains(_ point: CLLocationCoordinate2D) -> Bool {
        guard Self.containsOrigin(ring(around: point)) else { return false }
        return !(holes ?? []).contains { Self.containsOrigin(Self.ring($0, around: point)) }
    }

    /// Meters from the point to the outline's nearest side, a hole's
    /// included, inside or out.
    func distanceToEdgeM(from point: CLLocationCoordinate2D) -> Double {
        (holes ?? []).reduce(Self.distanceToOrigin(ring(around: point))) { best, hole in
            min(best, Self.distanceToOrigin(Self.ring(hole, around: point)))
        }
    }

    /// Zero inside; otherwise meters to the outline.
    func distanceM(from point: CLLocationCoordinate2D) -> Double {
        contains(point) ? 0 : distanceToEdgeM(from: point)
    }

    /// Meters to the nearest mapped entrance; nil when none is mapped.
    func nearestEntranceM(from point: CLLocationCoordinate2D) -> Double? {
        entrances.compactMap { Self.project($0, around: point) }
            .map { ($0.x * $0.x + $0.y * $0.y).squareRoot() }
            .min()
    }

    /// Square meters, to prefer the innermost of nested outlines.
    var areaM2: Double {
        guard let first = polygon.first, first.count >= 2 else { return 0 }
        let origin = CLLocationCoordinate2D(latitude: first[1], longitude: first[0])
        let ring = ring(around: origin)
        guard ring.count >= 3 else { return 0 }
        var twice = 0.0
        for i in ring.indices {
            let a = ring[i], b = ring[(i + 1) % ring.count]
            twice += a.x * b.y - b.x * a.y
        }
        return abs(twice) / 2
    }
}

// MARK: - Indexes

/// A footprint that may not decode: nil instead of failing the list it is
/// in (a JSON fixture, or a cell from GET /garages/near).
struct LossyFootprint: Decodable, Sendable {
    var footprint: Footprint?
    init(from decoder: any Decoder) throws {
        footprint = try? Footprint(from: decoder)
    }
}

/// Where the classifier finds garages and lots around a point.
@MainActor
protocol FootprintIndex {
    /// Every footprint whose outline comes within `radiusM` of the point.
    func footprints(near point: CLLocationCoordinate2D, radiusM: Double) -> [Footprint]
}

/// A plain list, scanned in full: a city's few hundred outlines around
/// the car don't need an R-tree.
struct LinearFootprintIndex: FootprintIndex {
    let footprints: [Footprint]

    init(footprints: [Footprint]) {
        self.footprints = footprints
    }

    /// A JSON array of footprints. One that won't decode is skipped rather
    /// than emptying the whole list.
    init(json: Data) throws {
        footprints = try JSONDecoder().decode([LossyFootprint].self, from: json).compactMap(\.footprint)
    }

    func footprints(near point: CLLocationCoordinate2D, radiusM: Double) -> [Footprint] {
        footprints.filter { $0.distanceM(from: point) <= radiusM }
    }
}

/// The garages and lots around the car, fetched a 2 km cell at a time and
/// kept on disk, so the classifier has them underground and offline, when
/// it needs them most.
///
/// The fetch is GET /garages/near around the cell's center (the app's
/// model hands it over once detection is armed), and ParkDetector calls
/// `prefetch(around:)` with the fixes of the drive. With no fetch (signed
/// out) the cache stays as it is, and the classifier works from place
/// memory and the sensors alone.
@MainActor
final class FootprintCellCache: FootprintIndex {
    struct Cell: Hashable, Sendable {
        var row: Int
        var col: Int
    }

    /// One cell as the server answered it.
    struct Fetched: Sendable {
        var footprints: [Footprint]
        /// The server had more outlines in reach than one call returns.
        var truncated: Bool
    }

    typealias Fetch = @MainActor (_ center: CLLocationCoordinate2D, _ radiusM: Double) async throws -> Fetched

    /// What a `prefetch` did, for the signal log.
    enum Prefetch: Equatable, Sendable {
        /// Nothing to do: no fetch wired, the cell is fresh, a fetch for it
        /// is already running, or one failed too recently to try again.
        case skipped
        case fetched(count: Int, truncated: Bool)
        case failed
    }

    static let cellSizeM = 2_000.0
    /// Outlines change slowly; a week-old cell is refetched when next near.
    static let freshFor: TimeInterval = 7 * 24 * 3_600
    /// A cell the server cut short is missing outlines: ask again after a day.
    static let truncatedFreshFor: TimeInterval = 24 * 3_600
    /// A failed fetch isn't tried again on the next fix: the drive delivers
    /// one a second, and the route allows sixty calls a minute.
    static let retryAfter: TimeInterval = 5 * 60

    private struct Stored: Codable {
        var fetchedAt: Date
        var footprints: [Footprint]
        /// Absent in a cell stored before truncation was tracked.
        var truncated: Bool?
    }

    let directory: URL
    var fetch: Fetch?
    private let now: @MainActor () -> Date
    private var loaded: [Cell: Stored] = [:]
    /// Cells with no file on disk, so a fix a second doesn't mean a file
    /// read a second.
    private var missing: Set<Cell> = []
    private var fetching: Set<Cell> = []
    private var failedAt: [Cell: Date] = [:]
    /// Bumped by `clear`, so a fetch still in the air can't write a cell
    /// back after sign-out.
    private var generation = 0

    init(directory: URL? = nil, fetch: Fetch? = nil, now: @escaping @MainActor () -> Date = { Date() }) {
        self.directory = directory
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("footprints")
        self.fetch = fetch
        self.now = now
    }

    private static let degreesPerCellLat = cellSizeM / 111_320

    private static func degreesPerCellLng(row: Int) -> Double {
        let latitude = (Double(row) + 0.5) * degreesPerCellLat
        return cellSizeM / (111_320 * max(0.01, cos(latitude * .pi / 180)))
    }

    static func cell(for point: CLLocationCoordinate2D) -> Cell {
        let row = Int(floor(point.latitude / degreesPerCellLat))
        return Cell(row: row, col: Int(floor(point.longitude / degreesPerCellLng(row: row))))
    }

    static func center(of cell: Cell) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: (Double(cell.row) + 0.5) * degreesPerCellLat,
            longitude: (Double(cell.col) + 0.5) * degreesPerCellLng(row: cell.row)
        )
    }

    func footprints(near point: CLLocationCoordinate2D, radiusM: Double) -> [Footprint] {
        // Every cell the circle can touch: the point's, and those reached
        // by stepping the radius (at most a cell) in each direction.
        let step = min(radiusM, Self.cellSizeM)
        let kx = 111_320 * cos(point.latitude * .pi / 180)
        var cells = Set<Cell>()
        for dy in [-step, 0, step] {
            for dx in [-step, 0, step] {
                cells.insert(Self.cell(for: CLLocationCoordinate2D(
                    latitude: point.latitude + dy / 111_320,
                    longitude: point.longitude + dx / kx
                )))
            }
        }
        var seen = Set<String>()
        return cells.flatMap { stored($0)?.footprints ?? [] }
            .filter { seen.insert($0.id).inserted && $0.distanceM(from: point) <= radiusM }
    }

    /// Fetch the point's cell if it's missing or stale. Failing (offline,
    /// refused) keeps whatever outlines the cell already had.
    @discardableResult
    func prefetch(around point: CLLocationCoordinate2D) async -> Prefetch {
        guard let fetch else { return .skipped }
        let cell = Self.cell(for: point)
        if let stored = stored(cell), now().timeIntervalSince(stored.fetchedAt) < Self.freshness(of: stored) {
            return .skipped
        }
        if let failed = failedAt[cell], now().timeIntervalSince(failed) < Self.retryAfter { return .skipped }
        guard fetching.insert(cell).inserted else { return .skipped }
        defer { fetching.remove(cell) }
        let started = generation
        // The circle around the cell's center that covers its corners.
        let radius = Self.cellSizeM * 2.0.squareRoot() / 2 + 1
        guard let fetched = try? await fetch(Self.center(of: cell), radius) else {
            if started == generation { failedAt[cell] = now() }
            return .failed
        }
        // Signed out while the request was in the air: keep nothing.
        guard started == generation else { return .skipped }
        failedAt[cell] = nil
        save(Stored(fetchedAt: now(), footprints: fetched.footprints, truncated: fetched.truncated), for: cell)
        return .fetched(count: fetched.footprints.count, truncated: fetched.truncated)
    }

    /// Whether the point's cell holds every outline the server had for it:
    /// false for one the server cut short, nil for a cell never fetched.
    func isComplete(around point: CLLocationCoordinate2D) -> Bool? {
        stored(Self.cell(for: point)).map { $0.truncated != true }
    }

    /// Sign-out: the cell files are named by where the phone has driven.
    func clear() {
        generation += 1
        loaded = [:]
        missing = []
        failedAt = [:]
        try? FileManager.default.removeItem(at: directory)
    }

    private static func freshness(of stored: Stored) -> TimeInterval {
        stored.truncated == true ? truncatedFreshFor : freshFor
    }

    private func fileURL(_ cell: Cell) -> URL {
        directory.appendingPathComponent("\(cell.row)_\(cell.col).json")
    }

    private func stored(_ cell: Cell) -> Stored? {
        if let cached = loaded[cell] { return cached }
        if missing.contains(cell) { return nil }
        guard let data = try? Data(contentsOf: fileURL(cell)),
              let stored = try? JSONDecoder().decode(Stored.self, from: data)
        else {
            missing.insert(cell)
            return nil
        }
        loaded[cell] = stored
        return stored
    }

    private func save(_ stored: Stored, for cell: Cell) {
        loaded[cell] = stored
        missing.remove(cell)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(stored) else { return }
        // Read by the detector in the background, often with the phone locked.
        try? data.write(to: fileURL(cell), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
