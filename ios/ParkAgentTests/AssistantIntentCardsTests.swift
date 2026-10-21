import XCTest
@testable import ParkAgent

/// FR-45 on the phone: the card says what it answered. The request it was
/// built for arrives as `requestSummary` and shows as chips; a
/// "nothing meets this" card names the limit that failed and badges each
/// near-miss with what it breaks; an option over the approval threshold
/// (`warn`) takes a hold, not a tap; and what leads the card — one option
/// that honors the ask, or the cheapest and the closest together — is the
/// server's `primary`.
@MainActor
final class AssistantIntentCardsTests: XCTestCase {
    private func decode(_ json: String) throws -> AssistantPlan {
        let wrapped = "{\"planId\": \"p1\", \"plan\": \(json)}"
        return try JSONDecoder().decode(AssistantReply.ProposedPlan.self, from: Data(wrapped.utf8)).plan
    }

    private func summary(_ json: String) throws -> RequestSummary {
        try JSONDecoder().decode(RequestSummary.self, from: Data(json.utf8))
    }

    /// The server's request summary, as `propose_plan` stores it: the
    /// state without its log, nulls included.
    private static let underTwenty = """
    {"version": 4, "intent": "park_later",
     "place": {"query": "Lola 42 Seaport",
               "resolved": {"lat": 42.3546, "lng": -71.0453, "label": "LoLa 42, Seaport", "city": "bos"},
               "candidates": null},
     "window": {"startsAt": "2026-09-26T19:00:00-04:00", "durationMinutes": 180, "source": "user"},
     "hard": {"maxPriceUsd": 20, "maxWalkMinutes": 10, "kinds": ["street"], "entryType": "self", "covered": true},
     "soft": {"rank": "cheapest", "prefer": ["garage"]}}
    """

    private static let rightHere = """
    {"version": 0, "intent": "park_now",
     "place": {"query": null, "resolved": null, "candidates": null},
     "window": {"startsAt": null, "durationMinutes": null, "source": "default"},
     "hard": {"maxPriceUsd": null, "maxWalkMinutes": null, "kinds": null, "entryType": null, "covered": null},
     "soft": {"rank": null, "prefer": null},
     "assumed": {"place": "phone_location", "durationMinutes": 60}}
    """

    // MARK: - Decoding

    func testANoneMeetsPayloadDecodesWithItsVerdictAndTheRequestItAnswered() throws {
        guard case .noneMeets(let plan) = try decode("""
        {"kind": "none_meets", "verdict": "none_meets",
         "headline": "Nothing under $20.00 within a 10-minute walk near LoLa 42, Seaport.",
         "constraintsFailed": [{"field": "maxPriceUsd", "limit": 20, "nearestActual": 22},
                               {"field": "maxWalkMinutes", "limit": 10, "nearestActual": 14}],
         "nearMisses": [
           {"id": "v4-g-a", "type": "garage", "label": "Seaport Garage", "detail": "",
            "priceUsd": 22, "durationMinutes": 180, "walkMinutes": 4, "provider": "spothero",
            "recommended": false, "nearMiss": true, "warn": true,
            "violates": [{"field": "maxPriceUsd", "actual": 22, "limit": 20}]}],
         "relaxSuggestions": [{"field": "maxPriceUsd", "to": 25, "wouldYield": 1,
                               "label": "Allow up to $25.00", "reply": "Allow up to $25.00"}],
         "requestSummary": \(Self.underTwenty)}
        """) else { return XCTFail("expected the none_meets card") }
        XCTAssertEqual(plan.verdict, "none_meets")
        let request = try XCTUnwrap(plan.requestSummary?.value)
        XCTAssertEqual(request.version, 4)
        XCTAssertEqual(request.intent, "park_later")
        XCTAssertEqual(request.place.resolved?.label, "LoLa 42, Seaport")
        XCTAssertEqual(request.window.durationMinutes, 180)
        XCTAssertEqual(request.hard.maxPriceUsd, 20)
        XCTAssertEqual(request.hard.maxWalkMinutes, 10)
        XCTAssertEqual(request.hard.kinds, ["street"])
        XCTAssertEqual(request.soft.rank, "cheapest")
        XCTAssertNil(request.assumed, "Nothing was assumed: the user said all of it")
        XCTAssertEqual(plan.nearMisses.first?.warn, true)
    }

