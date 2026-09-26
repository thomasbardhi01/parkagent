// UI tests and SwiftUI previews only. The whole file is compiled out of
// Release builds (ParkAgentReleaseTests proves it): a TestFlight build has
// no mock server, no fixtures, and no scenario switches.
#if DEBUG
import Foundation

// Mock assistant + Link wallet: scripted plans for both jobs so the
// sheet, plan cards, itinerary board, and UI tests all run without a
// server or an Anthropic key.

enum AssistantMockScenario: String, Sendable {
    /// Text mentioning a day/multiple stops gets the itinerary; else single.
    case auto
    case singleSpot
    case itinerary
    /// A named-place plan whose street option is for a future time: no
    /// Confirm, just "Pays automatically when you park".
    case futureStreet
    /// A place with two locations: the reply asks which, with one
    /// tappable suggestion per place; tapping one gets the plan.
    case placeChoices
    /// The parking-only refusal sentence.
    case refuse
    case error

    static let defaultsKey = "assistantScenario"
}

enum LinkMockScenario: String, Sendable {
    case disconnected
    case connected
    /// Configured but the approval flow denies.
    case denies

    static let defaultsKey = "linkScenario"
}

/// Mutable mock state: signed-off days, Link connection, spend requests.
/// Static so it survives MockAPI rebuilds within a run (the real server
/// owns this state).
actor MockAssistantStore {
    static let shared = MockAssistantStore()

    private(set) var itineraries: [ItinerarySummary] = []
    private var linkConnected: Bool?
    private var spendStatuses: [String: String] = [:]

    func isLinkConnected(scenario: LinkMockScenario) -> Bool {
        linkConnected ?? (scenario != .disconnected)
    }

    func setLinkConnected(_ connected: Bool) {
        linkConnected = connected
    }

    /// Mirrors the server: street stops pay at the curb with the street
    /// source; garage stops through Link when it's active, else at the
    /// garage's own checkout.
    func signOff(plan: ItineraryPlan, linkActive: Bool, streetSource: String) -> ItinerarySummary {
        let summary = ItinerarySummary(
            id: "mock-day-\(itineraries.count + 1)",
            status: "signed_off",
            date: plan.date,
            stops: plan.stops.map { stop in
                var s = stop
                s.paymentSource = stop.choice == "street"
                    ? streetSource
                    : (linkActive && stop.costUsd > 0 ? "link_wallet" : "garage_checkout")
                return s
            },
            totalUsd: plan.totalUsd
        )
        itineraries.insert(summary, at: 0)
        return summary
    }

    func patch(id: String, stops: [ItineraryStop]) -> ItinerarySummary? {
        guard let index = itineraries.firstIndex(where: { $0.id == id }) else { return nil }
        let old = itineraries[index]
        // Like the server: re-priced against the stored day (the app's
        // costs are never read), stored in arrival order with untimed
        // stops where the user put them.
        let priced = MockItineraryPricing.reprice(stops, proposed: old.stops).map { stop in
            var kept = stop
            let stored = old.stops.first { $0.id == stop.id }
            kept.paymentSource = stored?.paymentSource ?? stop.paymentSource
            kept.sessionId = stored?.sessionId
            return kept
        }
        let updated = ItinerarySummary(
            id: old.id,
            status: old.status,
            date: old.date,
            stops: priced,
            totalUsd: MockItineraryPricing.total(priced)
        )
        itineraries[index] = updated
        return updated
    }

    func createSpend(id: String, scenario: LinkMockScenario) {
        spendStatuses[id] = "pending_approval"
    }

    func syncSpend(id: String, scenario: LinkMockScenario) -> String {
        // First sync resolves the approval — approved unless the scenario
        // scripts a denial.
        let status = scenario == .denies ? "denied" : "approved"
        spendStatuses[id] = status
        return status
    }
}

/// Prices an edited itinerary by the server's rules (AssistantTools
/// .repriceStops) at the mock's own deterministic rates — the fixture's
/// per-hour prices: street $4.10 an hour, garage $12 an hour. A stop whose
/// time, length, kind, and place are unchanged keeps its proposed price; a
/// stop with no set time keeps its last price as an estimate; the app's
/// own costs are never read.
enum MockItineraryPricing {
    static let streetPerHour = 4.10
    static let garagePerHour = 12.0
    static let capUsd = 60.0

