import CoreLocation
import Foundation

/// What kind of place a park is (FR-53).
enum PlaceClass: String, Codable, Sendable, CaseIterable {
    case street, garage, lot, nopay, unknown
}

/// What the zone lookup says about the spot. The phone has no zone data
/// (the server resolves zones in /parked), so the detector passes
/// `.unknown` and a plain street park classifies as unknown: /parked then
/// decides exactly as it always has. #179 classifies again on the server,
/// where the zones are.
enum ZoneHint: String, Codable, Sendable {
    case unknown
    /// Metered candidates in reach, all agreeing on terms.
    case agree
    /// Metered candidates that disagree (which side of the street).
    case disagree
    /// Nothing metered within 60 m.
    case noMeteredZone = "no_metered_zone"
}

struct PlaceClassification: Codable, Equatable, Sendable {
    struct Scored: Codable, Equatable, Sendable {
        var placeClass: PlaceClass
        var confidence: Double
    }

    /// What the answer came from: the decisions row's inputs once #179
    /// reads the hint, and what the field test scores. Never a saved
    /// place's name or center — only whether one matched.
    struct Inputs: Codable, Equatable, Sendable {
        var located: Bool
        var memoryHit: Bool
        /// The garage or lot the car is inside (or drove into).
        var footprintId: String?
        var footprintKind: Footprint.Kind?
        var containsPoint: Bool
        var nearestEntranceM: Double?
        var gpsLoss: Bool
        var baroDeltaM: Double?
        var crawl: Bool
        var entryFix: ParkFix?
        var zones: ZoneHint
    }

    /// What to act on; `.unknown` when no class beat the next by the margin.
    var placeClass: PlaceClass
    /// The acted-on class's score, 0–1; 0 for `.unknown`.
    var confidence: Double
    /// For a class: the next best. For `.unknown`: the best guess, which
    /// fell short. Nil when nothing else scored at all.
    var runnerUp: Scored?
    var inputs: Inputs
}

/// Turns a park into a place class: the driver's saved places first, then
/// the footprint the car is in, then the sensors, and acts on the top
/// class only when it beats the next by `actMargin`
/// (docs/research/3-park-now.md §2). Pure: the same park, memory,
/// footprints, and zones always give the same answer, so a recorded
/// trace replays to it.
///
/// Scores (0–1, the best rule for each class wins):
/// - memory: a saved place (two confirmations) within 60 m → its class, 0.95.
/// - street: the zone lookup agrees 0.9, disagrees 0.6.
/// - garage: inside a garage's outline 0.9 — 0.7 for a located fix closer
///   to the outline's edge than its own accuracy (the street beside it);
///   unlocated with the entry fix within max(40 m, its accuracy) of a
///   garage entrance 0.9; unlocated after good GPS with no footprint 0.6
///   (a garage nobody mapped). A ±2.5 m barometer change and a 30 s crawl
///   each add 0.05.
/// - lot: inside a lot that charges 0.85, whose fee is unknown 0.6.
/// - nopay: a free or private lot 0.8; an unknown-fee lot 0.3; nothing
///   metered and nothing that might charge within 60 m 0.7.
@MainActor
enum PlaceClassifier {
    static let actMargin = 0.3
    static let memoryConfidence = 0.95
    /// An entry fix this close to a garage's entrance entered it.
    static let entranceRadiusM = 40.0
    /// No-pay needs nothing that might charge this close.
    static let nopayClearanceM = 60.0
    static let baroClimbM = 2.5
    static let crawlMinS: TimeInterval = 30

