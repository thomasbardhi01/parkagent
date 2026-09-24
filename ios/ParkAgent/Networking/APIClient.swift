import Foundation

/// The app's whole view of the server. `MockAPI` serves fixtures for the
/// simulator and previews; `LiveAPI` talks to the Fastify server. Nothing
/// outside Networking/ should construct URLRequests.
protocol APIClient: Sendable {
    // Identity (server/API.md "Authentication"). These are the only calls
    // that work signed out; everything else needs the access token.
    /// Which sign-in methods are switched on (GET /auth/methods).
    func authMethods() async throws -> AuthMethods
    func signInWithApple(
        identityToken: String,
        deviceId: String,
        fullName: (given: String?, family: String?)?
    ) async throws -> AuthSession
    func signInWithGoogle(idToken: String, deviceId: String) async throws -> AuthSession
    func startEmailSignIn(email: String) async throws
    func verifyEmailSignIn(email: String, code: String, deviceId: String) async throws -> AuthSession
    func logout(refreshToken: String) async throws

    /// The signed-in profile, and editing it.
    func me() async throws -> MeResponse
    func updateMe(name: String?, phone: String?) async throws -> AuthUser
    /// Two-step confirmed in the UI; irreversible on the server.
    func deleteAccount() async throws

    // Vehicles (Account sheet).
    func vehicles() async throws -> [VehicleSummary]
    func addVehicle(plate: String, state: String, label: String?) async throws -> VehicleSummary
    func updateVehicle(id: String, plate: String?, state: String?, label: String?) async throws -> VehicleSummary
    func removeVehicle(id: String) async throws

    func parked(_ request: ParkedRequest) async throws -> ParkedResponse
    /// The zone number the driver read off the meter (needsZoneNumber flow).
    func reportZoneNumber(zoneId: String, number: String) async throws -> ZoneNumberReportResponse
    func policy() async throws -> PolicyResponse
    /// 200 is either a started session or a typed free period (the
    /// provider says the zone is not charging right now).
    func startSession(_ request: SessionStartRequest) async throws -> SessionStartOutcome
    func stopSession(sessionId: String) async throws -> SessionStopResponse
    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse
    func reportLocation(_ report: LocationReport) async throws
    func registerDevice(_ registration: DeviceRegistration) async throws
    /// PUT /policy — full replacement; the onboarding budget step saves
    /// the caps and default stay through this.
    func updatePolicy(_ policy: Policy) async throws -> PolicyResponse

    // Payment source (server/API.md "/me/payment-source").
    func paymentSource() async throws -> PaymentSourceResponse
    func updatePaymentSource(_ source: PaymentSource) async throws -> PaymentSourceResponse

    /// The map's curb layer (server/API.md "GET /zones/near"). Radius is
    /// capped server-side at 400 m.
    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse

    /// GET /health — which server build the phone is talking to (Diagnostics).
    func health() async throws -> HealthResponse

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

    // Assistant (server/API.md "Assistant"). The reply streams: .delta
    // events carry text as the model produces it, .done the final reply
    // with any proposed plan.
    func assistantMessage(
        text: String,
        conversationId: String?,
        location: (lat: Double, lng: Double)?
    ) -> AsyncThrowingStream<AssistantEvent, Error>
    /// The user's tap on a plan card — the only path that books or pays.
    func confirmPlan(planId: String, optionId: String?) async throws -> AssistantConfirmResponse
    func itineraries() async throws -> ItinerariesResponse
    func patchItinerary(id: String, stops: [ItineraryStop]) async throws -> ItineraryPatchResponse

    // Link wallet for agents.
    func linkWalletStatus() async throws -> LinkWalletStatus
    func linkWalletConnect() async throws -> LinkConnectResponse
    func linkWalletDisconnect() async throws
    func syncLinkSpendRequest(id: String) async throws -> LinkSpendSyncResponse
}

enum APIError: Error, LocalizedError {
    /// API_BASE_URL missing from Config.xcconfig.
    case notConfigured
    /// 401 that a token refresh could not rescue — the session is gone.
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
        case .notConfigured: "The live API is not configured. Add API_BASE_URL to Config.xcconfig."
        case .unauthorized: "Your session expired. Sign in again."
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
        case "needs_zone_number": "This block's zone number is not known yet — read it off the meter."
        case "free_period": "Parking is free here right now — no payment needed."
        case "verification_failed": "The sign-in did not stick. Try signing in again."
        case "no_session_cookies": "No sign-in was captured. Try signing in again."
        case "consent_required": "Card setup needs your consent first."
        case "provider_linking_not_configured": "The server is not set up for account linking yet."
        case "issuing_not_live": "The ParkAgent card isn't available yet — coming soon."
        case "invalid_code": "That code doesn't match. Check it and try again."
        case "code_expired": "That code expired. Send a new one."
        case "too_many_attempts": "Too many tries. Send a new code."
        case "email_rate_limited": "Too many codes requested. Wait a few minutes."
        case "send_failed": "We couldn't send the email. Try again."
        case "invalid_identity_token": "That sign-in didn't verify. Try again."
        case "email_signin_disabled": "Email sign-in isn't available. Use Sign in with Apple."
        case "google_signin_disabled": "Google sign-in isn't available. Use Sign in with Apple."
        case "plate_taken": "That plate is already registered."
        case "auth_not_configured": "This server isn't set up for sign-in yet."
        default: "The server refused the request (\(code))."
        }
    }
}