    static func reprice(_ stops: [ItineraryStop], proposed: [ItineraryStop]) -> [ItineraryStop] {
        let previous = Dictionary(uniqueKeysWithValues: proposed.map { ($0.id, $0) })
        return ItineraryOrder.normalized(stops.map { stop in
            let prior = previous[stop.id]
            var priced = stop
            priced.costUsd = prior?.costUsd ?? 0
            priced.estimate = prior?.estimate
            if ItineraryOrder.arrival(of: stop) == nil {
                priced.estimate = true
                return priced
            }
            if let prior, !changed(stop, from: prior) { return priced }
            let rate = stop.choice == "garage" ? garagePerHour : streetPerHour
            priced.costUsd = (rate * Double(stop.durationMinutes) / 60 * 100).rounded() / 100
            priced.estimate = nil
            return priced
        })
    }

    static func total(_ stops: [ItineraryStop]) -> Double {
        (stops.reduce(0) { $0 + $1.costUsd } * 100).rounded() / 100
    }

    private static func changed(_ stop: ItineraryStop, from prior: ItineraryStop) -> Bool {
        stop.choice != prior.choice
            || stop.durationMinutes != prior.durationMinutes
            || stop.lat != prior.lat
            || stop.lng != prior.lng
            || ItineraryOrder.arrival(of: stop) != ItineraryOrder.arrival(of: prior)
    }
}

enum MockAssistantFixtures {
    /// Facility checkout with the window prefilled, as the real SpotHero
    /// provider now emits (docs/assistant-verification.md).
    static let museumDeepLink =
        "https://spothero.com/checkout/135220?starts=2026-01-05T14%3A00%3A00&ends=2026-01-05T15%3A30%3A00"
    /// ParkWhiz's own site:purchase link, the shape the live API returns.
    static let valetDeepLink =
        "https://www.parkwhiz.com/find_and_book/?location_id=15398&start_time=2026-01-05T14:00:00-05:00&end_time=2026-01-05T15:30:00-05:00"

    static var singleSpotPlan: AssistantReply.ProposedPlan {
        plan(
            id: "mock-plan-single",
            json: """
            {
              "kind": "single_spot",
              "note": "Street is cheapest; the deck is closest.",
              "destination": {"lat": 42.3394, "lng": -71.0940, "label": "Museum of Fine Arts"},
              "provenance": {"provider": "parkwhiz+spothero", "searchedAt": "2026-01-05T14:00:00-05:00"},
              "recommendedReason": "Cheapest and closest — $4.10, 2 min walk",
              "options": [
                {"id": "opt-street", "type": "street", "label": "Street — Zone 81234",
                 "detail": "Boylston St meter, 2 min walk", "priceUsd": 4.10,
                 "durationMinutes": 90, "walkMinutes": 2, "zoneId": "bos-boylston-st-e-d-819305",
                 "lat": 42.3399, "lng": -71.0951, "recommended": true,
                 "street": "Boylston St", "zoneNumber": "81234", "streetState": "metered_then_free",
                 "streetSummary": "Metered until 8 PM, then free on Boylston St — 2 min walk",
                 "priceBreakdown": {"meterUsd": 3.75, "feeUsd": 0.35}, "ratePerHourUsd": 3.75,
                 "hoursToday": [{"start": "08:00", "end": "20:00"}], "maxStayMinutes": 120,
                 "exceedsMaxStay": false},
                {"id": "opt-garage", "type": "garage", "label": "Museum Underground Deck",
                 "detail": "Self park, covered", "priceUsd": 18.00, "durationMinutes": 90,
                 "walkMinutes": 3, "entryType": "self", "garageOptionId": "g1",
                 "lat": 42.3385, "lng": -71.0925, "provider": "spothero",
                 "deepLink": "\(museumDeepLink)", "recommended": false},
                {"id": "opt-garage-2", "type": "garage", "label": "Fenway Valet Plaza",
                 "detail": "Valet", "priceUsd": 24.00, "durationMinutes": 90,
                 "walkMinutes": 6, "entryType": "valet", "garageOptionId": "g2",
                 "lat": 42.3428, "lng": -71.0972, "provider": "parkwhiz",
                 "deepLink": "\(valetDeepLink)", "recommended": false}
              ]
            }
            """
        )
    }

