import CoreLocation
import Foundation
import Testing

@testable import ParkAgent

/// The place classifier (FR-53): what kind of place a park is, from the
/// driver's own saved places, the garage and lot footprints, and the
/// sensors, acting only when the best class beats the next by 0.3.
@MainActor
struct PlaceClassifierTests {
    /// Meters north/east of a fixed point, so the geometry reads as a map.
    enum Geo {
        static let origin = CLLocationCoordinate2D(latitude: 42.35038, longitude: -71.0763)

        static func at(n: Double, e: Double) -> CLLocationCoordinate2D {
            CLLocationCoordinate2D(
                latitude: origin.latitude + n / 111_320,
                longitude: origin.longitude + e / (111_320 * cos(origin.latitude * .pi / 180))
            )
        }

        /// A rectangle `w` wide and `h` tall centered `n`/`e` meters from the origin.
        static func box(n: Double, e: Double, w: Double, h: Double) -> [[Double]] {
            [(-1.0, -1.0), (1, -1), (1, 1), (-1, 1), (-1, -1)].map { sx, sy in
                let c = at(n: n + sy * h / 2, e: e + sx * w / 2)
                return [c.longitude, c.latitude]
            }
        }

        static func point(n: Double, e: Double) -> [Double] {
            let c = at(n: n, e: e)
            return [c.longitude, c.latitude]
        }

        static func fix(n: Double, e: Double, accuracy: Double = 8, speed: Double? = nil, at: Date = .init(timeIntervalSince1970: 1_800_000_000)) -> ParkFix {
            ParkFix(coordinate: Geo.at(n: n, e: e), accuracy: accuracy, at: at, speed: speed)
        }
    }

    static let stopAt = Date(timeIntervalSince1970: 1_800_000_000)

    /// A garage 80 × 60 m around the origin with its entrance on the north side.
    static let garage = Footprint(
        id: "test-garage", name: "Test Garage", kind: .multiStorey, fee: true, access: nil,
        polygon: Geo.box(n: 0, e: 0, w: 80, h: 60), entrances: [Geo.point(n: 30, e: 0)]
    )

    static func located(_ fix: ParkFix, entryFix: ParkFix? = nil, gpsLossAt: Date? = nil, baroDeltaM: Double? = nil, crawlS: Double? = nil) -> ParkOutcome {
        ParkOutcome(fix: fix, signals: ["motion_stop", "location_settled"], stopAt: stopAt,
                    entryFix: entryFix, gpsLossAt: gpsLossAt, baroDeltaM: baroDeltaM, crawlS: crawlS)
    }

    static func unlocated(entryFix: ParkFix?, gpsLossAt: Date? = stopAt.addingTimeInterval(-40), baroDeltaM: Double? = nil, crawlS: Double? = nil) -> ParkOutcome {
        ParkOutcome(fix: nil, signals: ["motion_stop", "motion_walking", "audio_disconnect"], stopAt: stopAt,
                    entryFix: entryFix, gpsLossAt: gpsLossAt, baroDeltaM: baroDeltaM, crawlS: crawlS)
    }

    func classify(
        _ park: ParkOutcome,
        memory: PlaceMemory = PlaceMemory(),
        footprints: [Footprint] = [PlaceClassifierTests.garage],
        zones: ZoneHint = .unknown
    ) -> PlaceClassification {
        PlaceClassifier.classify(park: park, memory: memory, footprints: LinearFootprintIndex(footprints: footprints), zones: zones)
    }

    /// Two confirmations make a saved place (PlaceMemory's rule).
    func remembering(_ placeClass: PlaceClass, at point: CLLocationCoordinate2D, name: String? = nil) -> PlaceMemory {
        var memory = PlaceMemory()
        memory.confirm(placeClass, at: point, name: name, now: Self.stopAt.addingTimeInterval(-86_400))
        memory.confirm(placeClass, at: point, name: name, now: Self.stopAt.addingTimeInterval(-3_600))
        return memory
    }

    // MARK: - Precedence: memory ≥ footprint containment ≥ sensors

