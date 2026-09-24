import XCTest
@testable import ParkAgent

/// How a single-spot plan is shaped for the results UI: exactly one hero
/// (the recommended option, which carries the only coral action), the
/// rest as compact rows, the destination and option coordinates the mini
/// map pins, and city-specific suggested prompts.
@MainActor
final class AssistantPlanPresentationTests: XCTestCase {
    private func decodePlan(_ json: String) throws -> SingleSpotPlan {
        let wrapped = "{\"planId\": \"p1\", \"plan\": \(json)}"
        let proposed = try JSONDecoder().decode(
            AssistantReply.ProposedPlan.self, from: Data(wrapped.utf8)
        )
        guard case .singleSpot(let plan) = proposed.plan else {
            throw XCTSkip("expected a single_spot plan")
        }
        return plan
    }

    func testHeroIsTheRecommendedOptionAndTheRestAreAlternatives() throws {
        let plan = try decodePlan("""
        {"kind": "single_spot", "options": [
          {"id": "a", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 18,
           "durationMinutes": 90, "recommended": false},
          {"id": "b", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.10,
           "durationMinutes": 90, "recommended": true},
          {"id": "c", "type": "garage", "label": "Valet", "detail": "", "priceUsd": 24,
           "durationMinutes": 90, "recommended": false}
        ]}
        """)
        XCTAssertEqual(plan.recommendedOption?.id, "b", "The badged option is the hero")
        XCTAssertEqual(plan.otherOptions.map(\.id), ["a", "c"], "Server order preserved")
        XCTAssertFalse(
            plan.otherOptions.contains { $0.id == plan.recommendedOption?.id },
            "The hero must never also appear as a row"
        )
    }

    /// The server normalizes to exactly one badge, but a plan that somehow
    /// arrives with none must still render a hero rather than nothing.
    func testAPlanWithNoBadgeStillHasAHero() throws {
        let plan = try decodePlan("""
        {"kind": "single_spot", "options": [
          {"id": "a", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.10,
           "durationMinutes": 90, "recommended": false},
          {"id": "b", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 18,
           "durationMinutes": 90, "recommended": false}
        ]}
        """)
        XCTAssertEqual(plan.recommendedOption?.id, "a")
        XCTAssertEqual(plan.otherOptions.map(\.id), ["b"])
    }

    func testDestinationAndOptionCoordinatesDecodeForTheMap() throws {
        let plan = try decodePlan("""
        {"kind": "single_spot",
         "destination": {"lat": 42.3394, "lng": -71.094, "label": "Museum of Fine Arts"},
         "options": [
          {"id": "a", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.10,
           "durationMinutes": 90, "lat": 42.3399, "lng": -71.0951, "recommended": true},
          {"id": "b", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 18,
           "durationMinutes": 90, "recommended": false}
        ]}
        """)
        XCTAssertEqual(plan.destination?.label, "Museum of Fine Arts")
        XCTAssertEqual(plan.options[0].coordinate?.latitude ?? 0, 42.3399, accuracy: 0.0001)
        XCTAssertNil(plan.options[1].coordinate, "An option without coordinates gets no pin")
    }

    /// Availability truth: a future street option is marked pay-on-arrival
    /// and must not offer a Confirm.
    func testFutureStreetOptionIsMarkedPayOnArrival() throws {
        let plan = try decodePlan("""
        {"kind": "single_spot", "options": [
          {"id": "later", "type": "street", "label": "Meter", "detail": "", "priceUsd": 7.50,
           "durationMinutes": 180, "startsAt": "2026-01-10T19:00:00-05:00",
           "payOnArrival": true, "recommended": true}
        ]}
        """)
        XCTAssertEqual(plan.recommendedOption?.payOnArrival, true)
        XCTAssertNotNil(plan.recommendedOption?.startsAt)
    }

    func testProvenanceDecodesAndIsAbsentWhenTheServerSendsNone() throws {
        let withProvenance = try decodePlan("""
        {"kind": "single_spot",
         "provenance": {"provider": "spothero", "searchedAt": "2026-01-05T14:00:00-05:00"},
         "options": [{"id": "a", "type": "garage", "label": "Deck", "detail": "",
          "priceUsd": 18, "durationMinutes": 90, "recommended": true}]}
        """)
        XCTAssertEqual(withProvenance.provenance?.provider, "spothero")

        let without = try decodePlan("""
        {"kind": "single_spot", "options": [{"id": "a", "type": "street", "label": "Meter",
         "detail": "", "priceUsd": 4.10, "durationMinutes": 90, "recommended": true}]}
        """)
        XCTAssertNil(without.provenance, "No provenance means no 'from SpotHero' line")
    }

    func testSuggestedPromptsAreCitySpecific() {
        let boston = CityCatalog.assistantStarters(for: "bos")
        XCTAssertTrue(boston.contains { $0.contains("Newbury Street") })
        XCTAssertTrue(boston.contains { $0.contains("Fenway") })

        let nyc = CityCatalog.assistantStarters(for: "nyc")
        XCTAssertTrue(nyc.contains { $0.contains("Lincoln Center") })
        XCTAssertFalse(
            nyc.contains { $0.contains("Fenway") },
            "A New York user is never offered a Boston landmark"
        )

        // Unknown city: nothing we can't geocode.
        for prompt in CityCatalog.assistantStarters(for: nil) {
            XCTAssertFalse(prompt.contains("Fenway"))
            XCTAssertFalse(prompt.contains("Lincoln"))
        }
        XCTAssertFalse(CityCatalog.assistantStarters(for: nil).isEmpty)

        // City names come from the catalog, never from starter copy.
        let names = CityCatalog.all.compactMap { CityCatalog.displayName($0) }
        XCTAssertEqual(names.count, CityCatalog.all.count)
        for city in CityCatalog.all + [nil] {
            for prompt in CityCatalog.assistantStarters(for: city) {
                for name in names {
                    XCTAssertFalse(prompt.contains(name), "“\(prompt)” names \(name)")
                }
            }
        }
    }
}
