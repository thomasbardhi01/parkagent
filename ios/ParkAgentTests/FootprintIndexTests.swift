import CoreLocation
import Foundation
import Testing

@testable import ParkAgent

/// Garage and lot outlines on the phone: a linear scan over a JSON list,
/// and the per-2-km-cell cache the list is fetched into (the fetch itself
/// is wired to GET /garages/near after WS-2 #174; here it's injected).
@MainActor
struct FootprintIndexTests {
    typealias Geo = PlaceClassifierTests.Geo

    static let garage = PlaceClassifierTests.garage

    // MARK: - Geometry

    @Test func containmentDistanceAndEntrances() {
        let garage = Self.garage
        #expect(garage.contains(Geo.at(n: 0, e: 0)))
        #expect(garage.contains(Geo.at(n: 29, e: 39)))
        #expect(!garage.contains(Geo.at(n: 31, e: 0)))
        #expect(garage.distanceM(from: Geo.at(n: 0, e: 0)) == 0, "Inside is zero away")
        #expect(abs(garage.distanceM(from: Geo.at(n: 50, e: 0)) - 20) < 0.5)
        #expect(abs(garage.distanceToEdgeM(from: Geo.at(n: 0, e: 0)) - 30) < 0.5)
        #expect(abs(garage.distanceToEdgeM(from: Geo.at(n: 0, e: -37)) - 3) < 0.5)
        #expect(abs((garage.nearestEntranceM(from: Geo.at(n: 42, e: 0)) ?? -1) - 12) < 0.5)
        var noEntrances = garage
        noEntrances.entrances = []
        #expect(noEntrances.nearestEntranceM(from: Geo.at(n: 42, e: 0)) == nil)
    }

    @Test func theLinearIndexAnswersWithinTheRadius() {
        let far = Footprint(
            id: "far", name: nil, kind: .surface, fee: true, access: nil,
            polygon: Geo.box(n: 0, e: 500, w: 40, h: 40), entrances: []
        )
        let index = LinearFootprintIndex(footprints: [Self.garage, far])
        #expect(index.footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).map(\.id) == ["test-garage"])
        // 230 m from the garage's east wall, 210 m from the far lot.
        #expect(index.footprints(near: Geo.at(n: 0, e: 270), radiusM: 250).map(\.id).sorted() == ["far", "test-garage"])
    }

    /// The traces' shared fixture decodes, with every kind the server sends.
    @Test func theFixtureIndexLoads() throws {
        let url = try #require(Bundle(for: BundleMarker.self).url(forResource: "footprints", withExtension: "json"))
        let index = try LinearFootprintIndex(json: Data(contentsOf: url))
        #expect(index.footprints.count >= 3)
        #expect(Set(index.footprints.map(\.kind)).isSuperset(of: [.multiStorey, .underground, .surface]))
    }

    // MARK: - The cell cache

    @MainActor
    final class FakeFetch {
        var calls: [(CLLocationCoordinate2D, Double)] = []
        var answer: [Footprint] = []
        var fails = false
        func fetch(_ center: CLLocationCoordinate2D, _ radius: Double) async throws -> [Footprint] {
            calls.append((center, radius))
            if fails { throw URLError(.notConnectedToInternet) }
            return answer
        }
    }

    final class Clock: @unchecked Sendable {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
    }

    func tempDir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    @Test func cellsAreTwoKilometersAndStable() {
        let a = FootprintCellCache.cell(for: Geo.at(n: 0, e: 0))
        #expect(FootprintCellCache.cell(for: Geo.at(n: 0, e: 0)) == a)
        #expect(FootprintCellCache.cell(for: Geo.at(n: 2_500, e: 0)) != a)
        #expect(FootprintCellCache.cell(for: Geo.at(n: 0, e: 2_500)) != a)
        // The cell's center is inside the cell.
        #expect(FootprintCellCache.cell(for: FootprintCellCache.center(of: a)) == a)
    }

    @Test func aCellIsFetchedOnceAndServedFromDisk() async {
        let fake = FakeFetch()
        fake.answer = [Self.garage]
        let clock = Clock()
        let dir = tempDir()
        let cache = FootprintCellCache(directory: dir, fetch: fake.fetch, now: { clock.now })
        #expect(cache.footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).isEmpty, "Nothing before a fetch")

        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        await cache.prefetch(around: Geo.at(n: 50, e: 50))
        #expect(fake.calls.count == 1, "Same cell, still fresh: one fetch")
        #expect(fake.calls.first?.1 ?? 0 >= 1_414, "The fetch covers the whole cell")
        #expect(cache.footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).map(\.id) == ["test-garage"])

        // A new process reads the cell back from disk without fetching.
        let reopened = FootprintCellCache(directory: dir, fetch: fake.fetch, now: { clock.now })
        #expect(reopened.footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).map(\.id) == ["test-garage"])
        #expect(fake.calls.count == 1)
    }

    @Test func aStaleCellIsRefetchedAndAFailedFetchKeepsTheOldOne() async {
        let fake = FakeFetch()
        fake.answer = [Self.garage]
        let clock = Clock()
        let cache = FootprintCellCache(directory: tempDir(), fetch: fake.fetch, now: { clock.now })
        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        clock.now = clock.now.addingTimeInterval(FootprintCellCache.freshFor + 60)
        fake.fails = true
        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        #expect(fake.calls.count == 2)
        #expect(cache.footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).map(\.id) == ["test-garage"],
                "Offline: the old outlines beat none")
    }

    /// Until the fetch is wired (after WS-2 #174), the cache is empty and
    /// quiet: no request, no error, nothing classified from footprints.
    @Test func withoutAFetchNothingHappens() async {
        let cache = FootprintCellCache(directory: tempDir())
        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        #expect(cache.footprints(near: Geo.at(n: 0, e: 0), radiusM: 1_000).isEmpty)
    }

    /// A car near a cell's corner sees the garage across the line.
    @Test func aQueryNearACellEdgeReadsTheNeighboringCell() async {
        let fake = FakeFetch()
        let cache = FootprintCellCache(directory: tempDir(), fetch: fake.fetch)
        let here = Geo.at(n: 0, e: 0)
        let cell = FootprintCellCache.cell(for: here)
        // Find a point 60 m away that lands in the next cell north.
        let north = (1...2_100).lazy.map { Geo.at(n: Double($0), e: 0) }.first { FootprintCellCache.cell(for: $0) != cell }!
        let across = Footprint(
            id: "across", name: nil, kind: .surface, fee: true, access: nil,
            polygon: [[north.longitude - 0.0002, north.latitude + 0.0001], [north.longitude + 0.0002, north.latitude + 0.0001],
                      [north.longitude + 0.0002, north.latitude + 0.0004], [north.longitude - 0.0002, north.latitude + 0.0004],
                      [north.longitude - 0.0002, north.latitude + 0.0001]],
            entrances: []
        )
        fake.answer = [across]
        await cache.prefetch(around: north)
        let justSouth = CLLocationCoordinate2D(latitude: north.latitude - 20 / 111_320, longitude: north.longitude)
        #expect(FootprintCellCache.cell(for: justSouth) == cell)
        #expect(cache.footprints(near: justSouth, radiusM: 80).map(\.id) == ["across"])
    }
}
