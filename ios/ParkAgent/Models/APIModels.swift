import CoreLocation
import Foundation

// Wire types mirroring server/API.md. Field names match the JSON exactly;
// the policy document is snake_case on the wire, so those types carry
// explicit CodingKeys.

// MARK: - Identity (server/API.md "Authentication", "GET/PATCH /me")

/// GET /me — the profile plus the payment-source settings it carries.
/// GET /auth/methods — which sign-in methods the server accepts right now.
/// Apple is the only one on by default; email codes and Google each sit
/// behind a server switch.
struct AuthMethods: Codable, Sendable, Equatable {
    var apple: Bool
    var email: Bool
    var google: Bool

    /// What the welcome screen assumes until (or unless) the server says
    /// otherwise: never a button for a method that might be switched off.
    static let appleOnly = AuthMethods(apple: true, email: false, google: false)
}

struct MeResponse: Codable, Sendable {
    var user: AuthUser
    var paymentSource: PaymentSource
    var issuingLive: Bool
}

struct VehicleSummary: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var plate: String
    var state: String
    var label: String?

    /// "ABC 1234 · NY", or the nickname when the driver gave one.
    var displayName: String {
        label?.isEmpty == false ? label! : "\(plate) · \(state)"
    }
}

struct ParkedRequest: Codable, Sendable, Equatable {
    var lat: Double
    var lng: Double
    var accuracy: Double
    var ts: Date
    var signals: [String]
    /// The phone's own read of the place (FR-53); absent when there's none.
    var placeHint: PlaceHint? = nil
    /// The place outcomes this build can show (FR-54). The server answers
    /// `garage` and `nopay` only to an app that lists them; a park queued
    /// by a build from before them lists none, and is answered as before.
    var outcomes: [String]? = nil

    /// What this build shows: the garage and lot prompt, silence for a
    /// place with nothing to pay, and (FR-55) nothing at the car for a
    /// street park: it reports its fixes and waits for the walk-away.
    static let shownOutcomes = [ParkedAction.garage.rawValue, ParkedAction.nopay.rawValue, walkAwayOutcome]
    static let walkAwayOutcome = "walk_away"
}

/// The phone's own read of where it parked (PlaceClassifier, FR-53), sent
/// with /parked, where the server weighs it with the zones and garage
/// outlines it has (FR-54). Of the driver's saved places it says only
/// whether one matched: never a name or a center.
struct PlaceHint: Codable, Sendable, Equatable {
    struct Scored: Codable, Sendable, Equatable {
        var placeClass: String
        var confidence: Double

        enum CodingKeys: String, CodingKey {
            case placeClass = "class", confidence
        }
    }

    /// The last good fix of the car driving in.
    struct EntryFix: Codable, Sendable, Equatable {
        var lat: Double
        var lng: Double
        var accuracy: Double
        var ts: Date
    }

    struct Inputs: Codable, Sendable, Equatable {
        var located: Bool
        var memoryHit: Bool
        var footprintId: String?
        var containsPoint: Bool
        var nearestEntranceM: Double?
        var gpsLoss: Bool
        var baroDeltaM: Double?
        var crawl: Bool
    }

    /// street | garage | lot | nopay | unknown
    var placeClass: String
    var confidence: Double
    var runnerUp: Scored?
    /// The garage or lot, when the class is one.
    var garageId: String?
    var entryFix: EntryFix?
    var inputs: Inputs

    enum CodingKeys: String, CodingKey {
        case placeClass = "class", confidence, runnerUp, garageId, entryFix, inputs
    }
}

enum ParkedAction: String, Codable, Sendable {
    case pay
    case confirm
    case ignore
    case unknownZone = "unknown_zone"
    /// A garage, or a lot that charges: nothing ParkAgent pays in V1.
    /// Only answered to a request that lists it in `outcomes`.
    case garage
    /// Nothing to pay here, and nothing in reach would charge.
    case nopay
}

/// What kind of place /parked took the park for, and where that came from
/// (server/API.md "The place").
struct ParkedPlace: Codable, Sendable, Equatable {
    /// street | garage | lot | nopay | unknown
    var placeClass: String
    var confidence: Double
    /// The next best class; for `unknown`, the best guess, which fell short.
    var runnerUp: PlaceHint.Scored?
    /// The garage or lot in play, from the server's garages table.
    var garageId: String?
    var garageName: String?
    /// memory | hint | footprint | zones | none
    var source: String
    /// The line the garage's source asks for wherever its name is shown.
    var attribution: String?

    enum CodingKeys: String, CodingKey {
        case placeClass = "class", confidence, runnerUp, garageId, garageName, source, attribution
    }

    /// One of the driver's own saved places decided it.
    var isSavedPlace: Bool { source == "memory" }
}