    /// The driver has said twice this is somewhere they don't pay (a
    /// garage their building covers): that beats the footprint, which
    /// becomes the runner-up.
    @Test func memoryBeatsFootprint() {
        let spot = Geo.fix(n: 0, e: 0, accuracy: 5)
        let memory = remembering(.nopay, at: Geo.at(n: 10, e: 5), name: "Work")
        let result = classify(Self.located(spot), memory: memory)
        #expect(result.placeClass == .nopay)
        #expect(result.confidence == 0.95)
        #expect(result.inputs.memoryHit)
        #expect(result.runnerUp?.placeClass == .garage, "The footprint's answer is kept as the runner-up")
        #expect(result.runnerUp?.confidence == 0.9)

        // Without the memory, the same park is the garage.
        let cold = classify(Self.located(spot))
        #expect(cold.placeClass == .garage)
        #expect(!cold.inputs.memoryHit)
    }

    /// One confirmation isn't a place yet, and a saved place 70 m away
    /// isn't this one.
    @Test func memoryNeedsTwoConfirmationsAndSixtyMeters() {
        let spot = Geo.fix(n: 0, e: 0, accuracy: 5)
        var once = PlaceMemory()
        once.confirm(.nopay, at: spot.coordinate, now: Self.stopAt.addingTimeInterval(-3_600))
        #expect(classify(Self.located(spot), memory: once).placeClass == .garage)

        let far = remembering(.nopay, at: Geo.at(n: 0, e: 70))
        #expect(classify(Self.located(spot), memory: far).placeClass == .garage)
    }

    /// A fix inside a lot, 15 m from a neighboring garage's entrance: the
    /// outline it's in wins over the entrance it's near.
    @Test func containmentBeatsProximity() {
        let lot = Footprint(
            id: "test-lot", name: "Test Lot", kind: .surface, fee: true, access: nil,
            polygon: Geo.box(n: 60, e: 0, w: 60, h: 40), entrances: [Geo.point(n: 60, e: 30)]
        )
        // 15 m north of the garage entrance (n 30), inside the lot (n 40…80).
        let spot = Geo.fix(n: 45, e: 0, accuracy: 5)
        let result = classify(Self.located(spot), footprints: [Self.garage, lot])
        #expect(result.placeClass == .lot)
        #expect(result.confidence == 0.85)
        #expect(result.inputs.footprintId == "test-lot")
        #expect(result.inputs.containsPoint)

        // Unlocated, entering the same way: still the lot it's inside.
        let entering = classify(Self.unlocated(entryFix: Geo.fix(n: 45, e: 0, accuracy: 8, speed: 3)), footprints: [Self.garage, lot])
        #expect(entering.inputs.footprintId == "test-lot")
        #expect(entering.placeClass == .lot)
    }

    /// GPS died after the car drove into a multi-storey garage: the last
    /// good fix, inside the outline, says which one.
    @Test func unlocatedParkWithEntryFixInsideAMultiStoreyIsGarage() {
        let entry = Geo.fix(n: 20, e: 5, accuracy: 10, speed: 3, at: Self.stopAt.addingTimeInterval(-60))
        let result = classify(Self.unlocated(entryFix: entry))
        #expect(result.placeClass == .garage)
        #expect(result.confidence >= 0.9)
        #expect(result.inputs.footprintId == "test-garage")
        #expect(!result.inputs.located)
    }

    /// Entered just outside the outline, 12 m from the entrance: the
    /// entrance says which garage.
    @Test func unlocatedParkNearAGarageEntranceIsThatGarage() {
        let entry = Geo.fix(n: 42, e: 0, accuracy: 10, speed: 3)
        let result = classify(Self.unlocated(entryFix: entry))
        #expect(result.placeClass == .garage)
        #expect(result.confidence == 0.9)
        #expect(result.inputs.footprintId == "test-garage")
        #expect(result.inputs.nearestEntranceM.map { abs($0 - 12) < 1 } == true)
        #expect(!result.inputs.containsPoint)
    }

    /// GPS lost with no footprint anywhere near: a garage nobody mapped,
    /// at 0.6 — enough to act on (a prompt), with no name.
    @Test func gpsLostWithNoFootprintIsAnUnknownGarage() {
        let entry = Geo.fix(n: 400, e: 400, accuracy: 10, speed: 3)
        let result = classify(Self.unlocated(entryFix: entry))
        #expect(result.placeClass == .garage)
        #expect(result.confidence == 0.6)
        #expect(result.inputs.footprintId == nil)
    }

