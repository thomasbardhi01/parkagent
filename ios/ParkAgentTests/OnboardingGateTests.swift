import XCTest
@testable import ParkAgent

/// The launch gate's rules: resume at the first missing step, and never
/// trap anyone in onboarding because the server was slow.
final class OnboardingGateTests: XCTestCase {
    /// Everything in place, a Boston user linked to ParkBoston.
    private let setUp = OnboardingGate.Facts(
        permissionsOK: true,
        serverHasVehicle: true,
        localVehicleOK: true,
        city: "bos",
        usableProviders: ["passport"]
    )

    private func step(_ change: (inout OnboardingGate.Facts) -> Void) -> OnboardingStep? {
        var facts = setUp
        change(&facts)
        return OnboardingGate.firstMissingStep(facts)
    }

    func testFullySetUpGoesHome() {
        XCTAssertNil(OnboardingGate.firstMissingStep(setUp))
    }

    /// Sign-in is the welcome: with nothing set up, the flow opens on
    /// permissions — never the retired onboarding welcome.
    func testNothingSetUpStartsAtPermissions() {
        let facts = OnboardingGate.Facts(
            permissionsOK: false,
            serverHasVehicle: false,
            localVehicleOK: false,
            city: nil,
            usableProviders: []
        )
        XCTAssertEqual(OnboardingGate.firstMissingStep(facts), .permissions)
    }

    func testStepsResolveInFlowOrder() {
        XCTAssertEqual(step { $0.permissionsOK = false }, .permissions)
        XCTAssertEqual(step { $0.serverHasVehicle = false; $0.localVehicleOK = false }, .vehicle)
        XCTAssertEqual(step { $0.city = nil }, .city)
        XCTAssertEqual(step { $0.city = "atlantis" }, .city)
        XCTAssertEqual(step { $0.usableProviders = [] }, .linkProvider)
        // The link is for THIS city's provider; another city's doesn't count.
        XCTAssertEqual(step { $0.usableProviders = ["parknyc"] }, .linkProvider)
    }

    /// The car belongs to the account now: a new phone of a returning
    /// driver has no local plate, and the server's answer is what counts.
    func testTheAccountsCarCountsOnANewPhone() {
        XCTAssertNil(step { $0.localVehicleOK = false; $0.serverHasVehicle = true })
    }

    /// A plate typed on this phone before accounts existed never reached
    /// the server, which is what pays — so the vehicle step runs (and
    /// prefills it from this phone).
    func testALocalOnlyPlateStillNeedsSaving() {
        XCTAssertEqual(step { $0.localVehicleOK = true; $0.serverHasVehicle = false }, .vehicle)
    }

    /// The server didn't answer in time: fall back to this phone's plate,
    /// and land on Home rather than re-asking for a provider link.
    func testAnUnreachableServerNeverTrapsAnyone() {
        XCTAssertNil(step { $0.serverHasVehicle = nil; $0.usableProviders = nil })
        XCTAssertEqual(
            step { $0.serverHasVehicle = nil; $0.localVehicleOK = false },
            .vehicle,
            "with no answer and no local plate, the car is genuinely unknown"
        )
    }

    func testSomewhereElseFinishesWithoutAProvider() {
        XCTAssertNil(step { $0.city = "other"; $0.usableProviders = [] })
    }

    /// The gate's two server calls share ONE bounded window: a server that
    /// never answers costs the timeout once, not once per call, and both
    /// halves come back unknown rather than as "missing".
    func testServerFactsGiveUpTogetherAfterTheTimeout() async {
        let started = ContinuousClock.now
        let facts = await OnboardingGate.serverFacts(api: HangingAPI(), timeout: .milliseconds(300))
        let elapsed = ContinuousClock.now - started

        XCTAssertNil(facts.hasVehicle)
        XCTAssertNil(facts.usableProviders)
        XCTAssertLessThan(elapsed, .milliseconds(1500), "the two calls must wait concurrently")
    }

    /// The facts are what the server says: the mock's garage holds a car,
    /// and its default provider scenario has both providers linked.
    func testServerFactsReadTheMock() async {
        let facts = await OnboardingGate.serverFacts(api: MockAPI(), timeout: .seconds(4))
        XCTAssertEqual(facts.hasVehicle, true)
        XCTAssertEqual(facts.usableProviders, ["parknyc", "passport"])
    }
}

/// Answers nothing, ever — the one-bar-in-a-garage server.
private struct HangingAPI: APIClient {
    private func hang<T>() async throws -> T {
        try await Task.sleep(for: .seconds(60))
        throw APIError.notImplemented
    }

    func vehicles() async throws -> [VehicleSummary] { try await hang() }
    func providersStatus() async throws -> ProvidersStatusResponse { try await hang() }

    // Unused by the gate.
    func signInWithApple(
        identityToken: String,
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
    func paymentSource() async throws -> PaymentSourceResponse { try await hang() }
    func updatePaymentSource(_ source: PaymentSource) async throws -> PaymentSourceResponse { try await hang() }
    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse {
        try await hang()
    }
    func health() async throws -> HealthResponse { try await hang() }
    func detectCity(lat: Double, lng: Double) async throws -> CityDetectResponse { try await hang() }
    func linkProvider(
        _ providerId: String,
        cookies: [ProviderCookie],
        setUpCard: Bool,
        consent: Bool
    ) async throws -> ProviderLinkResponse { try await hang() }
    func linkStatus(providerId: String, jobId: String) async throws -> LinkStatusResponse { try await hang() }
    func setupCard(providerId: String) async throws -> SetupCardResponse { try await hang() }
    func unlinkProvider(_ providerId: String) async throws -> UnlinkResponse { try await hang() }
    func prepareCard() async throws -> CardPrepareResponse { try await hang() }
    func topupIntent(amountUsd: Double) async throws -> TopupIntentResponse { try await hang() }
    func card() async throws -> CardResponse { try await hang() }
    func cardTransactions(cursor: String?) async throws -> CardTransactionsResponse { try await hang() }
    func cardTopup(amountUsd: Double) async throws -> CardFundingResponse { try await hang() }
    func cardWithdraw(amountUsd: Double) async throws -> CardFundingResponse { try await hang() }
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
    func confirmPlan(planId: String, optionId: String?) async throws -> AssistantConfirmResponse { try await hang() }
    func itineraries() async throws -> ItinerariesResponse { try await hang() }
    func patchItinerary(id: String, stops: [ItineraryStop]) async throws -> ItineraryPatchResponse {
        try await hang()
    }
    func linkWalletStatus() async throws -> LinkWalletStatus { try await hang() }
    func linkWalletConnect() async throws -> LinkConnectResponse { try await hang() }
    func linkWalletDisconnect() async throws { try await hang() as Void }
    func syncLinkSpendRequest(id: String) async throws -> LinkSpendSyncResponse { try await hang() }
}
