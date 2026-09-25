import CoreLocation
import Foundation

// The assistant wire contract (server/API.md "Assistant"). Plans render
// as cards; nothing books or pays until the user's Confirm/Sign off tap
// hits POST /assistant/confirm.

/// One streamed event from POST /assistant/message. The plan arrives as
/// its own event the moment propose_plan lands, so the card renders
/// before the reply text finishes streaming.
enum AssistantEvent: Sendable {
    case delta(String)
    case plan(AssistantReply.ProposedPlan)
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
    /// The place the user asked about, geocoded server-side — the mini
    /// map's destination pin. Absent when they asked about "here".
    let destination: Destination?
    /// Where garage options came from and when the search ran; the card
    /// shows it once under the list ("Garage prices from ParkWhiz and
    /// SpotHero, checked 2:05 PM").
    let provenance: Provenance?

    struct Destination: Decodable, Sendable {
        let lat: Double
        let lng: Double
        let label: String
    }

    struct Provenance: Decodable, Sendable {
        let provider: String
        let searchedAt: String
    }

    /// The one option carrying the badge — the hero card. Falls back to
    /// the first option so a plan always has a hero.
    var recommendedOption: SingleSpotOption? {
        options.first(where: \.recommended) ?? options.first
    }

    /// Everything else, in the order the server sent it.
    var otherOptions: [SingleSpotOption] {
        guard let hero = recommendedOption else { return [] }
        return options.filter { $0.id != hero.id }
    }
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
    /// Server-attached on garage options: which site the offer came from
    /// ("spothero" | "parkwhiz") — where checkout finishes and the pass lives.
    let provider: String?
    let recommended: Bool
    /// ISO start of the stay, when the plan is for later.
    let startsAt: String?
    /// Server-computed: a future street meter can't be started now — the
    /// detector pays on arrival, so the card shows that instead of Confirm.
    let payOnArrival: Bool?
    /// Where the option is, for the mini map's pins. Server-attached from
    /// the garage search cache or the street quote's point.
    let lat: Double?
    let lng: Double?

    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

/// The garage sources the server merges. One place for their names, so the
/// card's button, the provenance line, and anything else that names where
/// checkout happens agree with the option's own `provider`.
enum GarageSource {
    static func displayName(_ id: some StringProtocol) -> String? {
        switch id {
        case "spothero": "SpotHero"
        case "parkwhiz": "ParkWhiz"
        default: nil
        }
    }
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
    /// "provider_card" | "parkagent_card" (street) · "link_wallet" |
    /// "garage_checkout" (garages) — what pays this confirm.
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
