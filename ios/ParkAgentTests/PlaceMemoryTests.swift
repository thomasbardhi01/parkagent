import CoreLocation
import Foundation
import Testing

@testable import ParkAgent

/// The driver's own places (home, work, a garage they use), kept on the
/// phone and changed only by what the driver confirms.
@MainActor
struct PlaceMemoryTests {
    typealias Geo = PlaceClassifierTests.Geo

    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func aPlaceIsSavedAfterTwoConfirmations() {
        var memory = PlaceMemory()
        memory.confirm(.nopay, at: Geo.at(n: 0, e: 0), name: "Home", now: t0)
        #expect(memory.place(near: Geo.at(n: 5, e: 0)) == nil, "One confirmation isn't a place yet")
        memory.confirm(.nopay, at: Geo.at(n: 10, e: 0), now: t0.addingTimeInterval(86_400))
        let place = memory.place(near: Geo.at(n: 5, e: 0))
        #expect(place?.placeClass == .nopay)
        #expect(place?.visits == 2)
        #expect(place?.name == "Home", "A later confirmation without a name keeps the name")
        #expect(place?.lastAt == t0.addingTimeInterval(86_400))
        #expect(place?.radiusM == 60)
    }

    @Test func confirmationsMoreThanSixtyMetersApartAreDifferentPlaces() {
        var memory = PlaceMemory()
        memory.confirm(.garage, at: Geo.at(n: 0, e: 0), now: t0)
        memory.confirm(.garage, at: Geo.at(n: 0, e: 90), now: t0)
        #expect(memory.places.count == 2)
        #expect(memory.place(near: Geo.at(n: 0, e: 0)) == nil)
        #expect(memory.place(near: Geo.at(n: 0, e: 90)) == nil)
    }

    /// The driver says a saved place is something else now: it goes back
    /// to one confirmation, so a single tap can't silently change what the
    /// phone does there.
    @Test func aConflictingConfirmationDemotesThePlace() {
        var memory = PlaceMemory()
        for day in 0..<3 {
            memory.confirm(.nopay, at: Geo.at(n: 0, e: 0), now: t0.addingTimeInterval(Double(day) * 86_400))
        }
        #expect(memory.place(near: Geo.at(n: 0, e: 0))?.placeClass == .nopay)
        memory.confirm(.lot, at: Geo.at(n: 3, e: 0), now: t0.addingTimeInterval(4 * 86_400))
        #expect(memory.place(near: Geo.at(n: 0, e: 0)) == nil)
        #expect(memory.places.count == 1)
        #expect(memory.places.first?.placeClass == .lot)
        #expect(memory.places.first?.visits == 1)
    }

    /// "Not my car" (a passenger in someone else's car) quiets that spot
    /// for two hours and teaches the memory nothing.
    @Test func notMyCarSuppressesForTwoHoursAndIsNotAPlace() {
        var memory = PlaceMemory()
        let spot = Geo.at(n: 0, e: 0)
        memory.notMyCar(at: spot, now: t0)
        memory.notMyCar(at: spot, now: t0.addingTimeInterval(60))
        #expect(memory.places.isEmpty)
        #expect(memory.place(near: spot) == nil)
        #expect(memory.isSuppressed(at: Geo.at(n: 40, e: 0), now: t0.addingTimeInterval(3_600)))
        #expect(!memory.isSuppressed(at: Geo.at(n: 100, e: 0), now: t0.addingTimeInterval(3_600)), "Only that spot")
        #expect(!memory.isSuppressed(at: spot, now: t0.addingTimeInterval(2 * 3_600 + 61)), "Two hours, not forever")
    }

    @Test func anUnknownClassIsNeverSaved() {
        var memory = PlaceMemory()
        memory.confirm(.unknown, at: Geo.at(n: 0, e: 0), now: t0)
        memory.confirm(.unknown, at: Geo.at(n: 0, e: 0), now: t0)
        #expect(memory.places.isEmpty)
    }

    /// The nearest of two overlapping saved places answers.
    @Test func theNearestSavedPlaceAnswers() {
        var memory = PlaceMemory()
        for _ in 0..<2 {
            memory.confirm(.nopay, at: Geo.at(n: 0, e: 0), now: t0)
            memory.confirm(.garage, at: Geo.at(n: 0, e: 70), now: t0)
        }
        #expect(memory.place(near: Geo.at(n: 0, e: 40))?.placeClass == .garage)
        #expect(memory.place(near: Geo.at(n: 0, e: 20))?.placeClass == .nopay)
    }

    /// A phone that parks everywhere doesn't grow the file forever: the
    /// least recently confirmed places go first.
    @Test func memoryKeepsItsMostRecentPlaces() {
        var memory = PlaceMemory()
        for i in 0..<(PlaceMemory.maxPlaces + 5) {
            memory.confirm(.street, at: Geo.at(n: Double(i) * 200, e: 0), now: t0.addingTimeInterval(Double(i)))
        }
        #expect(memory.places.count == PlaceMemory.maxPlaces)
        #expect(!memory.places.contains { $0.lastAt == t0 }, "The oldest was kept")
    }

    // MARK: - On disk

    @Test func theStoreSavesLoadsAndClears() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = PlaceMemoryStore(directory: dir)
        #expect(store.memory == PlaceMemory())
        store.update { $0.confirm(.nopay, at: Geo.at(n: 0, e: 0), name: "Home", now: t0) }
        store.update { $0.confirm(.nopay, at: Geo.at(n: 0, e: 0), now: t0) }

        let reopened = PlaceMemoryStore(directory: dir)
        #expect(reopened.memory.place(near: Geo.at(n: 0, e: 0))?.name == "Home")

        reopened.clear()
        #expect(reopened.memory.places.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: reopened.fileURL.path))
        #expect(PlaceMemoryStore(directory: dir).memory.places.isEmpty)
    }

    /// A damaged file is an empty memory, not a crash at launch.
    @Test func aDamagedFileIsAnEmptyMemory() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let store = PlaceMemoryStore(directory: dir)
        try Data("{not json".utf8).write(to: store.fileURL)
        #expect(PlaceMemoryStore(directory: dir).memory.places.isEmpty)
    }
}