    func testAWarnPayloadDecodesWithWhatLeadsAndWhatTakesAHold() throws {
        guard case .singleSpot(let plan) = try decode("""
        {"kind": "single_spot", "verdict": "meets",
         "requestSummary": \(Self.rightHere),
         "options": [
           {"id": "a", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.5,
            "durationMinutes": 60, "walkMinutes": 5, "axis": "cheapest", "primary": true,
            "recommended": true},
           {"id": "b", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 18,
            "durationMinutes": 60, "walkMinutes": 2, "axis": "closest", "primary": true,
            "warn": true, "provider": "spothero", "recommended": false}
         ]}
        """) else { return XCTFail("expected a single_spot card") }
        XCTAssertEqual(plan.verdict, "meets")
        XCTAssertEqual(plan.options.map(\.warn), [nil, true])
        XCTAssertEqual(plan.options.map(\.primary), [true, true])
        let request = try XCTUnwrap(plan.requestSummary?.value)
        XCTAssertEqual(request.assumed, RequestSummary.Assumed(place: "phone_location", durationMinutes: 60))
        XCTAssertNil(request.window.durationMinutes, "The assumed stay is not the request's own")
    }

    /// The summary feeds the chips and nothing else: one this build can't
    /// read costs the chips, never the card or the reply it came with.
    func testARequestSummaryThisBuildCannotReadCostsOnlyTheChips() throws {
        guard case .singleSpot(let plan) = try decode("""
        {"kind": "single_spot",
         "requestSummary": {"version": "four", "intent": 7},
         "options": [{"id": "a", "type": "street", "label": "Meter", "detail": "",
                      "priceUsd": 4.5, "durationMinutes": 60, "recommended": true}]}
        """) else { return XCTFail("the card should still decode") }
        XCTAssertNotNil(plan.requestSummary, "The key was there")
        XCTAssertNil(plan.requestSummary?.value)
        XCTAssertEqual(plan.options.map(\.id), ["a"])
        // A card from before FR-45 has no summary, no verdict, no flags.
        guard case .singleSpot(let old) = try decode("""
        {"kind": "single_spot", "options": [{"id": "a", "type": "street", "label": "Meter",
         "detail": "", "priceUsd": 4.5, "durationMinutes": 60, "recommended": true}]}
        """) else { return XCTFail("an older card should decode") }
        XCTAssertNil(old.requestSummary)
        XCTAssertNil(old.verdict)
        XCTAssertNil(old.options[0].warn)
    }

    // MARK: - The badge on a near-miss

    func testTheBadgeSaysHowFarOverThePriceOrPastTheWalk() {
        XCTAssertEqual(
            NoCardPresentation.badge(PlanViolation(field: "maxPriceUsd", actual: .number(22), limit: .number(20))),
            "$2.00 over your $20.00 limit"
        )
        XCTAssertEqual(
            NoCardPresentation.badge(PlanViolation(field: "maxPriceUsd", actual: .number(16.99), limit: .number(2))),
            "$14.99 over your $2.00 limit"
        )
        XCTAssertEqual(
            NoCardPresentation.badge(PlanViolation(field: "maxWalkMinutes", actual: .number(14), limit: .number(10))),
            "4 min past your 10-min walk"
        )
        XCTAssertEqual(
            NoCardPresentation.badge(PlanViolation(field: "maxWalkMinutes", actual: .number(6), limit: .number(5))),
            "1 min past your 5-min walk"
        )
        // The cheaper meter on a garage-only card.
        XCTAssertEqual(
            NoCardPresentation.badge(
                PlanViolation(field: "kinds", actual: .text("street"), limit: .list(["garage"]))
            ),
            "Street parking, not a garage"
        )
        // No badge calls the user's own limit a cap: there is no per-trip cap.
        for field in ["maxPriceUsd", "maxWalkMinutes", "kinds", "entryType", "covered"] {
            let text = NoCardPresentation.badge(
                PlanViolation(field: field, actual: .number(3), limit: .number(2))
            )
            XCTAssertFalse(text.localizedCaseInsensitiveContains("cap"), text)
        }
    }

    // MARK: - The headline of a "no"

    private func noneMeets(_ constraintsFailed: String) throws -> NoneMeetsPlan {
        guard case .noneMeets(let plan) = try decode("""
        {"kind": "none_meets", "headline": "x", "constraintsFailed": \(constraintsFailed),
         "nearMisses": [], "relaxSuggestions": []}
        """) else { throw XCTSkip("expected the none_meets card") }
        return plan
    }

