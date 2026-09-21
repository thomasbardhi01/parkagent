import Foundation

/// The app's whole view of the server. `MockAPI` serves fixtures for the
/// simulator and previews; `LiveAPI` talks to the Fastify server. Nothing
/// outside Networking/ should construct URLRequests.
protocol APIClient: Sendable {
    func parked(_ request: ParkedRequest) async throws -> ParkedResponse
    func policy() async throws -> PolicyResponse
    func startSession(_ request: SessionStartRequest) async throws -> SessionStartResponse
    func stopSession(sessionId: String) async throws -> SessionStopResponse
    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse
    func reportLocation(_ report: LocationReport) async throws
    func registerDevice(_ registration: DeviceRegistration) async throws
    /// PUT /policy — full replacement; the onboarding budget step saves
    /// the caps and default stay through this.
    func updatePolicy(_ policy: Policy) async throws -> PolicyResponse

    // City & provider accounts (server/API.md "GET /city", "Provider accounts").
    func detectCity(lat: Double, lng: Double) async throws -> CityDetectResponse
    func providersStatus() async throws -> ProvidersStatusResponse
    func linkProvider(
        _ providerId: String,
        cookies: [ProviderCookie],
        setUpCard: Bool,
        consent: Bool
    ) async throws -> ProviderLinkResponse
    func linkStatus(providerId: String, jobId: String) async throws -> LinkStatusResponse
    func setupCard(providerId: String) async throws -> SetupCardResponse
    func unlinkProvider(_ providerId: String) async throws -> UnlinkResponse

    // Card tab (server/API.md "Card endpoints").
    /// Lazy card creation; onboarding calls it before the link web view opens.
    func prepareCard() async throws -> CardPrepareResponse
    /// Apple Pay top-up, step 1 — the app confirms the intent client-side.
    func topupIntent(amountUsd: Double) async throws -> TopupIntentResponse
    func card() async throws -> CardResponse
    func cardTransactions(cursor: String?) async throws -> CardTransactionsResponse
    func cardTopup(amountUsd: Double) async throws -> CardFundingResponse
    func cardWithdraw(amountUsd: Double) async throws -> CardFundingResponse
    /// Two hops in the live client: our /card/reveal for the ephemeral key,
    /// then Stripe directly for the details — the PAN never touches our server.
    func revealCardDetails() async throws -> RevealedCardDetails
    func freezeCard() async throws -> CardStatusResponse
    func unfreezeCard() async throws -> CardStatusResponse
}

enum APIError: Error, LocalizedError {
    /// API_BASE_URL or API_KEY missing from Config.xcconfig.
    case notConfigured
    case unauthorized
    case invalidRequest(String)
    /// 501 — the session and location endpoints are Phase 5 stubs.
    case notImplemented
    case server(status: Int)
    case transport(Error)
    /// Mock-only until Phase 5 wires real payment failures through.
    case paymentFailed
    /// A named refusal from the server (409/503 with an `error` code), e.g.
    /// dry_run or funding_unavailable on the funding endpoints.
    case refused(code: String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "The live API is not configured. Add API_BASE_URL and API_KEY to Config.xcconfig."
        case .unauthorized: "The server rejected this API key."
        case .invalidRequest(let detail): "The server rejected the request: \(detail)"
        case .notImplemented: "This part of the server is not built yet."
        case .server(let status): "The server returned an error (\(status))."
        case .transport: "Could not reach the server."
        case .paymentFailed: "The payment did not go through."
        case .refused(let code): Self.refusalMessage(code)
        }
    }

    private static func refusalMessage(_ code: String) -> String {
        switch code {
        case "dry_run": "Dry run is on — no real money moves."
        case "amount_over_daily_cap": "That amount is over the daily cap."
        case "insufficient_funds": "Not enough balance for that withdrawal."
        case "funding_unavailable": "The card's funding account is not ready yet."
        case "no_card": "No card is set up yet."
        case "provider_not_linked": "This city's parking account is not linked yet."
        case "verification_failed": "The sign-in did not stick. Try signing in again."
        case "no_session_cookies": "No sign-in was captured. Try signing in again."
        case "consent_required": "Card setup needs your consent first."
        case "provider_linking_not_configured": "The server is not set up for account linking yet."
        default: "The server refused the request (\(code))."
        }
    }
}
