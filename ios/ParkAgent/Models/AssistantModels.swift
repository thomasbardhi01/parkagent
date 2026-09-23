import Foundation

// The assistant wire contract (server/API.md "Assistant"). Plans render
// as cards; nothing books or pays until the user's Confirm/Sign off tap
// hits POST /assistant/confirm.

/// One streamed event from POST /assistant/message.
enum AssistantEvent: Sendable {
    case delta(String)
    case done(AssistantReply)
}

struct AssistantReply: Decodable, Sendable {
    let conversationId: String
    let reply: String
    let plan: ProposedPlan?

    struct ProposedPlan: Decodable, Sendable {
        let planId: String
        let plan: AssistantPlan
    }
}

enum AssistantPlan: Decodable, Sendable {
    case singleSpot(SingleSpotPlan)
    case itinerary(ItineraryPlan)

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let kind = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .kind)
        switch kind {
        case "single_spot": self = .singleSpot(try SingleSpotPlan(from: decoder))
        case "itinerary": self = .itinerary(try ItineraryPlan(from: decoder))
        default:
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Unknown plan kind \(kind)"
            ))
        }
    }
}

struct SingleSpotPlan: Decodable, Sendable {
    let options: [SingleSpotOption]
    let note: String?
}

struct SingleSpotOption: Decodable, Identifiable, Sendable {
    let id: String
    /// "street" | "garage"
    let type: String
    let label: String
    let detail: String
    let priceUsd: Double
    let durationMinutes: Int
    let walkMinutes: Int?
    let entryType: String?
    let zoneId: String?
    let garageOptionId: String?
    let deepLink: String?
    let recommended: Bool
    /// ISO start of the stay, when the plan is for later.
    let startsAt: String?
    /// Server-computed: a future street meter can't be started now — the
    /// detector pays on arrival, so the card shows that instead of Confirm.
    let payOnArrival: Bool?
}

struct ItineraryPlan: Decodable, Sendable {
    let date: String
    let stops: [ItineraryStop]
    let totalUsd: Double
    let capUsd: Double
    let note: String?
}

struct ItineraryStop: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var label: String
    var address: String
    var lat: Double
    var lng: Double
    var arrival: String
    var durationMinutes: Int
    /// "street" | "garage"
    var choice: String
    var costUsd: Double
    var zoneId: String?
    var garageOptionId: String?
    var deepLink: String?
    /// Server-side linkage (read-only from the app's point of view).
    var sessionId: String?
    var paymentSource: String?
    var garageLinkPushedAt: String?
}

/// POST /assistant/confirm — what the tap unlocked.
struct AssistantConfirmResponse: Decodable, Sendable {
    /// "garage_handoff" | "street_confirmed" | "itinerary_signed_off"
    let kind: String
    let deepLink: String?
    let zoneId: String?
    /// The pay-by-app number the user can verify against the posted sign
    /// (street_confirmed; nil when the zone has none yet). `zoneId` is an
    /// internal slug and is never shown.
    let providerZoneNumber: String?
    let durationMinutes: Int?
    /// "issuing_card" | "link_wallet"
    let paymentSource: String?
    let linkApproval: LinkApproval?
    let itineraryId: String?
    let totalUsd: Double?
    let linkApprovals: [StopApproval]?
    let note: String?

    struct LinkApproval: Decodable, Sendable {
        let spendRequestId: String
        let approvalUrl: String?
    }

    struct StopApproval: Decodable, Sendable {
        let stopId: String
        let spendRequestId: String
        let approvalUrl: String?
    }
}

struct ItinerarySummary: Decodable, Identifiable, Sendable {
    let id: String
    let status: String
    let date: String
    let stops: [ItineraryStop]
    let totalUsd: Double
}

struct ItinerariesResponse: Decodable, Sendable {
    let itineraries: [ItinerarySummary]
}

struct ItineraryPatchResponse: Decodable, Sendable {
    let id: String
    let stops: [ItineraryStop]
    let totalUsd: Double
    let capUsd: Double
}

// Link wallet (server/API.md "Link wallet for agents").

struct LinkWalletStatus: Decodable, Sendable {
    let configured: Bool
    let connected: Bool
    let connectedAt: String?
}

struct LinkConnectResponse: Decodable, Sendable {
    let url: String
}

struct LinkSpendSyncResponse: Decodable, Sendable {
    let id: String
    let status: String
}