/// POST /parked/:id/place — the driver's own answer about a park.
struct PlaceAnswerResponse: Codable, Sendable, Equatable {
    var ok: Bool
    var parkedEventId: String
    /// street | garage | lot | nopay | not_here
    var placeClass: String
    var name: String?
    /// The answer differs from what /parked said.
    var changed: Bool
    var decisionId: String

    enum CodingKeys: String, CodingKey {
        case ok, parkedEventId, placeClass = "class", name, changed, decisionId
    }
}

struct ParkedResponse: Codable, Sendable, Identifiable {
    var action: ParkedAction
    var candidates: [Candidate]
    var quote: Quote?
    var rule: String
    var dryRun: Bool
    /// Who runs this city's meters; nil when the zone is unknown or the
    /// city has no provider. `linked == false` routes into the link flow.
    var provider: ParkedProvider?
    /// True → the zone's pay-by-app number is unknown (Boston: the open
    /// data has none); the app collects it from the meter via
    /// POST /zones/:zoneId/provider-number before paying.
    var needsZoneNumber: Bool
    /// What kind of place this is (FR-54); nil from a server before it.
    var place: ParkedPlace? = nil
    /// True → the server holds this park until the phone leaves the car
    /// (FR-55): nothing is shown at the car, and it is paid through
    /// POST /parked/:id/confirm, never /session/start.
    var awaitsWalkAway: Bool? = nil
    var parkedEventId: String
    var decisionId: String

    var id: String { parkedEventId }
}

// MARK: - The street session lifecycle (FR-55; server/API.md "Session lifecycle")

/// What the phone shows at walk-away, word for word as the server wrote
/// it: the phone never composes an amount of its own.
struct ParkPrompt: Codable, Sendable, Equatable {
    /// `confirm`: a tap pays `amountUsd`. `side`: the two sides differ,
    /// pick one in the app. `attention`: something is in the way of
    /// paying here, and the body says what.
    var kind: String
    var parkedEventId: String
    var title: String
    var body: String
    var zoneId: String? = nil
    var zoneNumber: String? = nil
    var amountUsd: Double? = nil
    var minutes: Int? = nil
    var endsAt: Date? = nil
    /// The quote behind the amount: what the sheet shows for that side.
    var quote: Quote? = nil
    var reason: String? = nil
    var dryRun: Bool

    var payable: Bool { kind == "confirm" && amountUsd != nil }
}

/// POST /location's answer: where the park or session stands now.
struct LocationResponse: Codable, Sendable, Equatable {
    struct Park: Codable, Sendable, Equatable {
        var parkedEventId: String
        var status: String
    }

    struct Ended: Codable, Sendable, Equatable {
        var reason: String
        /// False where the provider can't stop early, or refused to.
        var stopped: Bool
        var error: String? = nil
    }

    var ok: Bool = true
    var sessionId: String? = nil
    /// A park waiting on its walk-away or its tap.
    var park: Park? = nil
    /// The phone has left the car: ask (repeated until answered).
    var prompt: ParkPrompt? = nil
    /// A Pay tapped at the car started now, at walk-away.
    var started: SessionStartResponse? = nil
    /// The phone came back to the car: the session is over.
    var ended: Ended? = nil
}

/// POST /parked/:id/confirm, the tap. Three good answers.
enum ParkConfirmOutcome: Sendable {
    case started(SessionStartResponse)
    /// Tapped at the car: kept, and paid when the phone leaves.
    case waitingForWalkAway
    case freePeriod(notice: String?)
}

struct ParkConfirmWire: Decodable, Sendable {
    var status: String?
    var notice: String?
    var sessionId: String?
    var expiresAt: Date?
    var amountUsd: Double?

    func outcome() throws -> ParkConfirmOutcome {
        switch status {
        case "confirmed":
            return .waitingForWalkAway
        case "free_period":
            return .freePeriod(notice: notice)
        default:
            guard let sessionId, let expiresAt, let amountUsd else {
                throw DecodingError.dataCorrupted(DecodingError.Context(
                    codingPath: [],
                    debugDescription: "parked/confirm response is neither started, confirmed, nor a free period"
                ))
            }
            return .started(SessionStartResponse(sessionId: sessionId, expiresAt: expiresAt, amountUsd: amountUsd))
        }
    }
}

/// POST /zones/:zoneId/provider-number — storing the number the driver
/// read off the meter. Verified once two different users agree.
struct ZoneNumberReportResponse: Codable, Sendable {
    var ok: Bool
    var zoneId: String
    /// The number now ON the zone — what the executor will type. Under
    /// import/verified precedence this can differ from what was reported.
    var number: String
    /// "report" | "import" | "verified" — which source won.
    var appliedSource: String?
    var verified: Bool
    var confirmations: Int
}