    /// "Garage near Fenway at 7 Saturday" — the street option is for a
    /// future time, so it carries no Confirm at all.
    static var futureStreetPlan: AssistantReply.ProposedPlan {
        plan(
            id: "mock-plan-future",
            json: """
            {
              "kind": "single_spot",
              "note": "The meter is cheapest if you're parking there Saturday.",
              "destination": {"lat": 42.3467, "lng": -71.0972, "label": "Fenway Park"},
              "provenance": {"provider": "spothero", "searchedAt": "2026-01-05T14:00:00-05:00"},
              "options": [
                {"id": "opt-street-later", "type": "street", "label": "Street — Zone 81112",
                 "detail": "Van Ness St meter", "priceUsd": 7.50, "durationMinutes": 180,
                 "walkMinutes": 3, "zoneId": "bos-van-ness-st-a-1",
                 "lat": 42.3461, "lng": -71.0965,
                 "street": "Van Ness St", "zoneNumber": "81112", "streetState": "metered",
                 "streetSummary": "$2.50/hr, 3 hr max on Van Ness St — 3 min walk",
                 "priceBreakdown": {"meterUsd": 7.15, "feeUsd": 0.35}, "ratePerHourUsd": 2.50,
                 "hoursToday": [{"start": "08:00", "end": "22:00"}], "maxStayMinutes": 180,
                 "exceedsMaxStay": false,
                 "startsAt": "2026-01-10T19:00:00-05:00", "payOnArrival": true,
                 "recommended": true},
                {"id": "opt-garage-fenway", "type": "garage", "label": "Landsdowne Garage",
                 "detail": "Self park", "priceUsd": 32.00, "durationMinutes": 180,
                 "walkMinutes": 4, "entryType": "self", "garageOptionId": "g9",
                 "lat": 42.3475, "lng": -71.0989, "provider": "spothero",
                 "deepLink": "\(museumDeepLink)", "recommended": false}
              ]
            }
            """
        )
    }

    /// Six stops across a Boston day — the sign-off fixture. stop-N arrives
    /// at (9+N):00, but they're listed OUT of arrival order on purpose, so
    /// the UI tests prove the app sorts them rather than trusting the
    /// order they came in.
    static var itineraryPlan: AssistantReply.ProposedPlan {
        let stops = [4, 1, 6, 2, 5, 3].map { i in
            let garage = i % 3 == 0
            return """
            {"id": "stop-\(i)", "label": "\(stopLabels[i - 1])", "address": "\(i)00 Boylston St",
             "lat": \(42.348 + Double(i) * 0.004), "lng": \(-71.08 - Double(i) * 0.003),
             "arrival": "2026-01-05T\(9 + i):00:00-05:00", "durationMinutes": 60,
             "choice": "\(garage ? "garage" : "street")", "costUsd": \(garage ? 12.0 : 4.1),
             \(garage ? "\"garageOptionId\": \"g\(i)\", \"deepLink\": \"\(museumDeepLink)\"," : "\"zoneId\": \"bos-stop-\(i)\",")
             "sessionId": null}
            """
        }
        return plan(
            id: "mock-plan-day",
            json: """
            {"kind": "itinerary", "date": "2026-01-05",
             "stops": [\(stops.joined(separator: ","))],
             "totalUsd": 40.40, "capUsd": 60,
             "note": "Two garage stops where meters cap at 1 hour."}
            """
        )
    }

    /// The two locations of one steakhouse, as the server's ambiguous
    /// place search offers them.
    static let mooChoices = [
        AssistantSuggestion(label: "Mooo.... · 15 Beacon St, Beacon Hill", reply: "Mooo...., 15 Beacon St"),
        AssistantSuggestion(label: "Mooo.... · 49 Melcher St, Seaport", reply: "Mooo...., 49 Melcher St"),
    ]

    private static let stopLabels = [
        "Coffee — Tatte", "Client, Back Bay", "Lunch — Time Out", "MFA meeting",
        "Fenway errand", "Dinner — North End",
    ]

    private static func plan(id: String, json: String) -> AssistantReply.ProposedPlan {
        let wrapped = "{\"planId\": \"\(id)\", \"plan\": \(json)}"
        // Fixtures are compile-time constants; a decode failure here is a
        // programmer error and should crash loudly in DEBUG.
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(AssistantReply.ProposedPlan.self, from: Data(wrapped.utf8))
    }
}

// MARK: - MockAPI conformance

extension MockAPI {
    private var assistantScenario: AssistantMockScenario {
        AssistantMockScenario(
            rawValue: UserDefaults.standard.string(forKey: AssistantMockScenario.defaultsKey) ?? ""
        ) ?? .auto
    }

    private var linkScenario: LinkMockScenario {
        LinkMockScenario(rawValue: UserDefaults.standard.string(forKey: LinkMockScenario.defaultsKey) ?? "")
            ?? .disconnected
    }