    func testTheHeadlineNamesTheLimitsNothingMet() throws {
        XCTAssertEqual(
            NoCardPresentation.headline(try noneMeets(
                "[{\"field\": \"maxPriceUsd\", \"limit\": 2, \"nearestActual\": 4.5}]"
            )),
            "Nothing under $2.00"
        )
        let both = try noneMeets("""
        [{"field": "maxPriceUsd", "limit": 10, "nearestActual": 18},
         {"field": "maxWalkMinutes", "limit": 5, "nearestActual": 14},
         {"field": "kinds", "limit": ["garage"]}]
        """)
        XCTAssertEqual(NoCardPresentation.headline(both), "No garage under $10.00 within a 5-min walk")
        XCTAssertEqual(
            NoCardPresentation.nearest(both),
            "Lowest price found: $18.00 · Shortest walk found: 14 min"
        )
        XCTAssertEqual(
            NoCardPresentation.headline(try noneMeets(
                "[{\"field\": \"entryType\", \"limit\": \"valet\"}, {\"field\": \"covered\", \"limit\": true}]"
            )),
            "Nothing with valet that's covered"
        )
        // Nothing the phone can put in words: the plain sentence, and no
        // "nearest" line made up for it.
        let unknown = try noneMeets("[{\"field\": \"somethingNew\", \"limit\": 3}]")
        XCTAssertEqual(NoCardPresentation.headline(unknown), "Nothing meets your request")
        XCTAssertNil(NoCardPresentation.nearest(unknown))
    }

    // MARK: - Request chips

    func testOneChipPerSetField() throws {
        let chips = RequestChips.chips(for: try summary(Self.underTwenty))
        XCTAssertEqual(chips.map(\.id), [
            "intent", "place", "window", "hard.maxPriceUsd", "hard.maxWalkMinutes",
            "hard.kinds", "hard.entryType", "hard.covered", "soft.rank",
        ])
        XCTAssertEqual(Set(chips.map(\.id)).count, chips.count, "One chip a field")
        let label = Dictionary(uniqueKeysWithValues: chips.map { ($0.id, $0.label) })
        XCTAssertEqual(label["intent"], "Parking later")
        XCTAssertEqual(label["place"], "Near LoLa 42, Seaport")
        XCTAssertEqual(label["window"]?.hasSuffix(" · 3 hr"), true, label["window"] ?? "")
        XCTAssertEqual(label["hard.maxPriceUsd"], "Under $20.00")
        XCTAssertEqual(label["hard.maxWalkMinutes"], "10-min walk or less")
        XCTAssertEqual(label["hard.kinds"], "Street only")
        XCTAssertEqual(label["hard.entryType"], "Self-park")
        XCTAssertEqual(label["hard.covered"], "Covered")
        XCTAssertEqual(label["soft.rank"], "Cheapest first")
        XCTAssertTrue(chips.allSatisfy { !$0.assumed }, "The user said every one of these")
    }

    func testARequestWithNothingSetShowsOnlyWhatItIsAndWhatWasAssumed() throws {
        let chips = RequestChips.chips(for: try summary(Self.rightHere))
        XCTAssertEqual(chips.map(\.id), ["intent", "place", "window"])
        XCTAssertEqual(chips.map(\.label), ["Parking now", "Near you", "Now · 1 hr"])
        // The phone's location and the hour are the server's, and say so.
        XCTAssertEqual(chips.map(\.assumed), [false, true, true])
        // No rank was asked for, so there is no rank chip (decision 8).
        XCTAssertFalse(chips.contains { $0.id == "soft.rank" })
    }

    func testAGarageOnlyRequestSaysSoOnce() throws {
        let chips = RequestChips.chips(for: try summary("""
        {"version": 2, "intent": "garage_or_lot",
         "place": {"query": "Fenway Park", "resolved": null, "candidates": null},
         "window": {"startsAt": null, "durationMinutes": 180, "source": "user"},
         "hard": {"maxPriceUsd": null, "maxWalkMinutes": null, "kinds": ["garage"],
                  "entryType": "valet", "covered": false},
         "soft": {"rank": "closest", "prefer": null}}
        """))
        // The intent chip IS the garage-only limit; `covered: false` is no limit.
        XCTAssertEqual(chips.map(\.id), ["intent", "place", "window", "hard.entryType", "soft.rank"])
        XCTAssertEqual(chips.map(\.label), [
            "Garage or lot", "Near Fenway Park", "Now · 3 hr", "Valet", "Closest first",
        ])
    }

