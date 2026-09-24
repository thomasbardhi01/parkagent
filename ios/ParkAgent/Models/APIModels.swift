import CoreLocation
import Foundation

// Wire types mirroring server/API.md. Field names match the JSON exactly;
// the policy document is snake_case on the wire, so those types carry
// explicit CodingKeys.

// MARK: - Identity (server/API.md "Authentication", "GET/PATCH /me")

/// GET /me — the profile plus the payment-source settings it carries.
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

struct ParkedRequest: Codable, Sendable {
    var lat: Double
    var lng: Double
    var accuracy: Double
    var ts: Date
    var signals: [String]
}

enum ParkedAction: String, Codable, Sendable {
    case pay
    case confirm
    case ignore
    case unknownZone = "unknown_zone"
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
    var parkedEventId: String
    var decisionId: String

    var id: String { parkedEventId }
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
}

// Session endpoints are 501 stubs server-side until Phase 5; these are the
// planned shapes from API.md so the app can code against them now.

struct SessionStartRequest: Codable, Sendable {
    var parkedEventId: String
    var zoneId: String
    var minutes: Int
}

struct SessionStartResponse: Codable, Sendable {
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

// MARK: - Card (server/API.md "Card endpoints")

struct CardResponse: Codable, Sendable {
    var card: CardSummary?
    var funding: CardFunding
    var dryRun: Bool
}

struct CardSummary: Codable, Sendable, Equatable {
    var stripeCardId: String
    var last4: String
    var brand: String
    /// "active" | "inactive" (frozen) | "canceled" — kept a string so an
    /// unknown future status decodes instead of failing the whole screen.
    var status: String
    var expMonth: Int
    var expYear: Int
    var cardholderName: String
    var spendingControls: CardSpendingControls
    var spentTodayUsd: Double
    var spentThisMonthUsd: Double

    var isFrozen: Bool { status == "inactive" }
}

struct CardSpendingControls: Codable, Sendable, Equatable {
    var perAuthorizationUsd: Double
    var dailyUsd: Double
}

struct CardFunding: Codable, Sendable, Equatable {
    var available: Bool
    var balanceUsd: Double?
    var pendingUsd: Double?
}

struct CardTransactionsResponse: Codable, Sendable {
    var items: [CardTransaction]
    var nextCursor: String?
}

struct CardTransaction: Codable, Sendable, Identifiable, Hashable {
    var id: String
    var stripeAuthorizationId: String
    var merchantName: String?
    var merchantCategory: String?
    /// The authorization hold; `capturedUsd` is the settled amount once closed.
    var amountUsd: Double
    var capturedUsd: Double?
    var approved: Bool
    /// "approved" | "declined_…" (see API.md) | "external"
    var decision: String
    /// Stripe lifecycle: "pending" | "closed" | "reversed"
    var status: String
    var createdAt: Date
    /// The parking session this charge paid for, when the server could link one.
    var sessionId: String?
}

struct CardFundingResponse: Codable, Sendable {
    var ok: Bool
    var balanceUsd: Double
    var pendingUsd: Double
    var decisionId: String
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
    var walletBalanceCents: Int?

    /// Usable for paying: "expiring" still works, it just wants a re-link
    /// before the session dies (mirrors the server's providerStatusUsable).
    var isLinked: Bool { status == "linked" || status == "expiring" }

    /// Needs the user's attention in the Account sheet.
    var needsReconnect: Bool { status == "expiring" || status == "expired" }

    /// "Visa •••• 4242" when the provider showed us a card.
    var maskedCard: String? {
        guard let cardLast4 else { return nil }
        return "\(cardBrand ?? "Card") •••• \(cardLast4)"
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

struct ProviderLinkResponse: Codable, Sendable {
    var status: String
    var walletBalanceCents: Int?
    /// The provider account's own card, read at link time (provider_card).
    var cardBrand: String?
    var cardLast4: String?
    /// Non-nil when card setup was chained; poll link-status with it.
    var jobId: String?
}

struct LinkStatusResponse: Codable, Sendable {
    /// "linking" | "adding_card" | "done" | "failed"
    var phase: String
    /// Executor code, "unsupported_card_brand", or "no_card" on failure.
    var reason: String?
    /// Whether re-running setup-card as-is is worth it.
    var retrySafe: Bool?
    var dryRun: Bool?
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

/// Which source pays the user's sessions (server/API.md "/me/payment-source").
enum PaymentSource: String, Codable, Sendable, CaseIterable {
    /// The card already saved on the user's own ParkNYC/ParkBoston account
    /// (the default) — onboarding skips card setup and funding entirely.
    case providerCard = "provider_card"
    /// The ParkAgent Issuing card; selectable only while the server says
    /// issuing is live.
    case issuingCard = "issuing_card"

    /// Persisted app-side so onboarding routing and the link flow can read
    /// it without a fetch; the server row is the source of truth.
    static let defaultsKey = "paymentSource"

    /// The stored choice, defaulting like the server does.
    static var stored: PaymentSource {
        PaymentSource(
            rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? ""
        ) ?? .providerCard
    }
}

struct PaymentSourceResponse: Codable, Sendable {
    var paymentSource: PaymentSource
    /// ISSUING_LIVE on the server: whether the ParkAgent card may be chosen.
    var issuingLive: Bool
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

/// POST /card/funding/topup-intent — step 1 of the Apple Pay top-up.
struct TopupIntentResponse: Codable, Sendable {
    var clientSecret: String
    var paymentIntentId: String?
    /// True → no PaymentIntent exists; nothing can ever charge.
    var dryRun: Bool
}

/// GET /health — unauthenticated; the Diagnostics screen shows which build
/// the phone is actually talking to.
struct HealthResponse: Codable, Sendable {
    var ok: Bool
    var dryRun: Bool
    var commit: String
    var builtAt: String
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
}

struct DeviceRegistration: Codable, Sendable {
    var token: String
    var platform: String
    var environment: String
}