/// The provider block on /parked and /city responses.
struct ParkedProvider: Codable, Sendable, Equatable {
    var id: String
    var city: String
    var displayName: String
    var loginUrl: String
    /// "linked" | "expiring" | "expired" | "unlinked". "expiring" still
    /// pays — the health job just asked for a re-link before it dies.
    var status: String
    var linked: Bool
    /// Link-or-create metadata; absent on older servers.
    var signup: ProviderSignup?
}

/// How a user with NO account at this provider opens one, on the
/// provider's own page (server registry `signup`). The app prefills text
/// fields only — codes, PINs, terms, and captcha stay the user's.
struct ProviderSignup: Codable, Sendable, Equatable {
    var url: String
    /// "passwordless" (ParkBoston: code + PIN) | "form" (ParkNYC).
    var mode: String
    var note: String
    var prefill: [SignupPrefillField]

    var isPasswordless: Bool { mode == "passwordless" }
}

struct SignupPrefillField: Codable, Sendable, Equatable {
    /// "emailOrPhone" | "email" | "phone" | "firstName" | "lastName" | "zip" | "plate"
    var field: String
    var selector: String
}

struct Candidate: Codable, Sendable, Identifiable, Equatable {
    var zoneId: String
    /// "nyc" | "bos" — which city's meter system the zone belongs to.
    var city: String
    var providerZoneNumber: String
    var distanceM: Double
    var containsPoint: Bool
    var rateFirstHourUsd: Double
    var rateAdditionalHourUsd: Double
    var maxStayMinutes: Int
    var hours: [EnforcementHours]
    var quote: Quote

    var id: String { zoneId }
}

struct EnforcementHours: Codable, Sendable, Equatable {
    var days: [String]
    var start: String
    var end: String
}

struct Quote: Codable, Sendable, Equatable {
    var zoneId: String
    var providerZoneNumber: String
    var stayMinutes: Int
    var chargedMinutes: Int
    var meterUsd: Double
    var feeUsd: Double
    var totalUsd: Double
}

struct Policy: Codable, Sendable {
    var dryRun: Bool
    /// Carried so PUT /policy (a full replacement) round-trips the server's
    /// shadow-mode rehearsal switch instead of silently turning it off.
    var shadowMode: Bool?
    var sessionCapUsd: Double
    var dailyCapUsd: Double
    var autoPayMaxRatePerHour: Double
    var defaultStayMinutes: Int
    /// Deprecated on the server: the per-city fee now lives in
    /// city_overrides.<city>.parking_fee_usd. Optional so both shapes decode
    /// and round-trip through PUT /policy.
    var parknycFeeUsd: Double?
    var autoExtend: AutoExtendPolicy
    var respectEnforcementHours: Bool
    var ticketCostUsd: Double
    /// Carried so PUT /policy (a full replacement) round-trips the per-city
    /// fees the onboarding budget step doesn't touch.
    var cityOverrides: [String: CityPolicyOverride]?

    enum CodingKeys: String, CodingKey {
        case dryRun = "dry_run"
        case shadowMode = "shadow_mode"
        case sessionCapUsd = "session_cap_usd"
        case dailyCapUsd = "daily_cap_usd"
        case autoPayMaxRatePerHour = "auto_pay_max_rate_per_hour"
        case defaultStayMinutes = "default_stay_minutes"
        case parknycFeeUsd = "parknyc_fee_usd"
        case autoExtend = "auto_extend"
        case respectEnforcementHours = "respect_enforcement_hours"
        case ticketCostUsd = "ticket_cost_usd"
        case cityOverrides = "city_overrides"
    }
}

struct CityPolicyOverride: Codable, Sendable {
    var parkingFeeUsd: Double?
    var ticketCostUsd: Double?

    enum CodingKeys: String, CodingKey {
        case parkingFeeUsd = "parking_fee_usd"
        case ticketCostUsd = "ticket_cost_usd"
    }
}

struct AutoExtendPolicy: Codable, Sendable {
    var enabled: Bool
    var maxCount: Int
    var maxMinutesEach: Int
    var noExtendWithinMinutesOfMaxStay: Int

    enum CodingKeys: String, CodingKey {
        case enabled
        case maxCount = "max_count"
        case maxMinutesEach = "max_minutes_each"
        case noExtendWithinMinutesOfMaxStay = "no_extend_within_minutes_of_max_stay"
    }
}

struct PolicyResponse: Codable, Sendable {
    var policy: Policy
    var hash: String
    var dryRun: Bool
    /// May this user PUT the policy (the operator's document)? The app never
    /// does any more — each user's limits save through /me/limits.
    var editable: Bool?
}

// Per-user limits (server/API.md "GET/PUT /me/limits").

