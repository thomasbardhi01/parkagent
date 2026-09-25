import Foundation

/// The client the app runs on when Config.xcconfig has no API_BASE_URL.
/// Every call fails with `.notConfigured`, so each screen shows its real
/// error state — the app never silently substitutes fixtures. Signed out,
/// that is the welcome screen's sign-in failure; signed in, Home's banner.
struct UnconfiguredAPI: APIClient {
    private var failure: APIError { .notConfigured }

    func authMethods() async throws -> AuthMethods { throw failure }
    func signInWithApple(
        identityToken: String,
        authorizationCode: String?,
        deviceId: String,
        fullName: (given: String?, family: String?)?
    ) async throws -> AuthSession { throw failure }
    func signInWithGoogle(idToken: String, deviceId: String) async throws -> AuthSession { throw failure }
    func startEmailSignIn(email: String) async throws { throw failure }
    func verifyEmailSignIn(email: String, code: String, deviceId: String) async throws -> AuthSession {
        throw failure
    }
    func logout(refreshToken: String) async throws { throw failure }
    func me() async throws -> MeResponse { throw failure }
    func updateMe(name: String?, phone: String?) async throws -> AuthUser { throw failure }
    func deleteAccount() async throws { throw failure }

    func vehicles() async throws -> [VehicleSummary] { throw failure }
    func addVehicle(plate: String, state: String, label: String?) async throws -> VehicleSummary { throw failure }
    func updateVehicle(id: String, plate: String?, state: String?, label: String?) async throws -> VehicleSummary {
        throw failure
    }
    func removeVehicle(id: String) async throws { throw failure }

    func parked(_ request: ParkedRequest) async throws -> ParkedResponse { throw failure }
    func reportZoneNumber(zoneId: String, number: String) async throws -> ZoneNumberReportResponse { throw failure }
    func policy() async throws -> PolicyResponse { throw failure }
    func startSession(_ request: SessionStartRequest) async throws -> SessionStartOutcome { throw failure }
    func stopSession(sessionId: String) async throws -> SessionStopResponse { throw failure }
    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse { throw failure }
    func reportLocation(_ report: LocationReport) async throws { throw failure }
    func registerDevice(_ registration: DeviceRegistration) async throws { throw failure }
    func updatePolicy(_ policy: Policy) async throws -> PolicyResponse { throw failure }

    func wallet() async throws -> WalletResponse { throw failure }
    func walletActivity(cursor: String?) async throws -> ActivityPage { throw failure }
    func setWalletSource(_ source: PaymentSource, sandbox: Bool, consent: Bool) async throws -> WalletSourceResponse {
        throw failure
    }
    func walletSetupIntent(sandbox: Bool) async throws -> WalletSetupIntent { throw failure }
    func addFundingMethod(setupIntentId: String) async throws -> FundingMethodResponse { throw failure }
    func setDefaultFundingMethod(id: String) async throws -> FundingMethodResponse { throw failure }
    func removeFundingMethod(id: String) async throws -> FundingMethodRemoveResponse { throw failure }
    func revealLinkCard(spendRequestId: String) async throws -> LinkCardDetails { throw failure }

    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse {
        throw failure
    }


    func detectCity(lat: Double, lng: Double) async throws -> CityDetectResponse { throw failure }
    func providersStatus() async throws -> ProvidersStatusResponse { throw failure }
    func linkProvider(
        _ providerId: String,
        cookies: [ProviderCookie],
        setUpCard: Bool,
        consent: Bool
    ) async throws -> ProviderLinkResponse { throw failure }
    func linkStatus(providerId: String, jobId: String) async throws -> LinkStatusResponse { throw failure }
    func setupCard(providerId: String) async throws -> SetupCardResponse { throw failure }
    func unlinkProvider(_ providerId: String) async throws -> UnlinkResponse { throw failure }

    func prepareCard() async throws -> CardPrepareResponse { throw failure }
    func revealCardDetails() async throws -> RevealedCardDetails { throw failure }
    func freezeCard() async throws -> CardStatusResponse { throw failure }
    func unfreezeCard() async throws -> CardStatusResponse { throw failure }

    func assistantMessage(
        text: String,
        conversationId: String?,
        location: (lat: Double, lng: Double)?
    ) -> AsyncThrowingStream<AssistantEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: APIError.notConfigured)
        }
    }

    func confirmPlan(planId: String, optionId: String?) async throws -> AssistantConfirmResponse { throw failure }
    func itineraries() async throws -> ItinerariesResponse { throw failure }
    func patchItinerary(id: String, stops: [ItineraryStop]) async throws -> ItineraryPatchResponse { throw failure }

    func linkWalletStatus() async throws -> LinkWalletStatus { throw failure }
    func linkWalletConnect() async throws -> LinkConnectResponse { throw failure }
    func linkWalletDisconnect() async throws { throw failure }
    func syncLinkSpendRequest(id: String) async throws -> LinkSpendSyncResponse { throw failure }
}
