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

    // MARK: - Prompts already made (FR-54: never twice for a place in a day)

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    @Test func aPromptIsRememberedForTheDayWithinSixtyMeters() {
        var memory = PlaceMemory()
        #expect(!memory.promptedSameDay(at: Geo.at(n: 0, e: 0), now: t0, calendar: utc))
        memory.notePrompt(at: Geo.at(n: 0, e: 0), now: t0)
        #expect(memory.promptedSameDay(at: Geo.at(n: 50, e: 0), now: t0.addingTimeInterval(3_600), calendar: utc))
        #expect(!memory.promptedSameDay(at: Geo.at(n: 70, e: 0), now: t0.addingTimeInterval(3_600), calendar: utc))
        #expect(!memory.promptedSameDay(at: Geo.at(n: 0, e: 0), now: t0.addingTimeInterval(86_400), calendar: utc))
        // A prompt is not a place, and teaches nothing.
        #expect(memory.places.isEmpty)
        #expect(memory.place(near: Geo.at(n: 0, e: 0)) == nil)
    }

    /// A prompt held back and then cancelled (the car drove on) was never
    /// seen: the place can still be asked about that day.
    @Test func aCancelledPromptIsForgotten() {
        var memory = PlaceMemory()
        memory.notePrompt(at: Geo.at(n: 0, e: 0), now: t0)
        memory.notePrompt(at: Geo.at(n: 0, e: 500), now: t0)
        memory.forgetPrompt(at: Geo.at(n: 5, e: 0), since: t0.addingTimeInterval(-1))
        #expect(!memory.promptedSameDay(at: Geo.at(n: 0, e: 0), now: t0, calendar: utc))
        #expect(memory.promptedSameDay(at: Geo.at(n: 0, e: 500), now: t0, calendar: utc))
    }

    @Test func oldPromptsAreDroppedAndTheListStaysSmall() {
        var memory = PlaceMemory()
        for day in 0..<10 {
            memory.notePrompt(at: Geo.at(n: Double(day) * 500, e: 0), now: t0.addingTimeInterval(Double(day) * 86_400))
        }
        // Only what could still matter: the last two days.
        #expect((memory.prompts ?? []).count <= 3)
        #expect(memory.promptedSameDay(at: Geo.at(n: 4_500, e: 0), now: t0.addingTimeInterval(9 * 86_400 + 60), calendar: utc))
    }

    /// A memory file written before prompts were tracked still loads, with
    /// its saved places.
    @Test func aFileFromThePreviousBuildStillLoads() throws {
        var old = PlaceMemory()
        old.confirm(.nopay, at: Geo.at(n: 0, e: 0), now: t0)
        old.confirm(.nopay, at: Geo.at(n: 0, e: 0), now: t0)
        var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        json.removeValue(forKey: "prompts")
        let loaded = try JSONDecoder().decode(PlaceMemory.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(loaded.place(near: Geo.at(n: 0, e: 0))?.placeClass == .nopay)
        #expect(!loaded.promptedSameDay(at: Geo.at(n: 0, e: 0), now: t0, calendar: utc))
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
