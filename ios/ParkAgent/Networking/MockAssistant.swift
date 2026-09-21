import Foundation

// Mock assistant + Link wallet: scripted plans for both jobs so the
// sheet, plan cards, itinerary board, and UI tests all run without a
// server or an Anthropic key.

enum AssistantMockScenario: String, CaseIterable, Identifiable, Sendable {
    /// Text mentioning a day/multiple stops gets the itinerary; else single.
    case auto
    case singleSpot
    case itinerary
    /// The parking-only refusal sentence.
    case refuse
    case error

    static let defaultsKey = "assistantScenario"
    var id: String { rawValue }
}

enum LinkMockScenario: String, CaseIterable, Identifiable, Sendable {
    case disconnected
    case connected
    /// Configured but the approval flow denies.
    case denies

    static let defaultsKey = "linkScenario"
    var id: String { rawValue }
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

    func signOff(plan: ItineraryPlan, linked: Bool) -> ItinerarySummary {
        let summary = ItinerarySummary(
            id: "mock-day-\(itineraries.count + 1)",
            status: "signed_off",
            date: plan.date,
            stops: plan.stops.map { stop in
                var s = stop
                s.paymentSource = linked && stop.costUsd > 0 ? "link_wallet" : "issuing_card"
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
        let updated = ItinerarySummary(
            id: old.id,
            status: old.status,
            date: old.date,
            stops: stops,
            totalUsd: (stops.reduce(0) { $0 + $1.costUsd } * 100).rounded() / 100
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

enum MockAssistantFixtures {
    static let museumDeepLink =
        "https://spothero.com/search?latitude=42.3395&longitude=-71.094&starts=2026-01-05T14%3A00"

    static var singleSpotPlan: AssistantReply.ProposedPlan {
        plan(
            id: "mock-plan-single",
            json: """
            {
              "kind": "single_spot",
              "note": "Street is cheapest; the deck is closest.",
              "options": [
                {"id": "opt-street", "type": "street", "label": "Street — Zone 81234",
                 "detail": "Boylston St meter, 2 min walk", "priceUsd": 4.10,
                 "durationMinutes": 90, "walkMinutes": 2, "zoneId": "bos-boylston-st-e-d-819305",
                 "recommended": true},
                {"id": "opt-garage", "type": "garage", "label": "Museum Underground Deck",
                 "detail": "Self park, covered", "priceUsd": 18.00, "durationMinutes": 90,
                 "walkMinutes": 3, "entryType": "self", "garageOptionId": "g1",
                 "deepLink": "\(museumDeepLink)", "recommended": false},
                {"id": "opt-garage-2", "type": "garage", "label": "Fenway Valet Plaza",
                 "detail": "Valet", "priceUsd": 24.00, "durationMinutes": 90,
                 "walkMinutes": 6, "entryType": "valet", "garageOptionId": "g2",
                 "deepLink": "\(museumDeepLink)", "recommended": false}
              ]
            }
            """
        )
    }

    /// Six stops across a Boston day — the sign-off fixture.
    static var itineraryPlan: AssistantReply.ProposedPlan {
        let stops = (1...6).map { i in
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
                func finish(reply: String, plan: AssistantReply.ProposedPlan?) async {
                    // Stream word-by-word so the typing UI is visible.
                    for word in reply.split(separator: " ", omittingEmptySubsequences: false) {
                        continuation.yield(.delta(String(word) + " "))
                        try? await Task.sleep(for: .milliseconds(30))
                    }
                    continuation.yield(.done(AssistantReply(
                        conversationId: conversationId ?? "mock-conv-1",
                        reply: reply,
                        plan: plan
                    )))
                    continuation.finish()
                }

                let lower = text.lowercased()
                let wantsDay =
                    scenario == .itinerary
                    || (scenario == .auto
                        && (lower.contains("day") || lower.contains("stops") || lower.contains("errand")))
                switch scenario {
                case .error:
                    continuation.finish(throwing: APIError.server(status: 500))
                case .refuse:
                    await finish(reply: "I can only help with parking — finding a spot or planning a day of stops.", plan: nil)
                case .itinerary, .singleSpot, .auto:
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

    func confirmPlan(planId: String, optionId: String?) async throws -> AssistantConfirmResponse {
        try await Task.sleep(for: .milliseconds(300))
        let linked = await MockAssistantStore.shared.isLinkConnected(scenario: linkScenario)
        let approval: AssistantConfirmResponse.LinkApproval? = linked
            ? .init(spendRequestId: "lsrq_mock_1", approvalUrl: "https://app.link.com/activity/approve/lsrq_mock_1")
            : nil
        if linked { await MockAssistantStore.shared.createSpend(id: "lsrq_mock_1", scenario: linkScenario) }

        if planId == "mock-plan-day" || optionId == nil {
            guard case .itinerary(let plan) = MockAssistantFixtures.itineraryPlan.plan else {
                throw APIError.server(status: 500)
            }
            let summary = await MockAssistantStore.shared.signOff(plan: plan, linked: linked)
            return AssistantConfirmResponse(
                kind: "itinerary_signed_off", deepLink: nil, zoneId: nil, durationMinutes: nil,
                paymentSource: linked ? "link_wallet" : "issuing_card",
                linkApproval: nil, itineraryId: summary.id, totalUsd: summary.totalUsd,
                linkApprovals: linked
                    ? summary.stops.filter { $0.costUsd > 0 }.map {
                        .init(stopId: $0.id, spendRequestId: "lsrq_mock_\($0.id)", approvalUrl: "https://app.link.com/activity/approve/x")
                    }
                    : nil,
                note: nil
            )
        }
        guard case .singleSpot(let plan) = MockAssistantFixtures.singleSpotPlan.plan,
              let option = plan.options.first(where: { $0.id == optionId }) else {
            throw APIError.invalidRequest("unknown option")
        }
        if option.type == "garage" {
            return AssistantConfirmResponse(
                kind: "garage_handoff", deepLink: option.deepLink, zoneId: nil, durationMinutes: nil,
                paymentSource: linked ? "link_wallet" : "issuing_card",
                linkApproval: approval, itineraryId: nil, totalUsd: nil, linkApprovals: nil,
                note: "Checkout finishes in SpotHero; the parking pass will live in your SpotHero account."
            )
        }
        return AssistantConfirmResponse(
            kind: "street_confirmed", deepLink: nil, zoneId: option.zoneId,
            durationMinutes: option.durationMinutes,
            paymentSource: linked ? "link_wallet" : "issuing_card",
            linkApproval: approval, itineraryId: nil, totalUsd: nil, linkApprovals: nil, note: nil
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