    func assistantMessage(
        text: String,
        conversationId: String?,
        location: (lat: Double, lng: Double)?
    ) -> AsyncThrowingStream<AssistantEvent, Error> {
        let scenario = assistantScenario
        return AsyncThrowingStream { continuation in
            Task {
                func finish(
                    reply: String,
                    plan: AssistantReply.ProposedPlan?,
                    suggestions: [AssistantSuggestion]? = nil
                ) async {
                    // Stream word-by-word so the typing UI is visible.
                    let words = reply.split(separator: " ", omittingEmptySubsequences: false)
                    for (index, word) in words.enumerated() {
                        continuation.yield(.delta(String(word) + " "))
                        try? await Task.sleep(for: .milliseconds(30))
                        // The plan is its own event and lands mid-stream,
                        // like the server's: the card renders before the
                        // reply finishes.
                        if index == words.count / 2, let plan {
                            continuation.yield(.plan(plan))
                        }
                    }
                    continuation.yield(.done(AssistantReply(
                        conversationId: conversationId ?? "mock-conv-1",
                        reply: reply,
                        plan: plan,
                        suggestions: suggestions
                    )))
                    continuation.finish()
                }

                let lower = text.lowercased()
                // A bare chain name is ambiguous — the server asks which
                // location; a tapped choice carries the street address.
                let asksWhichPlace =
                    (scenario == .placeChoices || scenario == .auto)
                    && lower.contains("moo") && !lower.contains("melcher") && !lower.contains("beacon st")
                let wantsDay =
                    scenario == .itinerary
                    || (scenario == .auto
                        && (lower.contains("day") || lower.contains("stops") || lower.contains("errand")))
                if asksWhichPlace {
                    await finish(
                        reply: "I found two Mooo.... steakhouses — which one?",
                        plan: nil,
                        suggestions: MockAssistantFixtures.mooChoices
                    )
                    return
                }
                switch scenario {
                case .error:
                    continuation.finish(throwing: APIError.server(status: 500))
                case .refuse:
                    await finish(reply: "I can only help with parking — finding a spot or planning a day of stops.", plan: nil)
                case .futureStreet:
                    await finish(
                        reply: "Saturday at 7 near Fenway — the meter is cheapest.",
                        plan: MockAssistantFixtures.futureStreetPlan
                    )
                case .itinerary, .singleSpot, .auto, .placeChoices:
                    if scenario == .refuse { return }
                    if wantsDay {
                        await finish(
                            reply: "Here's your day — six stops, $40.40 of the $60.00 budget.",
                            plan: MockAssistantFixtures.itineraryPlan
                        )
                    } else {
                        await finish(
                            reply: "Two garages and a meter nearby. Street is cheapest.",
                            plan: MockAssistantFixtures.singleSpotPlan
                        )
                    }
                }
            }
        }
    }

    func priceItinerary(planId: String, stops: [ItineraryStop]) async throws -> ItineraryPriceResponse {
        try await Task.sleep(for: .milliseconds(300))
        guard case .itinerary(let plan) = MockAssistantFixtures.itineraryPlan.plan else {
            throw APIError.server(status: 500)
        }
        let priced = MockItineraryPricing.reprice(stops, proposed: plan.stops)
        let total = MockItineraryPricing.total(priced)
        return ItineraryPriceResponse(
            planId: planId,
            stops: priced,
            totalUsd: total,
            capUsd: MockItineraryPricing.capUsd,
            spentTodayUsd: 0,
            remainingUsd: MockItineraryPricing.capUsd,
            fitsCap: total <= MockItineraryPricing.capUsd
        )
    }