    /// Ramps and a parking-lot crawl each add 0.05, never past 1.
    @Test func barometerAndCrawlAddToAGarage() {
        let entry = Geo.fix(n: 20, e: 5, accuracy: 10, speed: 3)
        let both = classify(Self.unlocated(entryFix: entry, baroDeltaM: -6.5, crawlS: 45))
        #expect(both.confidence == 1.0)
        #expect(both.inputs.crawl)
        let small = classify(Self.unlocated(entryFix: entry, baroDeltaM: 1.2, crawlS: 10))
        #expect(small.confidence == 0.9, "Under 2.5 m and under 30 s add nothing")
        let unknownGarage = classify(Self.unlocated(entryFix: Geo.fix(n: 400, e: 400, speed: 3), baroDeltaM: 3))
        #expect(unknownGarage.confidence == 0.65)
    }

    /// A lot that may or may not charge: lot at 0.6, and the other
    /// reading — free — is the runner-up.
    @Test func lotWithUnknownFeeIsLotAtPointSixWithNopayRunnerUp() {
        let lot = Footprint(
            id: "test-lot-unknown-fee", name: nil, kind: .surface, fee: nil, access: nil,
            polygon: Geo.box(n: 0, e: 200, w: 60, h: 60), entrances: []
        )
        let result = classify(Self.located(Geo.fix(n: 0, e: 200, accuracy: 5)), footprints: [lot])
        #expect(result.placeClass == .lot)
        #expect(result.confidence == 0.6)
        #expect(result.runnerUp?.placeClass == .nopay)
        #expect(result.runnerUp?.confidence == 0.3)
    }

    /// A private lot, or one tagged free, is somewhere nobody pays.
    @Test func aPrivateOrFreeLotIsNopay() {
        let privateLot = Footprint(
            id: "test-private", name: nil, kind: .surface, fee: nil, access: "private",
            polygon: Geo.box(n: 0, e: 200, w: 60, h: 60), entrances: []
        )
        let spot = Geo.fix(n: 0, e: 200, accuracy: 5)
        let result = classify(Self.located(spot), footprints: [privateLot])
        #expect(result.placeClass == .nopay)
        #expect(result.confidence == 0.8)
        var free = privateLot
        free.access = nil
        free.fee = false
        #expect(classify(Self.located(spot), footprints: [free]).placeClass == .nopay)
    }

    /// Short of a 0.3 margin, the classifier says unknown rather than guess.
    @Test func aMarginUnderPointThreeIsUnknown() {
        let lot = Footprint(
            id: "test-lot-unknown-fee", name: nil, kind: .surface, fee: nil, access: nil,
            polygon: Geo.box(n: 0, e: 200, w: 60, h: 60), entrances: []
        )
        let spot = Geo.fix(n: 0, e: 200, accuracy: 5)
        // lot 0.6 vs street 0.6 (the zone lookup can't tell the side): a tie.
        let result = classify(Self.located(spot), footprints: [lot], zones: .disagree)
        #expect(result.placeClass == .unknown)
        #expect(result.confidence == 0)
        #expect(result.runnerUp?.placeClass == .lot, "The best guess is kept for the record")
        #expect(result.runnerUp?.confidence == 0.6)
        // A lot that might charge is never silently free: nothing metered
        // nearby doesn't make it no-pay.
        #expect(classify(Self.located(spot), footprints: [lot], zones: .noMeteredZone).placeClass == .lot)
    }

    /// The street beside a garage: a fix just inside the outline, closer
    /// to its edge than its own accuracy, is not a garage at full
    /// confidence — and against a street lookup it's a question.
    @Test func aFixAtAGaragesEdgeIsNotACertainGarage() {
        // The garage's west wall is at e -40; 3 m inside it, ±10 m.
        let edge = Geo.fix(n: 0, e: -37, accuracy: 10)
        let alone = classify(Self.located(edge))
        #expect(alone.inputs.containsPoint)
        #expect(alone.confidence == 0.7)
        let withStreet = classify(Self.located(edge), zones: .agree)
        #expect(withStreet.placeClass == .unknown, "street 0.9 vs garage 0.7 is a question, not an answer")

        // Deep inside, the same accuracy is a garage (a roof with GPS).
        let roof = classify(Self.located(Geo.fix(n: 0, e: 0, accuracy: 10)), zones: .agree)
        #expect(roof.placeClass == .unknown, "garage 0.9 vs street 0.9: still a question")
        #expect(classify(Self.located(Geo.fix(n: 0, e: 0, accuracy: 10))).confidence == 0.9)
    }