    static func classify(
        park: ParkOutcome,
        memory: PlaceMemory,
        footprints index: any FootprintIndex,
        zones: ZoneHint
    ) -> PlaceClassification {
        let located = park.fix != nil
        // Where to look: the car's own fix, else where GPS last saw it
        // moving in.
        let point = park.fix ?? park.entryFix
        // No fix at the spot after good GPS on the way in: somewhere GPS
        // can't reach. (Precise Location off has neither, so never this.)
        let lostAtSpot = !located && (park.gpsLossAt != nil || park.entryFix != nil)
        let crawl = (park.crawlS ?? 0) >= crawlMinS
        var inputs = PlaceClassification.Inputs(
            located: located, memoryHit: false, footprintId: nil, footprintKind: nil, containsPoint: false,
            nearestEntranceM: nil, gpsLoss: park.gpsLossAt != nil, baroDeltaM: park.baroDeltaM, crawl: crawl,
            entryFix: park.entryFix, zones: zones
        )

        var scores: [PlaceClass: Double] = [:]
        func raise(_ placeClass: PlaceClass, _ score: Double) {
            scores[placeClass] = max(scores[placeClass] ?? 0, score)
        }

        switch zones {
        case .agree: raise(.street, 0.9)
        case .disagree: raise(.street, 0.6)
        case .unknown, .noMeteredZone: break
        }

        var nearby: [Footprint] = []
        if let point {
            let coordinate = point.coordinate
            nearby = index.footprints(near: coordinate, radiusM: max(80, max(point.accuracy, 0) + entranceRadiusM))
            // Containment beats proximity; of nested outlines, the innermost.
            if let footprint = nearby.filter({ $0.contains(coordinate) }).min(by: { $0.areaM2 < $1.areaM2 }) {
                inputs.footprintId = footprint.id
                inputs.footprintKind = footprint.kind
                inputs.containsPoint = true
                inputs.nearestEntranceM = footprint.nearestEntranceM(from: coordinate).map { $0.rounded() }
                if footprint.kind.isStructure {
                    let deep = !located || footprint.distanceToEdgeM(from: coordinate) >= point.accuracy
                    raise(.garage, deep ? 0.9 : 0.7)
                } else if footprint.fee == false || footprint.access == "private" {
                    raise(.nopay, 0.8)
                } else if footprint.fee == true {
                    raise(.lot, 0.85)
                } else {
                    raise(.lot, 0.6)
                    raise(.nopay, 0.3)
                }
            } else if !located, let entry = park.entryFix {
                let reach = max(entranceRadiusM, entry.accuracy)
                let entered = nearby.filter(\.kind.isStructure)
                    .compactMap { footprint in footprint.nearestEntranceM(from: entry.coordinate).map { (footprint, $0) } }
                    .filter { $0.1 <= reach }
                    .min { $0.1 < $1.1 }
                if let match = entered {
                    inputs.footprintId = match.0.id
                    inputs.footprintKind = match.0.kind
                    inputs.nearestEntranceM = match.1.rounded()
                    raise(.garage, 0.9)
                }
            }
        }
        if lostAtSpot, inputs.footprintId == nil { raise(.garage, 0.6) }
        if let garage = scores[.garage] {
            var bonus = 0.0
            if let baro = park.baroDeltaM, abs(baro) >= baroClimbM { bonus += 0.05 }
            if crawl { bonus += 0.05 }
            scores[.garage] = min(1, garage + bonus)
        }
        if zones == .noMeteredZone, let point {
            // Unknown fee counts as might-charge: no-pay is silent, so it
            // must never be a guess.
            let mightCharge = nearby.contains { footprint in
                (footprint.fee == true || (footprint.fee == nil && footprint.access != "private"))
                    && footprint.distanceM(from: point.coordinate) <= nopayClearanceM
            }
            if !mightCharge { raise(.nopay, 0.7) }
        }

        // Ties go to the class that asks over the one that stays silent.
        let order: [PlaceClass] = [.garage, .lot, .street, .nopay]
        let ranked = order
            .compactMap { placeClass in scores[placeClass].map { PlaceClassification.Scored(placeClass: placeClass, confidence: rounded($0)) } }
            .filter { $0.confidence > 0 }
            .enumerated()
            .sorted { $0.element.confidence != $1.element.confidence ? $0.element.confidence > $1.element.confidence : $0.offset < $1.offset }
            .map(\.element)

        // The driver's own answer for this spot.
        if let point, let place = memory.place(near: point.coordinate) {
            inputs.memoryHit = true
            return PlaceClassification(
                placeClass: place.placeClass, confidence: memoryConfidence,
                runnerUp: ranked.first { $0.placeClass != place.placeClass }, inputs: inputs
            )
        }
        guard let top = ranked.first else {
            return PlaceClassification(placeClass: .unknown, confidence: 0, runnerUp: nil, inputs: inputs)
        }
        let next = ranked.dropFirst().first
        if top.confidence - (next?.confidence ?? 0) >= actMargin - 1e-9 {
            return PlaceClassification(placeClass: top.placeClass, confidence: top.confidence, runnerUp: next, inputs: inputs)
        }
        return PlaceClassification(placeClass: .unknown, confidence: 0, runnerUp: top, inputs: inputs)
    }

    private static func rounded(_ score: Double) -> Double {
        (score * 100).rounded() / 100
    }
}

extension PlaceHint {
    /// The classification as /parked carries it. The saved place a memory
    /// answer came from stays on the phone: only `memoryHit` says there
    /// was one.
    init(_ classification: PlaceClassification) {
        let inputs = classification.inputs
        let namesAPlace = classification.placeClass == .garage || classification.placeClass == .lot
        self.init(
            placeClass: classification.placeClass.rawValue,
            confidence: classification.confidence,
            runnerUp: classification.runnerUp.map { Scored(placeClass: $0.placeClass.rawValue, confidence: $0.confidence) },
            garageId: namesAPlace ? inputs.footprintId : nil,
            entryFix: inputs.entryFix.map { EntryFix(lat: $0.latitude, lng: $0.longitude, accuracy: $0.accuracy, ts: $0.at) },
            inputs: Inputs(
                located: inputs.located,
                memoryHit: inputs.memoryHit,
                footprintId: inputs.footprintId,
                containsPoint: inputs.containsPoint,
                nearestEntranceM: inputs.nearestEntranceM,
                gpsLoss: inputs.gpsLoss,
                baroDeltaM: inputs.baroDeltaM.map { ($0 * 10).rounded() / 10 },
                crawl: inputs.crawl
            )
        )
    }
}