/// Per stop, per day, and the default stay: what every check uses.
struct SpendingLimits: Codable, Sendable, Hashable {
    var sessionCapUsd: Double
    var dailyCapUsd: Double
    var defaultStayMinutes: Int
}

struct UserLimitsResponse: Codable, Sendable, Equatable {
    /// In effect now: the user's own, capped by the ceilings.
    var limits: SpendingLimits
    /// What the user saved; nil = the operator's default.
    var saved: SavedLimits
    /// The operator's defaults.
    var defaults: SpendingLimits
    /// The most a cap may be.
    var ceilings: LimitCeilings
    var bounds: LimitBounds
    /// Fields whose saved value a lowered ceiling now caps.
    var clamped: [String]

    struct SavedLimits: Codable, Sendable, Equatable {
        var sessionCapUsd: Double?
        var dailyCapUsd: Double?
        var defaultStayMinutes: Int?
    }

    struct LimitCeilings: Codable, Sendable, Equatable {
        var sessionCapUsd: Double
        var dailyCapUsd: Double
    }

    struct LimitBounds: Codable, Sendable, Equatable {
        var minCapUsd: Double
        var stayMinutes: StayBounds

        struct StayBounds: Codable, Sendable, Equatable {
            var min: Int
            var max: Int
        }
    }
}

/// One reason the server refused a PUT /me/limits; `message` is the
/// sentence to show as is.
struct LimitsIssue: Codable, Sendable, Equatable {
    var field: String
    var code: String
    var message: String
    var limit: Double?
}

/// 400 invalid_limits: the server's own sentences, shown as they are.
struct LimitsRejected: Error, LocalizedError, Equatable {
    var issues: [LimitsIssue]

    var errorDescription: String? {
        issues.isEmpty ? "Those limits weren't saved." : issues.map(\.message).joined(separator: " ")
    }
}

// Sessions (server/API.md "Sessions").

struct SessionStartRequest: Codable, Sendable {
    var parkedEventId: String
    var zoneId: String
    var minutes: Int
}

struct SessionStartResponse: Codable, Sendable, Equatable {
    var sessionId: String
    var expiresAt: Date
    var amountUsd: Double
}

/// POST /session/start answers 200 with one of two shapes: a started
/// session, or `{status: "free_period", notice, …}` when the provider
/// says the zone isn't charging right now (after hours). Decoding the
/// started shape alone turned free parking into a payment error.
enum SessionStartOutcome: Sendable {
    case started(SessionStartResponse)
    case freePeriod(notice: String?)
}

/// The dual-shape wire form; `outcome()` is the single decode point.
struct SessionStartWire: Decodable, Sendable {
    var status: String?
    var notice: String?
    var sessionId: String?
    var expiresAt: Date?
    var amountUsd: Double?

    func outcome() throws -> SessionStartOutcome {
        if status == "free_period" {
            return .freePeriod(notice: notice)
        }
        guard let sessionId, let expiresAt, let amountUsd else {
            throw DecodingError.dataCorrupted(DecodingError.Context(
                codingPath: [],
                debugDescription: "session/start response is neither a started session nor a free period"
            ))
        }
        return .started(SessionStartResponse(
            sessionId: sessionId, expiresAt: expiresAt, amountUsd: amountUsd
        ))
    }
}

struct SessionStopResponse: Codable, Sendable {
    var sessionId: String
    var stoppedAt: Date
}

struct SessionExtendResponse: Codable, Sendable {
    var sessionId: String
    var expiresAt: Date
    var amountUsd: Double
}

// MARK: - Wallet (server/API.md "Wallet")

/// GET /wallet — how the user pays, and what they've spent. Everything the
/// Wallet tab, the Account sheet's "How you pay" row, and onboarding's pay
/// step show comes from here, so the three can't disagree.
struct WalletResponse: Codable, Sendable, Equatable {
    var activeSource: PaymentSource
    /// Effective dry run: nothing is charged; amounts are what would have been.
    var dryRun: Bool
    /// The three ways to pay, in display order.
    var options: [WalletSourceOption]
    var providerCard: ProviderCardSource
    var link: WalletLink
    var parkagentCard: WalletParkAgentCard
    var providers: [WalletProvider]
    var spending: WalletSpending
    /// The first page of Activity (five rows) for the Wallet's section.
    var activity: ActivityPage

    func option(_ source: PaymentSource) -> WalletSourceOption? {
        options.first { $0.source == source }
    }
}

struct WalletSourceOption: Codable, Sendable, Equatable {
    var source: PaymentSource
    /// "available" | "connect" (a one-time setup step first) | "coming_soon"
    var availability: String
    /// "connect_link" | "add_card" when availability is "connect".
    var needs: String?
    /// ParkAgent card only: selectable in sandbox (Debug builds, test-mode
    /// Stripe) before it's live.
    var sandbox: Bool

