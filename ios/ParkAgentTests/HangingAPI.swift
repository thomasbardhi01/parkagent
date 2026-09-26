import Foundation
@testable import ParkAgent

/// Answers nothing, ever — the one-bar-in-a-garage server. A class, so a
/// test scripts the few calls it cares about by overriding them and the
/// rest keep hanging (a call nobody expected fails the test by timeout,
/// never by answering something made up).
class HangingAPI: APIClient, @unchecked Sendable {
    func hang<T>() async throws -> T {
        try await Task.sleep(for: .seconds(60))
        throw APIError.transport(CancellationError())
    }

    func vehicles() async throws -> [VehicleSummary] { try await hang() }
    func providersStatus() async throws -> ProvidersStatusResponse { try await hang() }

    func authMethods() async throws -> AuthMethods { try await hang() }
    func signInWithApple(
        identityToken: String,
        authorizationCode: String?,
        deviceId: String,
        fullName: (given: String?, family: String?)?
    ) async throws -> AuthSession { try await hang() }
    func signInWithGoogle(idToken: String, deviceId: String) async throws -> AuthSession { try await hang() }
    func startEmailSignIn(email: String) async throws { try await hang() as Void }
    func verifyEmailSignIn(email: String, code: String, deviceId: String) async throws -> AuthSession {
        try await hang()
    }
    func logout(refreshToken: String) async throws { try await hang() as Void }
    func me() async throws -> MeResponse { try await hang() }
    func updateMe(name: String?, phone: String?) async throws -> AuthUser { try await hang() }
    func deleteAccount() async throws { try await hang() as Void }
    func addVehicle(plate: String, state: String, label: String?) async throws -> VehicleSummary { try await hang() }
    func updateVehicle(id: String, plate: String?, state: String?, label: String?) async throws -> VehicleSummary {
        try await hang()
    }
    func removeVehicle(id: String) async throws { try await hang() as Void }
    func parked(_ request: ParkedRequest) async throws -> ParkedResponse { try await hang() }
    func reportZoneNumber(zoneId: String, number: String) async throws -> ZoneNumberReportResponse {
        try await hang()
    }
    func policy() async throws -> PolicyResponse { try await hang() }
    func startSession(_ request: SessionStartRequest) async throws -> SessionStartOutcome { try await hang() }
    func stopSession(sessionId: String) async throws -> SessionStopResponse { try await hang() }
    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse { try await hang() }
    func reportLocation(_ report: LocationReport) async throws { try await hang() as Void }
    func registerDevice(_ registration: DeviceRegistration) async throws { try await hang() as Void }
    func updatePolicy(_ policy: Policy) async throws -> PolicyResponse { try await hang() }
    func wallet() async throws -> WalletResponse { try await hang() }
    func walletActivity(cursor: String?) async throws -> ActivityPage { try await hang() }
    func setWalletSource(_ source: PaymentSource, sandbox: Bool, consent: Bool) async throws -> WalletSourceResponse {
        try await hang()
    }
    func walletSetupIntent(sandbox: Bool) async throws -> WalletSetupIntent { try await hang() }
    func addFundingMethod(setupIntentId: String) async throws -> FundingMethodResponse { try await hang() }
    func setDefaultFundingMethod(id: String) async throws -> FundingMethodResponse { try await hang() }
    func removeFundingMethod(id: String) async throws -> FundingMethodRemoveResponse { try await hang() }
    func revealLinkCard(spendRequestId: String) async throws -> LinkCardDetails { try await hang() }
    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse {
        try await hang()
    }
    func detectCity(lat: Double, lng: Double) async throws -> CityDetectResponse { try await hang() }
    func linkProvider(
        _ providerId: String,
        cookies: [ProviderCookie],
        setUpCard: Bool,
        consent: Bool
    ) async throws -> ProviderLinkResponse { try await hang() }
    func linkStatus(providerId: String, jobId: String) async throws -> LinkStatusResponse { try await hang() }
    func notifyLinkJob(providerId: String, jobId: String) async throws -> LinkNotifyResponse { try await hang() }
    func setupCard(providerId: String) async throws -> SetupCardResponse { try await hang() }
    func unlinkProvider(_ providerId: String) async throws -> UnlinkResponse { try await hang() }
    func prepareCard() async throws -> CardPrepareResponse { try await hang() }
    func revealCardDetails() async throws -> RevealedCardDetails { try await hang() }
    func freezeCard() async throws -> CardStatusResponse { try await hang() }
    func unfreezeCard() async throws -> CardStatusResponse { try await hang() }
    func assistantMessage(
        text: String,
        conversationId: String?,
        location: (lat: Double, lng: Double)?
    ) -> AsyncThrowingStream<AssistantEvent, Error> {
        AsyncThrowingStream { _ in }
    }
    func confirmPlan(planId: String, optionId: String?, stops: [ItineraryStop]?) async throws -> AssistantConfirmResponse {
        try await hang()
    }
    func priceItinerary(planId: String, stops: [ItineraryStop]) async throws -> ItineraryPriceResponse {
        try await hang()
    }
    func itineraries() async throws -> ItinerariesResponse { try await hang() }
    func patchItinerary(id: String, stops: [ItineraryStop]) async throws -> ItineraryPatchResponse {
        try await hang()
    }
    func linkWalletStatus() async throws -> LinkWalletStatus { try await hang() }
    func linkWalletConnect() async throws -> LinkConnectResponse { try await hang() }
    func linkWalletDisconnect() async throws { try await hang() as Void }
    func syncLinkSpendRequest(id: String) async throws -> LinkSpendSyncResponse { try await hang() }
}