    func testAChipSendsAShortMessageNamingWhatToChangeAndNoValue() throws {
        let chips = RequestChips.chips(for: try summary(Self.underTwenty))
        let message = Dictionary(uniqueKeysWithValues: chips.map { ($0.id, $0.message) })
        XCTAssertEqual(message["hard.maxPriceUsd"], "Change the budget")
        XCTAssertEqual(message["window"], "Change the time")
        XCTAssertEqual(message["place"], "Change the place")
        XCTAssertEqual(message["soft.rank"], "Change the ranking")
        for chip in chips {
            XCTAssertTrue(chip.message.hasPrefix("Change "), chip.message)
            // The server owns the request: no chip carries a value to set.
            XCTAssertNil(chip.message.rangeOfCharacter(from: .decimalDigits), chip.message)
        }
        XCTAssertEqual(Set(chips.map(\.message)).count, chips.count, "Each chip asks about its own field")
    }

    // MARK: - What leads the card (decision 8)

    private func singleSpot(_ options: String) throws -> SingleSpotPlan {
        guard case .singleSpot(let plan) = try decode("{\"kind\": \"single_spot\", \"options\": \(options)}")
        else { throw XCTSkip("expected a single_spot card") }
        return plan
    }

    func testWithNoAskTheCheapestAndTheClosestLeadTogether() throws {
        let plan = try singleSpot("""
        [{"id": "cheap", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.1,
          "durationMinutes": 60, "walkMinutes": 6, "axis": "cheapest", "primary": true, "recommended": true},
         {"id": "close", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 12,
          "durationMinutes": 60, "walkMinutes": 1, "axis": "closest", "primary": true, "recommended": false},
         {"id": "other", "type": "garage", "label": "Valet", "detail": "", "priceUsd": 24,
          "durationMinutes": 60, "walkMinutes": 6, "recommended": false}]
        """)
        XCTAssertEqual(plan.primaryOptions.map(\.id), ["cheap", "close"])
        XCTAssertEqual(plan.primaryOptions.map(NoCardPresentation.axisLabel), ["Cheapest", "Closest"])
        XCTAssertEqual(plan.alternativeOptions.map(\.id), ["other"])
        XCTAssertNil(NoCardPresentation.alternativeLead(plan.options[2]), "Not a labeled alternative")
    }

    func testWithAnAskOneOptionLeadsAndTheOtherAxisIsALabeledAlternative() throws {
        let plan = try singleSpot("""
        [{"id": "close", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 32,
          "durationMinutes": 60, "walkMinutes": 2, "axis": "closest", "primary": true, "recommended": true},
         {"id": "cheap", "type": "garage", "label": "Ipswich", "detail": "", "priceUsd": 14,
          "durationMinutes": 60, "walkMinutes": 7, "axis": "cheapest", "secondary": true, "recommended": false},
         {"id": "meter", "type": "street", "label": "Meter", "detail": "", "priceUsd": 7.5,
          "durationMinutes": 60, "walkMinutes": 3, "recommended": false, "nearMiss": true,
          "violates": [{"field": "kinds", "actual": "street", "limit": ["garage"]}]}]
        """)
        XCTAssertEqual(plan.primaryOptions.map(\.id), ["close"])
        XCTAssertEqual(plan.alternativeOptions.map(\.id), ["cheap", "meter"])
        XCTAssertEqual(NoCardPresentation.alternativeLead(plan.options[1]), "Cheaper")
        // A near-miss is never dressed as an alternative that meets the request.
        XCTAssertNil(NoCardPresentation.alternativeLead(plan.options[2]))
        var closer = plan.options[1]
        closer.axis = "closest"
        XCTAssertEqual(NoCardPresentation.alternativeLead(closer), "Closer")
    }

    func testAPlanFromBeforeTheFlagLeadsWithItsRecommendedOptionAndANearMissNeverLeads() throws {
        let old = try singleSpot("""
        [{"id": "a", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 18,
          "durationMinutes": 90, "recommended": false},
         {"id": "b", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.1,
          "durationMinutes": 90, "recommended": true}]
        """)
        XCTAssertEqual(old.primaryOptions.map(\.id), ["b"])
        XCTAssertEqual(old.alternativeOptions.map(\.id), ["a"])

        let wrong = try singleSpot("""
        [{"id": "a", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 18,
          "durationMinutes": 90, "recommended": true},
         {"id": "miss", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.1,
          "durationMinutes": 90, "recommended": false, "primary": true, "nearMiss": true,
          "violates": [{"field": "kinds", "actual": "street", "limit": ["garage"]}]}]
        """)
        XCTAssertEqual(wrong.primaryOptions.map(\.id), ["a"])
    }