    func confirmPlan(planId: String, optionId: String?, stops: [ItineraryStop]?) async throws -> AssistantConfirmResponse {
        try await Task.sleep(for: .milliseconds(300))
        // The Wallet decides, like the server: Link only when it's the
        // active way to pay (and connected), and only for garages.
        let linked = await MockAssistantStore.shared.isLinkConnected(scenario: linkScenario)
        let active = await MockWalletStore.shared.activeSource()
        let linkActive = linked && active == .linkWallet
        let streetSource = active == .parkagentCard ? "parkagent_card" : "provider_card"

        if planId == "mock-plan-day" || optionId == nil {
            guard case .itinerary(let proposed) = MockAssistantFixtures.itineraryPlan.plan else {
                throw APIError.server(status: 500)
            }
            // Like the server: the card's edits are re-priced and signed
            // off, refused over the day's cap.
            var plan = proposed
            if let stops {
                let priced = MockItineraryPricing.reprice(stops, proposed: proposed.stops)
                let total = MockItineraryPricing.total(priced)
                if total > MockItineraryPricing.capUsd {
                    throw APIError.refused(code: "over_daily_cap")
                }
                plan = ItineraryPlan(
                    date: proposed.date, stops: priced, totalUsd: total,
                    capUsd: proposed.capUsd, note: proposed.note
                )
            }
            let summary = await MockAssistantStore.shared.signOff(
                plan: plan,
                linkActive: linkActive,
                streetSource: streetSource
            )
            return AssistantConfirmResponse(
                kind: "itinerary_signed_off", deepLink: nil, zoneId: nil,
                providerZoneNumber: nil, durationMinutes: nil,
                paymentSource: active.rawValue,
                linkApproval: nil, itineraryId: summary.id, totalUsd: summary.totalUsd,
                linkApprovals: linkActive
                    ? summary.stops.filter { $0.choice == "garage" && $0.costUsd > 0 }.map {
                        .init(stopId: $0.id, spendRequestId: "lsrq_mock_\($0.id)", approvalUrl: "https://app.link.com/activity/approve/x")
                    }
                    : nil,
                note: nil
            )
        }
        // Both single-spot fixtures confirm through here; the future-street
        // option is unreachable by design (its card has no button), and the
        // server 409s street_pay_on_arrival if anything ever asks.
        let candidates: [SingleSpotOption] = [
            MockAssistantFixtures.singleSpotPlan.plan,
            MockAssistantFixtures.futureStreetPlan.plan,
        ].flatMap { planCase -> [SingleSpotOption] in
            guard case .singleSpot(let single) = planCase else { return [] }
            return single.options
        }
        guard let option = candidates.first(where: { $0.id == optionId }) else {
            throw APIError.invalidRequest("unknown option")
        }
        if option.payOnArrival == true {
            throw APIError.refused(code: "street_pay_on_arrival")
        }
        if option.type == "garage" {
            let approval: AssistantConfirmResponse.LinkApproval? = linkActive
                ? .init(spendRequestId: "lsrq_mock_1", approvalUrl: "https://app.link.com/activity/approve/lsrq_mock_1")
                : nil
            if linkActive { await MockAssistantStore.shared.createSpend(id: "lsrq_mock_1", scenario: linkScenario) }
            return AssistantConfirmResponse(
                kind: "garage_handoff", deepLink: option.deepLink, zoneId: nil,
                providerZoneNumber: nil, durationMinutes: nil,
                paymentSource: linkActive ? "link_wallet" : "garage_checkout",
                linkApproval: approval, itineraryId: nil, totalUsd: nil, linkApprovals: nil,
                // The server's wording (garageHandoffNote): the site the
                // option came from, not always SpotHero.
                note: option.provider.flatMap(GarageSource.displayName).map {
                    "Checkout finishes in \($0); the parking pass will live in your \($0) account."
                } ?? "Checkout finishes on the garage's own site; the parking pass will live there."
            )
        }
        return AssistantConfirmResponse(
            kind: "street_confirmed", deepLink: nil, zoneId: option.zoneId,
            // The number a user could check against the posted sign, like
            // the real server sends ("Street — Zone 81234" option).
            providerZoneNumber: "81234",
            durationMinutes: option.durationMinutes,
            // A street meter never goes to Link (the provider keeps one
            // saved card): it pays with the street source.
            paymentSource: streetSource,
            linkApproval: nil, itineraryId: nil, totalUsd: nil, linkApprovals: nil, note: nil
        )
    }

    func itineraries() async throws -> ItinerariesResponse {
        ItinerariesResponse(itineraries: await MockAssistantStore.shared.itineraries)
    }

    func patchItinerary(id: String, stops: [ItineraryStop]) async throws -> ItineraryPatchResponse {
        guard let updated = await MockAssistantStore.shared.patch(id: id, stops: stops) else {
            throw APIError.server(status: 404)
        }
        return ItineraryPatchResponse(id: updated.id, stops: updated.stops, totalUsd: updated.totalUsd, capUsd: 60)
    }

    func linkWalletStatus() async throws -> LinkWalletStatus {
        LinkWalletStatus(
            configured: true,
            connected: await MockAssistantStore.shared.isLinkConnected(scenario: linkScenario),
            connectedAt: nil
        )
    }

    func linkWalletConnect() async throws -> LinkConnectResponse {
        // The mock "OAuth" connects instantly; the URL is decorative.
        await MockAssistantStore.shared.setLinkConnected(true)
        return LinkConnectResponse(url: "https://login.link.com/auth?mock=1")
    }

    func linkWalletDisconnect() async throws {
        await MockAssistantStore.shared.setLinkConnected(false)
    }

    func syncLinkSpendRequest(id: String) async throws -> LinkSpendSyncResponse {
        LinkSpendSyncResponse(id: id, status: await MockAssistantStore.shared.syncSpend(id: id, scenario: linkScenario))
    }
}
#endif
