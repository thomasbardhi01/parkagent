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
    /// Tappable answers to the question the reply asks ("which Mooo?",
    /// "how long?"); nil when it asks nothing.
    var suggestions: [AssistantSuggestion]?

    struct ProposedPlan: Decodable, Sendable {
        let planId: String
        let plan: AssistantPlan
    }
}

/// One tappable answer: the chip's text and the message it sends — the
/// user's words, sent exactly as if typed.
struct AssistantSuggestion: Decodable, Equatable, Hashable, Sendable {
    let label: String
    let reply: String
}

enum AssistantPlan: Decodable, Sendable {
    case singleSpot(SingleSpotPlan)
    case itinerary(ItineraryPlan)
    /// Nothing the search found met the request: the server's "no", with
    /// what came closest. Nothing on it can be confirmed.
    case noneMeets(NoneMeetsPlan)
    /// Nothing to offer at that place — a gap in the data, not a refusal.
    case noData(NoDataPlan)
    /// A kind this build doesn't know, shown as no card. It used to be a
    /// decoding error, which cost the whole reply — and, in a saved
    /// conversation, the whole conversation — for one card.
    case unsupported(kind: String)

    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: Decoder) throws {
        let kind = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .kind)
        switch kind {
        case "single_spot": self = .singleSpot(try SingleSpotPlan(from: decoder))
        case "itinerary": self = .itinerary(try ItineraryPlan(from: decoder))
        case "none_meets": self = .noneMeets(try NoneMeetsPlan(from: decoder))
        case "no_data": self = .noData(try NoDataPlan(from: decoder))
        default: self = .unsupported(kind: kind)
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
    /// Why the recommended option is on top, in one line, computed by the
    /// server from the options on the card ("Cheapest and closest — free,
    /// 4 min walk").
    var recommendedReason: String?
    /// What the plan assumed — the window and the place ("Sat 7:00–10:00
    /// PM, near LoLa 42, Seaport") — computed by the server from the plan.
    var assumptions: String?
    /// "meets": the options on this card meet the request (FR-45).
    var verdict: String?
    /// The request the card answered, for the request chips. Lenient: a
    /// summary this build can't read costs the chips, never the card.
    var requestSummary: Lenient<RequestSummary>?

    struct Destination: Decodable, Sendable {
        let lat: Double
        let lng: Double
        let label: String
    }

    struct Provenance: Decodable, Sendable {
        let provider: String
        let searchedAt: String
        /// "unavailable": the garage search failed, so the card holds
        /// street options only — "couldn't check", never "none".
        var garage: String?
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
    /// Server-attached on street options from the street search: the block
    /// during the stay in one line ("Free after 6 PM on Seaport Blvd — 4 min
    /// walk"), and the facts behind the detail card.
    var streetSummary: String?
    /// "free" | "metered" | "metered_then_free" | "free_then_metered" | "mixed"
    var streetState: String?
    var street: String?
    var zoneNumber: String?
    var priceBreakdown: PriceBreakdown?
    var ratePerHourUsd: Double?
    var hoursToday: [HoursInterval]?
    var maxStayMinutes: Int?
    var exceedsMaxStay: Bool?
    /// Server-attached from the search: what the option is the best on
    /// among those that meet the request — "cheapest" | "closest" | "both".
    var axis: String?
    /// The best option on the axis the user did NOT ask about: an
    /// alternative, never the recommendation.
    var secondary: Bool?
    /// The option breaks a limit of the request. Shown for information,
    /// with `violates` saying which and by how much; it has no Confirm.
    var nearMiss: Bool?
    var violates: [PlanViolation]?
    /// When this option's price was fetched (ISO).
    var fetchedAt: String?
    /// Server-attached (decision 8): the option leads the card — the one
    /// that honors the ask, or with no ask both the cheapest and the closest.
    var primary: Bool?
    /// Server-attached: the price is over the approval threshold, so
    /// confirming takes a long-press where a tap would do.
    var warn: Bool?

    struct PriceBreakdown: Decodable, Equatable, Sendable {
        let meterUsd: Double
        let feeUsd: Double
    }

    struct HoursInterval: Decodable, Equatable, Sendable {
        let start: String
        let end: String
    }

    /// The line under the option's name: the street search's own words for
    /// a street block, else what the plan said about it.
    var detailLine: String {
        streetSummary ?? detail
    }

    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

/// One limit of the request an option breaks: the limit and the actual,
/// both the server's.
struct PlanViolation: Decodable, Equatable, Sendable {
    /// "maxPriceUsd" | "maxWalkMinutes" | "kinds" | "entryType" | "covered"
    let field: String
    let actual: PlanLimitValue
    let limit: PlanLimitValue
}

/// A value on either side of a limit: a price or a walk (number), a kind
/// or an entry type (text), covered (flag), the kinds allowed (list).
enum PlanLimitValue: Decodable, Equatable, Sendable {
    case number(Double)
    case text(String)
    case flag(Bool)
    case list([String])
    case none

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() {
            self = .none
        } else if let flag = try? value.decode(Bool.self) {
            self = .flag(flag)
        } else if let number = try? value.decode(Double.self) {
            self = .number(number)
        } else if let text = try? value.decode(String.self) {
            self = .text(text)
        } else if let list = try? value.decode([String].self) {
            self = .list(list)
        } else {
            self = .none
        }
    }

    var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var text: String? {
        if case .text(let value) = self { return value }
        return nil
    }
}

/// "Nothing meets this", decided and filled by the server (server/API.md
/// "Searching the request, and saying no"). The reply is its `headline`.
struct NoneMeetsPlan: Decodable, Sendable {
    let headline: String
    let constraintsFailed: [ConstraintFailed]
    /// Up to three options that came closest, each with what it breaks.
    let nearMisses: [SingleSpotOption]
    let relaxSuggestions: [RelaxSuggestion]
    let destination: SingleSpotPlan.Destination?
    let provenance: SingleSpotPlan.Provenance?
    var assumptions: String?
    /// "none_meets" (FR-45).
    var verdict: String?
    var requestSummary: Lenient<RequestSummary>?

    struct ConstraintFailed: Decodable, Sendable {
        let field: String
        let limit: PlanLimitValue?
        let nearestActual: PlanLimitValue?
        let reason: String?
    }

    /// What relaxing one limit a step would yield. The ones worth a tap
    /// arrive as the reply's suggestions; a tap sends `reply`.
    struct RelaxSuggestion: Decodable, Sendable {
        let field: String
        let wouldYield: Int
        let label: String
        let reply: String
    }

    /// The garage search itself was down on a garage-only request.
    var garageSearchUnavailable: Bool {
        constraintsFailed.contains { $0.field == "garageSearch" }
    }
}

/// "We have nothing to offer there": the nearest zones we do have.
struct NoDataPlan: Decodable, Sendable {
    let rule: String
    let headline: String
    let radiusM: Int
    let nearestZones: [NearestZone]
    let destination: SingleSpotPlan.Destination?
    let provenance: SingleSpotPlan.Provenance?
    var assumptions: String?
    var requestSummary: Lenient<RequestSummary>?

    struct NearestZone: Decodable, Identifiable, Sendable {
        let zoneId: String
        let street: String?
        let zoneNumber: String?
        let distanceM: Int
        let walkMinutes: Int
        let lat: Double?
        let lng: Double?

        var id: String { zoneId }
    }
}

/// The request a card answered (server/API.md "The request a card
/// answered"): the conversation's request as the server held it, without
/// its log, plus what the server assumed that the request doesn't say. The
/// app shows it as chips and never edits it — a chip sends a message.
struct RequestSummary: Decodable, Equatable, Sendable {
    let version: Int
    /// "park_now" | "park_later" | "garage_or_lot"
    let intent: String
    let place: Place
    let window: Window
    let hard: Hard
    let soft: Soft
    var assumed: Assumed?

    struct Place: Decodable, Equatable, Sendable {
        /// What the user called it.
        let query: String?
        let resolved: Resolved?

        struct Resolved: Decodable, Equatable, Sendable {
            let label: String
        }
    }

    struct Window: Decodable, Equatable, Sendable {
        /// ISO start; nil is now.
        let startsAt: String?
        let durationMinutes: Int?
    }

    /// The limits an option must meet; nil is unset.
    struct Hard: Decodable, Equatable, Sendable {
        let maxPriceUsd: Double?
        let maxWalkMinutes: Int?
        /// "street" | "garage"
        let kinds: [String]?
        /// "self" | "valet"
        let entryType: String?
        let covered: Bool?
    }

    struct Soft: Decodable, Equatable, Sendable {
        /// "cheapest" | "closest" | "balanced"; nil when the user asked for none.
        let rank: String?
    }

    /// What the server filled in: the phone's location as the place
    /// ("phone_location"), and the stay a search for right now assumed.
    struct Assumed: Decodable, Equatable, Sendable {
        let place: String?
        let durationMinutes: Int?
    }
}

/// A value that decodes to nil instead of failing its parent: for a part
/// of a payload the screen can do without.
struct Lenient<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
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
    /// The day and window the plan covers ("Mon 3 stops, 10:00 AM–4:30 PM").
    var assumptions: String?
}

