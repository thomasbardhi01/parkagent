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

    // Wallet (server/API.md "Wallet"): how the user pays and what they spent.
    func wallet() async throws -> WalletResponse
    /// The unified, paginated Activity ledger; pass the previous page's
    /// `nextCursor` for the next one.
    func walletActivity(cursor: String?) async throws -> ActivityPage
    /// Switch the active way to pay. `sandbox` is only sent by Debug builds
    /// (ParkAgent card before it's live); `consent` agrees to the ParkAgent
    /// card replacing the card saved on each linked parking account.
    func setWalletSource(_ source: PaymentSource, sandbox: Bool, consent: Bool) async throws -> WalletSourceResponse
    /// Step one of saving a card for the ParkAgent card's holds.
    func walletSetupIntent(sandbox: Bool) async throws -> WalletSetupIntent
    /// Step two, after the Apple Pay / card sheet confirmed the intent.
    func addFundingMethod(setupIntentId: String) async throws -> FundingMethodResponse
    func setDefaultFundingMethod(id: String) async throws -> FundingMethodResponse
    func removeFundingMethod(id: String) async throws -> FundingMethodRemoveResponse
    /// An approved Link garage payment's one-time card, for the garage's
    /// own checkout (Face ID first, 30-second display).
    func revealLinkCard(spendRequestId: String) async throws -> LinkCardDetails

    /// The map's curb layer (server/API.md "GET /zones/near"). Radius is
    /// capped server-side at 400 m.
    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse

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

    // The ParkAgent card itself (server/API.md "Card endpoints").
    /// Lazy card creation; the link flow calls it before the web view opens
    /// for a ParkAgent-card user (idempotent — the source switch creates it).
    func prepareCard() async throws -> CardPrepareResponse
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
    /// API_BASE_URL missing from the build (Config.xcconfig).
    case notConfigured
    /// 401 that a token refresh could not rescue — the session is gone.
    case unauthorized
    /// 400: the body is the server's validation detail — for a Debug
    /// build's eyes only; a person sees a plain sentence.
    case invalidRequest(String)
    case server(status: Int)
    case transport(Error)
    /// A named refusal from the server (4xx/5xx with an `error` code), e.g.
    /// dry_run, executor_failed, card_declined.
    case refused(code: String)
    /// Apple Pay / the card form couldn't save the card; Stripe's own
    /// sentence says why.
    case cardNotSaved(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            #if DEBUG
            return "The live API is not configured. Add API_BASE_URL to Config.xcconfig."
            #else
            return "This version of ParkAgent can't reach its server. Install the latest version."
            #endif
        case .unauthorized:
            return "Your session expired. Sign in again."
        case .invalidRequest(let detail):
            #if DEBUG
            return "The server rejected the request: \(detail)"
            #else
            _ = detail
            return "That didn't go through. Try again."
            #endif
        case .server(let status):
            return "Something went wrong on our side (\(status)). Try again in a moment."
        case .transport:
            return "Could not reach the server."
        case .refused(let code):
            return Self.refusalMessage(code)
        case .cardNotSaved(let message):
            return message
        }
    }

    /// A code with no sentence of its own: a Debug build names it, a
    /// person just gets a plain retry.
    private static func fallbackRefusal(_ code: String) -> String {
        #if DEBUG
        "The server refused the request (\(code))."
        #else
        "That didn't go through. Try again in a moment."
        #endif
    }

    private static func refusalMessage(_ code: String) -> String {
        switch code {
        case "dry_run": "Dry run is on — no real money moves."
        case "no_card": "No card is set up yet."
        case "provider_not_linked": "This city's parking account is not linked yet."
        case "needs_zone_number": "This block's zone number is not known yet — read it off the meter."
        case "free_period": "Parking is free here right now — no payment needed."
        case "verification_failed": "The sign-in did not stick. Try signing in again."
        case "no_session_cookies": "No sign-in was captured. Try signing in again."
        case "consent_required": "Card setup needs your consent first."
        case "provider_linking_not_configured": "The server is not set up for account linking yet."
        case "parkagent_card_not_live": "The ParkAgent card is coming soon — pending approval."
        case "link_not_configured": "Link is coming soon."
        case "link_not_connected": "Connect your Link wallet first."
        case "no_funding_method": "Add a card for the ParkAgent card first."
        case "funding_method_in_use": "That's the only card the ParkAgent card can use. Switch how you pay first."
        case "hold_in_progress": "That card is covering a parking session right now. Try again after it ends."
        case "card_declined": "Your card was declined — update it in Wallet."
        case "wallet_not_ready": "How you pay needs attention — fix it in Wallet."
        case "setup_not_complete": "The card wasn't saved. Try again."
        case "not_approved": "That Link payment hasn't been approved yet."
        case "card_expired": "That Link card has expired."
        case "card_used": "That Link card was already used."
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
        case "assistant_budget_exhausted": "You've used today's assistant allowance. It resets at midnight."
        case "assistant_not_configured": "The assistant isn't set up on this server yet."
        case "assistant_failed": "The assistant hit a problem. Try asking again."
        case "conversation_not_found": "That conversation isn't available. Start a new one."
        case "rate_limited": "That's a lot of requests at once. Wait a moment and try again."
        // Session start / extend / stop (server/API.md "Sessions").
        case "executor_failed": "The payment didn't go through, so the meter isn't paid. Try again, or pay at the meter."
        case "policy_violation": "That's outside your parking limits, so nothing was paid."
        case "session_already_active": "A parking session is already running. Stop it before starting another."
        case "session_not_active", "session_not_found", "no_active_session": "That session has already ended."
        case "plan_not_found": "That plan is no longer available. Ask again for a fresh one."
        case "itinerary_not_found", "itinerary_not_editable": "That day's plan can't be changed any more."
        case "over_daily_cap", "plan_over_daily_cap": "That would go over today's spending limit."
        case "vehicle_not_found": "That car isn't on your account any more."
        case "parked_event_not_found", "zone_not_found": "That parking spot is no longer available to pay. Park again to get a fresh quote."
        case "street_pay_on_arrival": "Street parking is paid when you park, not ahead of time."
        default: fallbackRefusal(code)
        }
    }
}
