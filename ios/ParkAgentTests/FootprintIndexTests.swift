import CoreLocation
import Foundation
import Testing

@testable import ParkAgent

/// Garage and lot outlines on the phone: a linear scan over a JSON list,
/// and the per-2-km-cell cache the list is fetched into. The fetch is GET
/// /garages/near (AppModel passes it in; `LiveAPIRequestTests` pins the
/// request), injected here.
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

    /// A building in the middle of a lot is cut out of its outline (the
    /// server's `holes`): a fix there is not in the lot, on the phone as on
    /// the server.
    @Test func aPointInAHoleIsOutside() {
        var lot = Self.garage
        lot.holes = [Geo.box(n: 0, e: 0, w: 20, h: 20)]
        #expect(!lot.contains(Geo.at(n: 0, e: 0)), "In the hole")
        #expect(lot.contains(Geo.at(n: 20, e: 0)), "Between the hole and the wall")
        #expect(abs(lot.distanceM(from: Geo.at(n: 0, e: 0)) - 10) < 0.5, "Ten meters to the hole's edge")
        // 4 m from the hole, 16 m from the outer wall: the nearer edge.
        #expect(abs(lot.distanceToEdgeM(from: Geo.at(n: 14, e: 0)) - 4) < 0.5)
        // A footprint stored before holes existed still decodes.
        let old = #"{"id":"old","kind":"surface","polygon":[[0,0],[1,0],[1,1],[0,0]],"entrances":[]}"#
        #expect((try? JSONDecoder().decode(Footprint.self, from: Data(old.utf8)))?.holes == nil)
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
        var truncated = false
        var fails = false
        func fetch(_ center: CLLocationCoordinate2D, _ radius: Double) async throws -> FootprintCellCache.Fetched {
            calls.append((center, radius))
            if fails { throw URLError(.notConnectedToInternet) }
            return FootprintCellCache.Fetched(footprints: answer, truncated: truncated)
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

    /// Before anyone hands it a fetch (signed out, or a test), the cache is
    /// empty and quiet: no request, no error. The fetch can arrive later,
    /// which is how AppModel wires it once detection is armed.
    @Test func withoutAFetchNothingHappensAndOneCanBeSetLater() async {
        let cache = FootprintCellCache(directory: tempDir())
        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        #expect(cache.footprints(near: Geo.at(n: 0, e: 0), radiusM: 1_000).isEmpty)

        let fake = FakeFetch()
        fake.answer = [Self.garage]
        cache.fetch = fake.fetch
        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        #expect(fake.calls.count == 1)
        #expect(cache.footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).map(\.id) == ["test-garage"])
    }

    /// The server caps what one call returns and says so (`truncated`). A
    /// cut-short cell is still better than none, but it isn't trusted for a
    /// week: it is asked for again after a day.
    @Test func aTruncatedCellIsKeptButAskedForAgainSooner() async {
        let fake = FakeFetch()
        fake.answer = [Self.garage]
        fake.truncated = true
        let clock = Clock()
        let cache = FootprintCellCache(directory: tempDir(), fetch: fake.fetch, now: { clock.now })
        let here = Geo.at(n: 0, e: 0)
        await cache.prefetch(around: here)
        #expect(cache.footprints(near: here, radiusM: 100).map(\.id) == ["test-garage"])
        #expect(cache.isComplete(around: here) == false)

        clock.now = clock.now.addingTimeInterval(FootprintCellCache.truncatedFreshFor - 60)
        await cache.prefetch(around: here)
        #expect(fake.calls.count == 1, "Still within the day")

        clock.now = clock.now.addingTimeInterval(120)
        fake.truncated = false
        await cache.prefetch(around: here)
        #expect(fake.calls.count == 2, "A day on: asked again")
        #expect(cache.isComplete(around: here) == true)
        #expect(cache.isComplete(around: Geo.at(n: 5_000, e: 0)) == nil, "A cell never fetched is neither")
    }

    /// Driving hands the cache a fix a second. A fetch that fails (no
    /// signal, the server's rate limit) must not be tried again on every
    /// one of them.
    @Test func aFailedFetchWaitsBeforeTryingAgain() async {
        let fake = FakeFetch()
        fake.fails = true
        let clock = Clock()
        let cache = FootprintCellCache(directory: tempDir(), fetch: fake.fetch, now: { clock.now })
        let here = Geo.at(n: 0, e: 0)
        for _ in 0..<5 { await cache.prefetch(around: here) }
        #expect(fake.calls.count == 1)

        // Another cell is its own fetch, failed or not.
        await cache.prefetch(around: Geo.at(n: 5_000, e: 0))
        #expect(fake.calls.count == 2)

        clock.now = clock.now.addingTimeInterval(FootprintCellCache.retryAfter + 1)
        fake.fails = false
        fake.answer = [Self.garage]
        await cache.prefetch(around: here)
        #expect(fake.calls.count == 3)
        #expect(cache.footprints(near: here, radiusM: 100).map(\.id) == ["test-garage"])
    }

    /// The cells on disk are named by where the phone has driven: they go
    /// at sign-out with the rest of the account's detector state.
    @Test func clearingForgetsEveryCellInMemoryAndOnDisk() async throws {
        let fake = FakeFetch()
        fake.answer = [Self.garage]
        let dir = tempDir()
        let cache = FootprintCellCache(directory: dir, fetch: fake.fetch)
        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        await cache.prefetch(around: Geo.at(n: 5_000, e: 0))
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 2)

        cache.clear()
        #expect(cache.footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).isEmpty)
        #expect((try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.isEmpty ?? true)
        #expect(FootprintCellCache(directory: dir).footprints(near: Geo.at(n: 0, e: 0), radiusM: 100).isEmpty)
        // And it works again afterwards (the next account's drives).
        await cache.prefetch(around: Geo.at(n: 0, e: 0))
        #expect(fake.calls.count == 3)
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