    // MARK: - The words on the action

    func testAStreetActionSaysTheAmountItPays() throws {
        let plan = try singleSpot("""
        [{"id": "s", "type": "street", "label": "Meter", "detail": "", "priceUsd": 4.1,
          "durationMinutes": 90, "recommended": true},
         {"id": "free", "type": "street", "label": "Free block", "detail": "", "priceUsd": 0,
          "durationMinutes": 90, "recommended": false},
         {"id": "g", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 12,
          "durationMinutes": 90, "provider": "parkwhiz", "recommended": false}]
        """)
        XCTAssertEqual(ConfirmCopy.title(plan.options[0]), "Pay $4.10 for 1 hr 30 min")
        XCTAssertEqual(ConfirmCopy.title(plan.options[0], compact: true), "Pay $4.10")
        XCTAssertEqual(ConfirmCopy.title(plan.options[1]), "Confirm — free")
        XCTAssertEqual(ConfirmCopy.title(plan.options[2]), "Confirm — open ParkWhiz ($12.00)")
        XCTAssertEqual(ConfirmCopy.title(plan.options[2], compact: true), "Open ParkWhiz")
    }

    func testAnOptionOverTheThresholdSaysToHold() throws {
        let plan = try singleSpot("""
        [{"id": "g", "type": "garage", "label": "Deck", "detail": "", "priceUsd": 32,
          "durationMinutes": 180, "provider": "spothero", "warn": true, "recommended": true},
         {"id": "s", "type": "street", "label": "Meter", "detail": "", "priceUsd": 18,
          "durationMinutes": 240, "warn": true, "recommended": false}]
        """)
        XCTAssertEqual(ConfirmCopy.title(plan.options[0]), "Hold to open SpotHero ($32.00)")
        // Short enough for a half-width tile, whatever the site is called.
        XCTAssertEqual(ConfirmCopy.title(plan.options[0], compact: true), "Hold to open")
        XCTAssertEqual(ConfirmCopy.title(plan.options[1]), "Hold to pay $18.00 for 4 hr")
        XCTAssertEqual(ConfirmCopy.title(plan.options[1], compact: true), "Hold to pay $18.00")
        XCTAssertFalse(ConfirmCopy.warnBand.localizedCaseInsensitiveContains("cap"))
    }

    // MARK: - The mock's fixtures are the cards the server sends

    func testTheWarnFixtureLeadsWithAnOptionThatTakesAHold() throws {
        guard case .singleSpot(let plan) = MockAssistantFixtures.warnPlan.plan else {
            return XCTFail("the fixture should be a single_spot card")
        }
        XCTAssertEqual(plan.primaryOptions.map(\.id), ["opt-warn-garage"])
        XCTAssertEqual(plan.primaryOptions.first?.warn, true)
        XCTAssertEqual(plan.alternativeOptions.map(NoCardPresentation.alternativeLead), ["Cheaper", nil])
        XCTAssertEqual(NoCardPresentation.badges(plan.options[2]), "Street parking, not a garage")
        let request = try XCTUnwrap(plan.requestSummary?.value)
        XCTAssertEqual(RequestChips.chips(for: request).map(\.label), [
            "Garage or lot", "Near Fenway Park", "Now · 3 hr", "Closest first",
        ])
    }

    func testTheCoPrimaryAndNoneMeetsFixturesCarryTheirRequests() throws {
        guard case .singleSpot(let both) = MockAssistantFixtures.coPrimaryPlan.plan,
              case .noneMeets(let none) = MockAssistantFixtures.noneMeetsPlan.plan
        else { return XCTFail("the fixtures should decode as their kinds") }
        XCTAssertEqual(both.primaryOptions.map(\.id), ["opt-cheapest", "opt-closest"])
        XCTAssertEqual(both.primaryOptions.map(\.warn), [nil, true])
        XCTAssertEqual(
            RequestChips.chips(for: try XCTUnwrap(both.requestSummary?.value)).map(\.label),
            ["Parking now", "Near you", "Now · 1 hr"]
        )
        XCTAssertEqual(none.verdict, "none_meets")
        XCTAssertEqual(NoCardPresentation.headline(none), "Nothing under $2.00")
        XCTAssertEqual(NoCardPresentation.nearest(none), "Lowest price found: $4.50")
        XCTAssertEqual(
            RequestChips.chips(for: try XCTUnwrap(none.requestSummary?.value)).map(\.label),
            ["Parking now", "Near Cambridge Common", "Now · 2 hr", "Under $2.00"]
        )
    }
}
