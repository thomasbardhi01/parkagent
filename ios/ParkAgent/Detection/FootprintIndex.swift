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

    private func ring(around origin: CLLocationCoordinate2D) -> [(x: Double, y: Double)] {
        polygon.compactMap { Self.project($0, around: origin) }
    }

    func contains(_ point: CLLocationCoordinate2D) -> Bool {
        let ring = ring(around: point)
        guard ring.count >= 3 else { return false }
        // Ray cast from the point (the origin) along +x.
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

    /// Meters from the point to the outline itself, inside or out.
    func distanceToEdgeM(from point: CLLocationCoordinate2D) -> Double {
        let ring = ring(around: point)
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
        footprints = try JSONDecoder().decode([Lossy].self, from: json).compactMap(\.footprint)
    }

    private struct Lossy: Decodable {
        var footprint: Footprint?
        init(from decoder: any Decoder) throws {
            footprint = try? Footprint(from: decoder)
        }
    }

    func footprints(near point: CLLocationCoordinate2D, radiusM: Double) -> [Footprint] {
        footprints.filter { $0.distanceM(from: point) <= radiusM }
    }
}

/// The garages and lots around the car, fetched a 2 km cell at a time and
/// kept on disk, so the classifier has them underground and offline, when
/// it needs them most.
///
/// Follow-up (after WS-2 #174 merges): the fetch is GET /garages/near
/// around the cell's center, passed in by ParkDetector's owner, and
/// `prefetch(around:)` runs on tracking fixes while driving. Until then
/// there's no fetch: the cache stays empty, and the classifier works from
/// place memory and the sensors alone.
@MainActor
final class FootprintCellCache: FootprintIndex {
    struct Cell: Hashable, Sendable {
        var row: Int
        var col: Int
    }

    typealias Fetch = @MainActor (_ center: CLLocationCoordinate2D, _ radiusM: Double) async throws -> [Footprint]

    static let cellSizeM = 2_000.0
    /// Outlines change slowly; a week-old cell is refetched when next near.
    static let freshFor: TimeInterval = 7 * 24 * 3_600

    private struct Stored: Codable {
        var fetchedAt: Date
        var footprints: [Footprint]
    }

    let directory: URL
    private let fetch: Fetch?
    private let now: @MainActor () -> Date
    private var loaded: [Cell: Stored] = [:]
    private var fetching: Set<Cell> = []

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
    func prefetch(around point: CLLocationCoordinate2D) async {
        guard let fetch else { return }
        let cell = Self.cell(for: point)
        if let stored = stored(cell), now().timeIntervalSince(stored.fetchedAt) < Self.freshFor { return }
        guard fetching.insert(cell).inserted else { return }
        defer { fetching.remove(cell) }
        // The circle around the cell's center that covers its corners.
        let radius = Self.cellSizeM * 2.0.squareRoot() / 2 + 1
        guard let footprints = try? await fetch(Self.center(of: cell), radius) else { return }
        save(Stored(fetchedAt: now(), footprints: footprints), for: cell)
    }

    private func fileURL(_ cell: Cell) -> URL {
        directory.appendingPathComponent("\(cell.row)_\(cell.col).json")
    }

    private func stored(_ cell: Cell) -> Stored? {
        if let cached = loaded[cell] { return cached }
        guard let data = try? Data(contentsOf: fileURL(cell)),
              let stored = try? JSONDecoder().decode(Stored.self, from: data)
        else { return nil }
        loaded[cell] = stored
        return stored
    }

    private func save(_ stored: Stored, for cell: Cell) {
        loaded[cell] = stored
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(stored) else { return }
        // Read by the detector in the background, often with the phone locked.
        try? data.write(to: fileURL(cell), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
