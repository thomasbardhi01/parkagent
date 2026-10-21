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

    // MARK: - FR-43: the cards that say no, and the labels the server ranks with

    private func decodeProposed(_ json: String) throws -> AssistantPlan {
        let wrapped = "{\"planId\": \"p1\", \"plan\": \(json)}"
        return try JSONDecoder().decode(AssistantReply.ProposedPlan.self, from: Data(wrapped.utf8)).plan
    }

    /// The server's none_meets card, as `propose_plan` stores it.
    private static let noneMeetsJSON = """
    {"kind": "none_meets",
     "headline": "Nothing under $2.00 near Cambridge Common. Closest: Street — Mass Ave, $4.50, 5 min walk.",
     "constraintsFailed": [{"field": "maxPriceUsd", "limit": 2, "nearestActual": 4.5}],
     "nearMisses": [
       {"id": "v3-bos-mass-ave-1", "type": "street", "label": "Street — Mass Ave", "detail": "",
        "priceUsd": 4.5, "durationMinutes": 60, "walkMinutes": 5, "zoneId": "bos-mass-ave-1",
        "fetchedAt": "2026-01-05T19:00:00.000Z", "recommended": false, "nearMiss": true,
        "violates": [{"field": "maxPriceUsd", "actual": 4.5, "limit": 2}]},
       {"id": "v3-g-far", "type": "garage", "label": "Far Garage", "detail": "",
        "priceUsd": 1.5, "durationMinutes": 60, "walkMinutes": 14, "provider": "spothero",
        "fetchedAt": "2026-01-05T19:00:00.000Z", "recommended": false, "nearMiss": true,
        "violates": [{"field": "maxWalkMinutes", "actual": 14, "limit": 10},
                     {"field": "kinds", "actual": "garage", "limit": ["street"]}]}
     ],
     "relaxSuggestions": [
       {"field": "maxPriceUsd", "to": 7, "wouldYield": 1, "label": "Allow up to $7.00", "reply": "Allow up to $7.00"},
       {"field": "kinds", "to": ["street", "garage"], "wouldYield": 0, "label": "Street or garage is fine",
        "reply": "Street or garage is fine"}
     ],
     "assumptions": "Now–4:00 PM, near Cambridge Common"}
    """

    func testANoneMeetsCardDecodesWithItsNearMissesAndWhatEachBreaks() throws {
        guard case .noneMeets(let plan) = try decodeProposed(Self.noneMeetsJSON) else {
            return XCTFail("expected the none_meets card")
        }
        XCTAssertEqual(plan.headline.prefix(19), "Nothing under $2.00")
        XCTAssertEqual(plan.nearMisses.map(\.id), ["v3-bos-mass-ave-1", "v3-g-far"])
        XCTAssertEqual(plan.nearMisses.map(\.nearMiss), [true, true])
        XCTAssertEqual(
            plan.nearMisses[0].violates,
            [PlanViolation(field: "maxPriceUsd", actual: .number(4.5), limit: .number(2))]
        )
        // A list and a word decode as what they are, not as zero.
        XCTAssertEqual(plan.nearMisses[1].violates?[1].limit, .list(["street"]))
        XCTAssertEqual(plan.nearMisses[1].violates?[1].actual, .text("garage"))
        XCTAssertEqual(plan.relaxSuggestions.map(\.wouldYield), [1, 0])
        XCTAssertEqual(plan.constraintsFailed.first?.nearestActual, .number(4.5))
        XCTAssertFalse(plan.garageSearchUnavailable)
        // The headline is the limit nothing met, in words (FR-45).
        XCTAssertEqual(NoCardPresentation.headline(plan), "Nothing under $2.00")
    }

    func testANearMissSaysWhichLimitItBreaksAndByHowMuch() throws {
        guard case .noneMeets(let plan) = try decodeProposed(Self.noneMeetsJSON) else {
            return XCTFail("expected the none_meets card")
        }
        XCTAssertEqual(NoCardPresentation.badges(plan.nearMisses[0]), "$2.50 over your $2.00 limit")
        XCTAssertEqual(
            NoCardPresentation.badges(plan.nearMisses[1]),
            "4 min past your 10-min walk · A garage, not street parking"
        )
        // Only a garage's price says when it was fetched.
        XCTAssertNil(NoCardPresentation.fetchedText(plan.nearMisses[0]))
        XCTAssertEqual(NoCardPresentation.fetchedText(plan.nearMisses[1])?.hasPrefix("as of "), true)
        for (field, limit, expected) in [
            ("entryType", PlanLimitValue.text("valet"), "Not valet"),
            ("entryType", .text("self"), "Valet only"),
            ("covered", .flag(true), "Not known to be covered"),
            ("somethingNew", .none, "Doesn't meet your request"),
        ] {
            XCTAssertEqual(
                NoCardPresentation.badge(PlanViolation(field: field, actual: .none, limit: limit)),
                expected
            )
        }
    }

    func testAGarageOnlyRequestWithTheSearchDownIsItsOwnCard() throws {
        guard case .noneMeets(let plan) = try decodeProposed("""
        {"kind": "none_meets", "headline": "I couldn't check garages right now.",
         "constraintsFailed": [{"field": "garageSearch", "reason": "unavailable"}],
         "nearMisses": [], "relaxSuggestions": [],
         "provenance": {"provider": "spothero+parkwhiz", "searchedAt": "2026-01-05T19:00:00.000Z",
                        "garage": "unavailable"}}
        """) else { return XCTFail("expected the none_meets card") }
        XCTAssertTrue(plan.garageSearchUnavailable)
        XCTAssertEqual(NoCardPresentation.headline(plan), "Couldn't check garages")
        XCTAssertTrue(plan.nearMisses.isEmpty, "No street substitute on a garage-only request")
    }

    func testANoDataCardDecodesWithTheNearestZones() throws {
        guard case .noData(let plan) = try decodeProposed("""
        {"kind": "no_data", "rule": "no_zone_here",
         "headline": "Our data has no street parking or garages within 800 m of you.",
         "radiusM": 800,
         "nearestZones": [
           {"zoneId": "bos-far-1", "street": "Brattle St", "zoneNumber": null,
            "distanceM": 900, "walkMinutes": 15, "lat": 42.37, "lng": -71.12},
           {"zoneId": "bos-far-2", "street": null, "zoneNumber": "456", "distanceM": 1100, "walkMinutes": 18}
         ]}
        """) else { return XCTFail("expected the no_data card") }
        XCTAssertEqual(plan.rule, "no_zone_here")
        XCTAssertEqual(plan.nearestZones.map(NoCardPresentation.zoneLine), [
            "Brattle St · about 900 m, 15 min walk",
            "Zone 456 · about 1100 m, 18 min walk",
        ])
    }

    /// One card of a kind this build doesn't know must not cost the reply
    /// it came with, or the saved conversation it sits in.
    func testAnUnknownPlanKindIsNoCardNotADecodingError() throws {
        guard case .unsupported(let kind) = try decodeProposed("{\"kind\": \"valet_handoff\", \"x\": 1}") else {
            return XCTFail("an unknown kind should decode as unsupported")
        }
        XCTAssertEqual(kind, "valet_handoff")
        let reply = try JSONDecoder().decode(AssistantReply.self, from: Data("""
        {"conversationId": "c1", "reply": "Here you go.",
         "plan": {"planId": "p1", "plan": {"kind": "valet_handoff"}}, "suggestions": null}
        """.utf8))
        XCTAssertEqual(reply.reply, "Here you go.")
    }

    func testOptionsCarryTheServersRankingLabelsAndNearMissFlag() throws {
        let plan = try decodePlan("""
        {"kind": "single_spot",
         "provenance": {"provider": "spothero", "searchedAt": "2026-01-05T19:00:00.000Z"},
         "options": [
          {"id": "a", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.10,
           "durationMinutes": 90, "walkMinutes": 6, "axis": "cheapest", "recommended": true},
          {"id": "b", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 18,
           "durationMinutes": 90, "walkMinutes": 1, "axis": "closest", "secondary": true,
           "fetchedAt": "2026-01-05T19:00:00.000Z", "recommended": false},
          {"id": "c", "type": "garage", "label": "Valet", "detail": "", "priceUsd": 32,
           "durationMinutes": 90, "walkMinutes": 2, "recommended": false, "nearMiss": true,
           "violates": [{"field": "maxPriceUsd", "actual": 32, "limit": 30}]}
        ]}
        """)
        XCTAssertEqual(plan.options.map(NoCardPresentation.axisLabel), ["Cheapest", "Closest", nil])
        XCTAssertEqual(plan.options.map(\.secondary), [nil, true, nil])
        XCTAssertEqual(NoCardPresentation.badges(plan.options[2]), "$2.00 over your $30.00 limit")
        XCTAssertNil(NoCardPresentation.badges(plan.options[0]))
        var both = plan.options[0]
        both.axis = "both"
        XCTAssertEqual(NoCardPresentation.axisLabel(both), "Cheapest and closest")
    }

    func testTheGarageLineSaysWhenGaragesCouldNotBeChecked() throws {
        let plan = try decodePlan("""
        {"kind": "single_spot",
         "provenance": {"provider": "spothero+parkwhiz", "searchedAt": "2026-01-05T19:00:00.000Z",
                        "garage": "unavailable"},
         "options": [
          {"id": "a", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.10,
           "durationMinutes": 90, "recommended": true}
        ]}
        """)
        XCTAssertEqual(
            NoCardPresentation.providerNote(plan.provenance, hasGarages: false),
            "Couldn't check garages just now — these are street options only."
        )
        // With no garage on the card and nothing wrong, there is no line.
        XCTAssertNil(NoCardPresentation.providerNote(
            SingleSpotPlan.Provenance(provider: "spothero", searchedAt: "2026-01-05T19:00:00.000Z"),
            hasGarages: false
        ))
        XCTAssertNil(NoCardPresentation.providerNote(nil, hasGarages: true))
    }

    func testTheMockNoneMeetsFixtureIsTheCardTheServerSends() throws {
        guard case .noneMeets(let plan) = MockAssistantFixtures.noneMeetsPlan.plan else {
            return XCTFail("the fixture should be a none_meets card")
        }
        XCTAssertEqual(plan.nearMisses.count, 2)
        XCTAssertTrue(plan.nearMisses.allSatisfy { $0.nearMiss == true && NoCardPresentation.badges($0) != nil })
    }
}