    var isComingSoon: Bool { availability == "coming_soon" }
}

/// The card saved on each linked provider account (what "Your card on …" pays with).
struct ProviderCardSource: Codable, Sendable, Equatable {
    var cards: [Card]

    struct Card: Codable, Sendable, Equatable {
        var provider: String
        var displayName: String
        var city: String
        var brand: String?
        var last4: String
    }
}

struct WalletLink: Codable, Sendable, Equatable {
    /// The server has Link credentials (LINK_*); false → "Link — coming soon".
    var configured: Bool
    var connected: Bool
    var paymentMethod: LinkPaymentMethod?
    var pendingApprovals: [LinkPendingApproval]
    /// Where "Manage in Link" goes.
    var manageUrl: String
    /// "plans_and_garages" — Link never pays a street meter.
    var covers: String
}

struct LinkPaymentMethod: Codable, Sendable, Equatable {
    /// "card" | "bank_account"
    var type: String
    var brand: String?
    var last4: String?
}

struct LinkPendingApproval: Codable, Sendable, Equatable, Identifiable {
    var spendRequestId: String
    var amountUsd: Double
    var merchantName: String?
    var approvalUrl: String?
    var expiresAt: Date

    var id: String { spendRequestId }
}

struct WalletParkAgentCard: Codable, Sendable, Equatable {
    var live: Bool
    var sandboxSelectable: Bool
    var fundingMethods: [FundingMethod]
    /// The virtual card, once it exists (the first switch creates it).
    var card: ParkAgentCard?

    var defaultFundingMethod: FundingMethod? {
        fundingMethods.first(where: \.isDefault) ?? fundingMethods.first
    }
}

/// One of the user's own cards, saved for the ParkAgent card's holds.
struct FundingMethod: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var brand: String
    var last4: String
    /// "apple_pay" when saved through Apple Pay.
    var wallet: String?
    var expMonth: Int?
    var expYear: Int?
    var isDefault: Bool
}

/// The ParkAgent virtual card as the hero shows it — never the number
/// (revealed client-side from Stripe with an ephemeral key).
struct ParkAgentCard: Codable, Sendable, Equatable {
    var stripeCardId: String
    var last4: String
    /// Stripe's brand; nil when Stripe couldn't be asked this time.
    var brand: String?
    /// "pending_onboarding" | "active" | "inactive" (frozen) | "canceled"
    var status: String
    var expMonth: Int?
    var expYear: Int?
    var cardholderName: String?

    var isFrozen: Bool { status == "inactive" }
}

/// One parking account and what pays street meters there.
struct WalletProvider: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var city: String
    var cityDisplayName: String
    var displayName: String
    /// "linked" | "expiring" | "expired" | "unlinked"
    var status: String
    var paysWith: PaysWith?
    /// "connect" | "reconnect" | "add_parkagent_card" | "own_card_replaced"
    var attention: String?

    struct PaysWith: Codable, Sendable, Equatable {
        var source: PaymentSource
        var brand: String?
        var last4: String?
    }

    var isLinked: Bool { status == "linked" || status == "expiring" }
}

struct WalletSpending: Codable, Sendable, Equatable {
    /// Today, whatever paid — the daily cap's measure.
    var todayUsd: Double
    var dailyCapUsd: Double
    var sessionCapUsd: Double
    /// The month, whatever paid: `byCity` (street meters) plus
    /// `linkMonthUsd` (garages approved in Link) add up to it.
    var monthUsd: Double
    var byCity: [CitySpend]
    var linkMonthUsd: Double?

    struct CitySpend: Codable, Sendable, Equatable, Identifiable {
        var city: String
        var cityDisplayName: String
        var monthUsd: Double

        var id: String { city }
    }
}

/// GET /wallet/activity — every way money moved, newest first.
struct ActivityPage: Codable, Sendable, Equatable {
    var items: [ActivityItem]
    var nextCursor: String?
}

/// One Activity row. Three kinds share the shape (server/API.md
/// "GET /wallet/activity"); a field a kind doesn't carry is nil.
struct ActivityItem: Codable, Sendable, Hashable, Identifiable {
    /// "<kind>:<row id>" — unique across kinds.
    var id: String
    /// "session" | "garage" | "link_payment"
    var kind: String
    /// When it happened (a session's start).
    var at: Date
    var createdAt: Date