struct ItineraryStop: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var label: String
    var address: String
    var lat: Double
    var lng: Double
    /// ISO arrival; nil when the user cleared it ("no set time"). Only an
    /// untimed stop is placed by hand — see ItineraryOrder.
    var arrival: String?
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
    /// The server carried an earlier price over instead of quoting these
    /// inputs (no set time, or the quote couldn't be made): shown "≈".
    var estimate: Bool?
}

/// POST /assistant/plans/:planId/price — the itinerary card's live price,
/// computed on the server for the stops as the user left them (the app's
/// own costs are never read). `fitsCap` is the test sign-off applies.
struct ItineraryPriceResponse: Decodable, Sendable {
    let planId: String
    let stops: [ItineraryStop]
    let totalUsd: Double
    let capUsd: Double
    let spentTodayUsd: Double
    let remainingUsd: Double
    let fitsCap: Bool
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

// Saved conversations (server/API.md "Saved conversations").

/// One row of the assistant's history list.
struct ConversationSummary: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    /// The first request.
    let title: String
    let createdAt: Date
    let updatedAt: Date
    let messageCount: Int
    /// What it came to — a booking or plan — if anything.
    let outcome: ConversationOutcome?
}

struct ConversationOutcome: Decodable, Equatable, Sendable {
    /// "garage" | "street" | "itinerary" (confirmed) · "proposed"
    let kind: String
    let label: String
    let amountUsd: Double?
    let planId: String
}

struct ConversationsResponse: Decodable, Sendable {
    let conversations: [ConversationSummary]
    let nextCursor: String?
    /// How long a conversation is kept after it was last used.
    let retentionDays: Int
}

/// A saved conversation, opened to read or resume.
struct ConversationDetail: Decodable, Sendable {
    let id: String
    let title: String
    let messages: [ConversationMessage]
    let plans: [StoredPlan]
    let outcome: ConversationOutcome?
}

struct ConversationMessage: Decodable, Sendable {
    /// "user" | "assistant"
    let role: String
    let text: String
    let planId: String?
    let suggestions: [AssistantSuggestion]?
}

/// A plan as it was proposed, and what the user did with it.
struct StoredPlan: Decodable, Sendable {
    let planId: String
    let plan: AssistantPlan
    let confirmedAt: Date?
    let confirmedOptionId: String?
}

struct ConversationsDeleted: Decodable, Sendable {
    let deleted: Int
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
