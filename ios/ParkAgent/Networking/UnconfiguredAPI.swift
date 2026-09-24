import Foundation

/// The client the app runs on when Config.xcconfig has no API_BASE_URL /
/// API_KEY. Every call fails with `.notConfigured`, so each screen shows its
/// real error state — the app never silently substitutes fixtures.
struct UnconfiguredAPI: APIClient {
    private var failure: APIError { .notConfigured }

    func parked(_ request: ParkedRequest) async throws -> ParkedResponse { throw failure }
    func reportZoneNumber(zoneId: String, number: String) async throws -> ZoneNumberReportResponse { throw failure }
    func policy() async throws -> PolicyResponse { throw failure }
    func startSession(_ request: SessionStartRequest) async throws -> SessionStartOutcome { throw failure }
    func stopSession(sessionId: String) async throws -> SessionStopResponse { throw failure }
    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse { throw failure }
    func reportLocation(_ report: LocationReport) async throws { throw failure }
    func registerDevice(_ registration: DeviceRegistration) async throws { throw failure }
    func updatePolicy(_ policy: Policy) async throws -> PolicyResponse { throw failure }

    func paymentSource() async throws -> PaymentSourceResponse { throw failure }
    func updatePaymentSource(_ source: PaymentSource) async throws -> PaymentSourceResponse { throw failure }

    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse {
        throw failure
    }

    func health() async throws -> HealthResponse { throw failure }

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
    func topupIntent(amountUsd: Double) async throws -> TopupIntentResponse { throw failure }
    func card() async throws -> CardResponse { throw failure }
    func cardTransactions(cursor: String?) async throws -> CardTransactionsResponse { throw failure }
    func cardTopup(amountUsd: Double) async throws -> CardFundingResponse { throw failure }
    func cardWithdraw(amountUsd: Double) async throws -> CardFundingResponse { throw failure }
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