    // session
    var sessionId: String?
    var city: String?
    var cityDisplayName: String?
    var providerDisplayName: String?
    var zoneNumber: String?
    var street: String?
    var durationMinutes: Int?
    var meterUsd: Double?
    var feeUsd: Double?
    var totalUsd: Double?
    /// session: pending | active | stopped | expired | failed | free_period;
    /// garage: handed_off | planned; link_payment: Link's approval state.
    var status: String?
    var dryRun: Bool?
    var paymentSource: String?
    /// One plain sentence: what happened and what paid for it.
    var explanation: String?
    var startedAt: Date?
    var expiresAt: Date?
    var stoppedAt: Date?
    var lat: Double?
    var lng: Double?
    var receipt: ActivityReceipt?
    var timeline: [ActivityTimelineEntry]?

    // garage
    var bookingId: String?
    var label: String?
    var provider: String?
    var priceUsd: Double?
    var startsAt: Date?
    var endsAt: Date?
    var deepLink: String?
    var link: ActivityLink?

    // link_payment
    var spendRequestId: String?
    var amountUsd: Double?
    var merchantName: String?

    // plan: a street spot or a day made in the assistant
    var planId: String?
    /// "street" | "itinerary"
    var planKind: String?
    /// What the plan was priced at — never money moved (a street spot's
    /// session row, a day's garage rows carry the real amounts).
    var plannedUsd: Double?
    /// garage and plan rows made in the assistant: the conversation, while
    /// it is still saved.
    var conversationId: String?
}

struct ActivityReceipt: Codable, Sendable, Hashable {
    // session
    var providerConfirmation: String?
    var decisionId: String?
    var holds: [HoldReceipt]?
    // garage
    var optionId: String?
    var planId: String?
}

/// A ParkAgent-card hold for one paid leg of a session.
struct HoldReceipt: Codable, Sendable, Hashable {
    var leg: String
    var heldUsd: Double
    var capturedUsd: Double?
    /// held | captured | released | declined | failed
    var status: String
    var paymentIntentId: String?
}

struct ActivityTimelineEntry: Codable, Sendable, Hashable {
    /// started | extended | stopped | expired | failed | free_period |
    /// hold_placed | hold_captured | hold_released | hold_declined
    var kind: String
    var at: Date
    var minutes: Int?
    var amountUsd: Double?
    var code: String?
}

struct ActivityLink: Codable, Sendable, Hashable {
    var spendRequestId: String
    /// Link's approval state: pending_approval | approved | denied | expired | …
    var status: String
    var approvalUrl: String?
}

/// PUT /wallet/source
struct WalletSourceResponse: Codable, Sendable {
    var activeSource: PaymentSource
    /// ParkAgent card: the chained setup putting it on each linked account
    /// (poll /providers/:provider/link-status with the job id).
    var setupJobs: [SetupJob]
    var decisionId: String

    struct SetupJob: Codable, Sendable {
        var provider: String
        var jobId: String
    }
}

/// POST /wallet/setup-intent — what the Apple Pay / card-entry sheet confirms.
struct WalletSetupIntent: Codable, Sendable {
    var setupIntentId: String
    var clientSecret: String
    var customerId: String
    var merchantId: String
}

struct FundingMethodResponse: Codable, Sendable {
    var fundingMethod: FundingMethod
}

struct FundingMethodRemoveResponse: Codable, Sendable {
    var ok: Bool
    var promotedDefault: String?
}

/// POST /link/spend-requests/:id/card — an approved Link one-time card,
/// for the user to pay the garage's own checkout with. Shown behind Face ID
/// for 30 seconds; never stored.
struct LinkCardDetails: Codable, Sendable, Equatable {
    var spendRequestId: String
    var brand: String
    var number: String
    var cvc: String
    var expMonth: Int
    var expYear: Int
    var validUntil: String
}

struct CardRevealResponse: Codable, Sendable {
    var stripeCardId: String
    var ephemeralKeySecret: String
    var apiVersion: String
    var expiresAt: Date
}

struct CardStatusResponse: Codable, Sendable {
    var status: String
}

/// The sensitive details, fetched by the client straight from Stripe with
/// the ephemeral key — they never transit our server and are never stored.
struct RevealedCardDetails: Sendable, Equatable {
    var number: String
    var cvc: String
    var expMonth: Int
    var expYear: Int
}

// MARK: - City & providers (server/API.md "GET /city", "Provider accounts")

struct CityDetectResponse: Codable, Sendable {
    /// Zone-id prefix ("nyc" | "bos"), or nil when nowhere near a metered zone.
    var city: String?
    var cityDisplayName: String?
    var provider: ParkedProvider?
}

struct ProvidersStatusResponse: Codable, Sendable {
    var providers: [ProviderAccountStatus]
}