    /// The zone lookup's answer, where there is one.
    @Test func streetComesFromTheZoneLookup() {
        let spot = Geo.fix(n: 300, e: 300, accuracy: 5)
        let agree = classify(Self.located(spot), zones: .agree)
        #expect(agree.placeClass == .street)
        #expect(agree.confidence == 0.9)
        #expect(classify(Self.located(spot), zones: .disagree).confidence == 0.6)
        // On the phone there's no zone data: a plain street park is
        // unknown, and /parked decides exactly as it does today.
        let phone = classify(Self.located(spot))
        #expect(phone.placeClass == .unknown)
        #expect(phone.runnerUp == nil)
    }

    /// Nothing metered and nothing that might charge within 60 m: free.
    @Test func noMeteredZoneAndNoPaidFootprintIsNopay() {
        let spot = Geo.fix(n: 300, e: 300, accuracy: 5)
        let result = classify(Self.located(spot), zones: .noMeteredZone)
        #expect(result.placeClass == .nopay)
        #expect(result.confidence == 0.7)
        // A garage 30 m away might be where it is: not silently free.
        let nearGarage = classify(Self.located(Geo.fix(n: 0, e: 70, accuracy: 5)), zones: .noMeteredZone)
        #expect(nearGarage.placeClass == .unknown)
    }

    // MARK: - What must never be guessed

    /// Precise Location off: no entry fix, no loss (fixes were never
    /// good). The classifier doesn't invent a garage.
    @Test func preciseOffIsUnknown() {
        let result = classify(Self.unlocated(entryFix: nil, gpsLossAt: nil))
        #expect(result.placeClass == .unknown)
        #expect(result.confidence == 0)
        #expect(result.runnerUp == nil)
    }

    /// A tunnel just before a street park: GPS came back and the spot has
    /// a good fix. That is not a garage.
    @Test func aLocatedParkWithGpsLossOnTheWayIsNotAGarage() {
        let spot = Geo.fix(n: 400, e: 400, accuracy: 5)
        let result = classify(Self.located(spot, gpsLossAt: Self.stopAt.addingTimeInterval(-90)))
        #expect(result.placeClass == .unknown)
        #expect(result.inputs.gpsLoss)
    }

    /// A kind the phone doesn't know yet decodes as unknown, not as a
    /// failure that would empty the whole index.
    @Test func footprintKindsDecodeAndUnknownKindsAreSafe() throws {
        let json = #"""
        [{"id": "x", "name": null, "kind": "carport", "fee": null, "access": null,
          "polygon": [[-71.0763, 42.3503], [-71.0762, 42.3503], [-71.0762, 42.3504], [-71.0763, 42.3503]],
          "entrances": []}]
        """#
        let index = try LinearFootprintIndex(json: Data(json.utf8))
        #expect(index.footprints.first?.kind == .unknown)
    }

    // MARK: - The hint on the wire

    /// The hint /parked gets names the class, its confidence, the garage,
    /// and the entry fix — and nothing from place memory: a saved place's
    /// name and center never leave the phone.
    @Test func theHintCarriesNothingFromPlaceMemory() throws {
        let spot = Geo.fix(n: 0, e: 0, accuracy: 5)
        let home = Geo.at(n: 25, e: 25)
        let memory = remembering(.nopay, at: home, name: "Mom's driveway")
        let result = classify(Self.located(spot, entryFix: Geo.fix(n: 35, e: 0, accuracy: 6, speed: 3)), memory: memory)
        #expect(result.placeClass == .nopay)

        let hint = PlaceHint(result)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let json = String(decoding: try encoder.encode(hint), as: UTF8.self)
        #expect(!json.contains("Mom"), "The saved place's name left the phone: \(json)")
        #expect(!json.contains(String(format: "%.5f", home.latitude)), "The saved place's center left the phone: \(json)")
        let object = try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        #expect(object["class"] as? String == "nopay")
        #expect(object["confidence"] as? Double == 0.95)
        #expect((object["inputs"] as? [String: Any])?["memoryHit"] as? Bool == true)
        #expect((object["entryFix"] as? [String: Any])?["lat"] as? Double != nil)
        #expect(object["garageId"] == nil, "A memory answer names no garage")
    }

    @Test func theHintNamesTheGarageItCameFrom() {
        let hint = PlaceHint(classify(Self.unlocated(entryFix: Geo.fix(n: 20, e: 5, accuracy: 10, speed: 3))))
        #expect(hint.placeClass == "garage")
        #expect(hint.garageId == "test-garage")
        #expect(hint.inputs.located == false)
        #expect(hint.inputs.gpsLoss)
    }
}