/// One registry provider merged with the caller's account (GET /providers/status).
struct ProviderAccountStatus: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var city: String
    var cityDisplayName: String
    var displayName: String
    var loginUrl: String
    /// The registry's session domains — the link web view watches these to
    /// know when the user has signed in before capturing cookies.
    var cookieDomains: [String]
    /// Link-or-create metadata; absent on older servers.
    var signup: ProviderSignup?
    /// "linked" | "expiring" | "expired" | "unlinked"
    var status: String
    var linkedAt: Date?
    var lastVerifiedAt: Date?
    var cardAdded: Bool
    /// The card already on the PROVIDER account (provider_card users),
    /// read at link time — brand and last4 only, for display.
    var cardBrand: String?
    var cardLast4: String?

    /// Usable for paying: "expiring" still works, it just wants a re-link
    /// before the session dies (mirrors the server's providerStatusUsable).
    var isLinked: Bool { status == "linked" || status == "expiring" }

    /// Needs the user's attention in the Account sheet.
    var needsReconnect: Bool { status == "expiring" || status == "expired" }

    /// "Visa ••4242" when the provider showed us a card — the Wallet's own
    /// form (WalletCopy.masked), so the two never read differently.
    var maskedCard: String? {
        WalletCopy.masked(brand: cardBrand, last4: cardLast4)
    }
}

/// One cookie captured from the link web view, shaped like the server's
/// cookie schema (a Playwright storage-state cookie).
struct ProviderCookie: Codable, Sendable, Equatable {
    var name: String
    var value: String
    var domain: String
    var path: String?
    var expires: Double?
    var httpOnly: Bool?
    var secure: Bool?
    var sameSite: String?
}

struct ProviderLinkRequest: Codable, Sendable {
    var cookies: [ProviderCookie]
    var setUpCard: Bool
    var consentReplacePaymentMethod: Bool?

    enum CodingKeys: String, CodingKey {
        case cookies
        case setUpCard = "set_up_card"
        case consentReplacePaymentMethod = "consent_replace_payment_method"
    }
}

/// 202 from POST /providers/:provider/link: the link runs as a job the app
/// polls (the server no longer holds the request open while a browser
/// verifies the sign-in).
struct ProviderLinkResponse: Codable, Sendable {
    /// "verifying"
    var status: String
    var phase: String?
    /// The provider account's own card — older servers answered it here;
    /// now it arrives on link-status once read.
    var cardBrand: String?
    var cardLast4: String?
    var jobId: String?
}

struct LinkStatusResponse: Codable, Sendable, Equatable {
    /// "queued" | "verifying" | "reading_card" | "adding_card" |
    /// "retrying" | "done" | "failed" (older rows: "linking")
    var phase: String
    /// Typed failure (or retry) reason: an executor code, "timeout",
    /// "busy", "provider_unavailable", "unsupported_card_brand", "no_card".
    var reason: String?
    /// Whether re-running setup-card as-is is worth it.
    var retrySafe: Bool?
    var dryRun: Bool?
    /// The account is linked (verification passed), even while the card
    /// is still being read.
    var linked: Bool?
    var elapsedMs: Int?
    var attempt: Int?
    var maxAttempts: Int?
    /// Calls ahead of this one for a browser slot on the server.
    var queuePosition: Int?
    var nextAttemptAt: Date?
    var cardBrand: String?
    var cardLast4: String?

    init(
        phase: String,
        reason: String? = nil,
        retrySafe: Bool? = nil,
        dryRun: Bool? = nil,
        linked: Bool? = nil,
        elapsedMs: Int? = nil,
        attempt: Int? = nil,
        maxAttempts: Int? = nil,
        queuePosition: Int? = nil,
        nextAttemptAt: Date? = nil,
        cardBrand: String? = nil,
        cardLast4: String? = nil
    ) {
        self.phase = phase
        self.reason = reason
        self.retrySafe = retrySafe
        self.dryRun = dryRun
        self.linked = linked
        self.elapsedMs = elapsedMs
        self.attempt = attempt
        self.maxAttempts = maxAttempts
        self.queuePosition = queuePosition
        self.nextAttemptAt = nextAttemptAt
        self.cardBrand = cardBrand
        self.cardLast4 = cardLast4
    }
}

struct LinkNotifyResponse: Codable, Sendable {
    var ok: Bool
    var phase: String?
    var notify: Bool?
}

struct SetupCardResponse: Codable, Sendable {
    var ok: Bool
    var dryRun: Bool?
}

struct UnlinkResponse: Codable, Sendable {
    var ok: Bool
    var cardRemoval: String
    var cardFrozen: Bool
}

/// The Wallet's three ways to pay — one active at a time (server/API.md
/// "Wallet"). Copy for each lives in WalletCopy, shared by the Wallet,
/// the Account sheet, and onboarding.
enum PaymentSource: String, Codable, Sendable, CaseIterable {
    /// The card saved on the user's own ParkNYC/ParkBoston account — the
    /// default; nothing to set up.
    case providerCard = "provider_card"
    /// Their Stripe Link wallet: assistant plans and garages, each approved
    /// in Link. Street meters stay on the card on the provider account.
    case linkWallet = "link_wallet"
    /// Our virtual card on every linked account, funded per session by a
    /// hold on the user's own card.
    case parkagentCard = "parkagent_card"

    /// Persisted app-side so onboarding routing and the link flow can read
    /// it without a fetch; the server row is the source of truth.
    static let defaultsKey = "paymentSource"

    /// The stored choice, defaulting like the server does.
    static var stored: PaymentSource {
        PaymentSource(wire: UserDefaults.standard.string(forKey: defaultsKey))
    }

    /// Tolerant reading: the pre-Wallet name of the ParkAgent card, and
    /// anything unknown, map the way the server normalizes them.
    init(wire: String?) {
        switch wire {
        case "link_wallet": self = .linkWallet
        case "parkagent_card", "issuing_card": self = .parkagentCard
        default: self = .providerCard
        }
    }

    init(from decoder: Decoder) throws {
        self.init(wire: try decoder.singleValueContainer().decode(String.self))
    }
}

struct CardPrepareResponse: Codable, Sendable {
    var created: Bool
    var card: PreparedCard

    struct PreparedCard: Codable, Sendable {
        var stripeCardId: String
        var last4: String
        var status: String
    }
}

// MARK: - Garage outlines (server/API.md "GET /garages/near")

/// Garage and lot outlines around a point, for the phone's footprint cache
/// (Detection/FootprintIndex.swift). A garage this build can't read is
/// skipped rather than failing the cell it came in.
struct NearbyGaragesResponse: Decodable, Sendable {
    var radiusM: Double
    var limit: Int
    /// True → more outlines matched than `limit`: the cell is incomplete.
    var truncated: Bool
    /// The line the outlines' license asks for wherever they are shown.
    var attribution: String
    var garages: [Footprint]

    init(radiusM: Double, limit: Int, truncated: Bool, attribution: String, garages: [Footprint]) {
        self.radiusM = radiusM
        self.limit = limit
        self.truncated = truncated
        self.attribution = attribution
        self.garages = garages
    }

    private enum CodingKeys: String, CodingKey {
        case radiusM, limit, truncated, attribution, garages
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        radiusM = try container.decode(Double.self, forKey: .radiusM)
        limit = try container.decode(Int.self, forKey: .limit)
        truncated = try container.decode(Bool.self, forKey: .truncated)
        attribution = try container.decodeIfPresent(String.self, forKey: .attribution) ?? ""
        garages = try container.decode([LossyFootprint].self, forKey: .garages).compactMap(\.footprint)
    }
}

// MARK: - Map layer (server/API.md "GET /zones/near")

struct NearbyZonesResponse: Codable, Sendable {
    var radiusM: Double
    var at: Date
    /// True → the server hit its zone ceiling; there is more metered street
    /// here than came back.
    var truncated: Bool
    var zones: [NearbyZone]
}

struct NearbyZone: Codable, Sendable, Identifiable, Equatable {
    var zoneId: String
    var city: String
    var providerZoneNumber: String
    var street: String?
    var rateFirstHourUsd: Double
    var rateAdditionalHourUsd: Double
    var maxStayMinutes: Int?
    var distanceM: Double
    /// What the curb line's color means: paying now vs free now.
    var enforcedNow: Bool
    var todayHours: [TodayInterval]
    var hours: [EnforcementHours]
    /// GeoJSON MultiLineString coordinates: [[[lng, lat], …], …].
    var centerline: [[[Double]]]

    var id: String { zoneId }

    struct TodayInterval: Codable, Sendable, Equatable {
        var start: String
        var end: String
    }

    /// The centerline as drawable polylines. GeoJSON is (lng, lat); a
    /// swapped pair here would put Boston in the Indian Ocean.
    var polylines: [[CLLocationCoordinate2D]] {
        centerline.map { line in
            line.compactMap { point in
                guard point.count >= 2 else { return nil }
                return CLLocationCoordinate2D(latitude: point[1], longitude: point[0])
            }
        }
        .filter { $0.count >= 2 }
    }
}

struct LocationReport: Codable, Sendable {
    var lat: Double
    var lng: Double
    var accuracy: Double
    var ts: Date
    /// When CoreLocation measured the fix. `ts` is when it was reported:
    /// a still phone re-sends its last fix on the heartbeat, and the
    /// server must not take one measurement sent twice for two (FR-55).
    var measuredAt: Date? = nil
    /// What the app itself saw (FR-55): `left_car` (on foot after the
    /// park) or `returned_to_car` (the car's audio back, or driving).
    var event: String? = nil
}

struct DeviceRegistration: Codable, Sendable {
    var token: String
    var platform: String
    var environment: String
}
