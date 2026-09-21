import Foundation

/// Which canned `/parked` outcome the mock serves. Persisted so the Settings
/// picker survives relaunches; `MockAPI` reads it on every call.
enum MockScenario: String, CaseIterable, Identifiable, Sendable {
    case singleQuote
    case twoCandidates
    case freePeriod
    case unknownZone
    case paymentFailed

    static let defaultsKey = "mockScenario"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .singleQuote: "Single quote"
        case .twoCandidates: "Two candidates"
        case .freePeriod: "Free period"
        case .unknownZone: "Unknown zone"
        case .paymentFailed: "Payment failed"
        }
    }
}

/// Which canned Card-tab state the mock serves; orthogonal to MockScenario
/// so park-flow tests keep their default card. Persisted like MockScenario.
enum CardMockScenario: String, CaseIterable, Identifiable, Sendable {
    /// Active card, funded account, a few transactions.
    case ready
    /// issuing:setup never ran: GET /card returns card: null.
    case noCard
    /// Card exists but nothing has been charged yet.
    case noTransactions
    /// Financial account not ready: no balance, funding moves refuse.
    case fundingNotReady
    /// Card starts frozen (status inactive).
    case frozen

    static let defaultsKey = "cardScenario"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .ready: "Ready"
        case .noCard: "No card yet"
        case .noTransactions: "No transactions"
        case .fundingNotReady: "Funding not ready"
        case .frozen: "Frozen"
        }
    }
}

/// Which canned provider-account state the mock serves (link flow, parked
/// sheet routing, Settings "Linked accounts"). Persisted like MockScenario.
enum ProviderMockScenario: String, CaseIterable, Identifiable, Sendable {
    /// ParkNYC linked — pay flows work.
    case linked
    /// Nothing linked: the parked sheet routes into the link flow.
    case notLinked
    /// The ParkNYC session died; re-link required.
    case expired
    /// Nothing linked, and the chained card-setup job fails once —
    /// exercises the failed-link retry path.
    case linkFails

    static let defaultsKey = "providerScenario"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .linked: "ParkNYC linked"
        case .notLinked: "Not linked"
        case .expired: "Link expired"
        case .linkFails: "Card setup fails once"
        }
    }
}

/// Which city the mock GET /city detects. Persisted like MockScenario.
enum CityMockScenario: String, CaseIterable, Identifiable, Sendable {
    case nyc
    case bos
    /// Nowhere near a metered zone — "we're not there yet".
    case none

    static let defaultsKey = "cityScenario"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .nyc: "New York City"
        case .bos: "Boston"
        case .none: "Somewhere else"
        }
    }
}

/// In-memory fixtures shaped by server/API.md. The default in DEBUG so every
/// screen is walkable on the simulator without a server or motion data.
struct MockAPI: APIClient {
    private let store = MockSessionStore()
    private let cardStore = MockCardStore()
    private let providerStore = MockProviderStore()
    private let policyStore = MockPolicyStore()

    private var scenario: MockScenario {
        MockScenario(rawValue: UserDefaults.standard.string(forKey: MockScenario.defaultsKey) ?? "")
            ?? .singleQuote
    }

    private var providerScenario: ProviderMockScenario {
        ProviderMockScenario(
            rawValue: UserDefaults.standard.string(forKey: ProviderMockScenario.defaultsKey) ?? ""
        ) ?? .linked
    }

    private var cityScenario: CityMockScenario {
        CityMockScenario(rawValue: UserDefaults.standard.string(forKey: CityMockScenario.defaultsKey) ?? "")
            ?? .nyc
    }

    func parked(_ request: ParkedRequest) async throws -> ParkedResponse {
        try await pause()
        let provider = await parknycProvider()
        switch scenario {
        case .singleQuote, .paymentFailed:
            return MockFixtures.singleQuote(provider: provider)
        case .twoCandidates:
            return MockFixtures.twoCandidates(provider: provider)
        case .freePeriod:
            return MockFixtures.freePeriod(provider: provider)
        case .unknownZone:
            return MockFixtures.unknownZone()
        }
    }

    private func parknycProvider() async -> ParkedProvider {
        let status = await providerStore.status(of: "parknyc", scenario: providerScenario)
        return MockFixtures.parkedProvider(id: "parknyc", status: status)
    }

    func policy() async throws -> PolicyResponse {
        try await pause()
        return await policyStore.current()
    }

    func updatePolicy(_ policy: Policy) async throws -> PolicyResponse {
        try await pause()
        return await policyStore.replace(policy)
    }

    func startSession(_ request: SessionStartRequest) async throws -> SessionStartResponse {
        try await pause()
        if scenario == .paymentFailed { throw APIError.paymentFailed }
        if await providerStore.status(of: "parknyc", scenario: providerScenario) != "linked" {
            throw APIError.refused(code: "provider_not_linked")
        }
        let expiresAt = await store.start(minutes: request.minutes)
        return SessionStartResponse(
            sessionId: "mock-\(UUID().uuidString.prefix(8))",
            expiresAt: expiresAt,
            amountUsd: MockFixtures.price(minutes: request.minutes)
        )
    }

    func stopSession(sessionId: String) async throws -> SessionStopResponse {
        try await pause()
        await store.clear()
        return SessionStopResponse(sessionId: sessionId, stoppedAt: AppClock.now)
    }

    func extendSession(sessionId: String, minutes: Int) async throws -> SessionExtendResponse {
        try await pause()
        let expiresAt = await store.extend(minutes: minutes)
        return SessionExtendResponse(
            sessionId: sessionId,
            expiresAt: expiresAt,
            amountUsd: MockFixtures.extensionPrice(minutes: minutes)
        )
    }

    func reportLocation(_ report: LocationReport) async throws {
        try await pause()
    }

    func registerDevice(_ registration: DeviceRegistration) async throws {
        try await pause()
    }

    // MARK: - City & providers

    func detectCity(lat: Double, lng: Double) async throws -> CityDetectResponse {
        try await pause()
        switch cityScenario {
        case .nyc:
            return CityDetectResponse(
                city: "nyc",
                cityDisplayName: "New York City",
                provider: await parknycProvider()
            )
        case .bos:
            let status = await providerStore.status(of: "passport", scenario: providerScenario)
            return CityDetectResponse(
                city: "bos",
                cityDisplayName: "Boston",
                provider: MockFixtures.parkedProvider(id: "passport", status: status)
            )
        case .none:
            return CityDetectResponse(city: nil, cityDisplayName: nil, provider: nil)
        }
    }

    func providersStatus() async throws -> ProvidersStatusResponse {
        try await pause()
        let scenario = providerScenario
        var providers: [ProviderAccountStatus] = []
        for id in ["parknyc", "passport"] {
            let status = await providerStore.status(of: id, scenario: scenario)
            let cardAdded = await providerStore.cardAdded(of: id)
            providers.append(MockFixtures.providerStatus(id: id, status: status, cardAdded: cardAdded))
        }
        return ProvidersStatusResponse(providers: providers)
    }

    func linkProvider(
        _ providerId: String,
        cookies: [ProviderCookie],
        setUpCard: Bool,
        consent: Bool
    ) async throws -> ProviderLinkResponse {
        try await pause()
        guard !cookies.isEmpty else { throw APIError.refused(code: "no_session_cookies") }
        if setUpCard && !consent { throw APIError.invalidRequest("consent_required") }
        let jobId = await providerStore.link(
            providerId,
            setUpCard: setUpCard,
            failsFirstSetup: providerScenario == .linkFails
        )
        return ProviderLinkResponse(status: "linked", walletBalanceCents: 1250, jobId: jobId)
    }

    func linkStatus(providerId: String, jobId: String) async throws -> LinkStatusResponse {
        // Half the funding pause: the progress screen polls, and each state
        // should be visible without dragging the flow out.
        try await Task.sleep(for: .milliseconds(200))
        guard let status = await providerStore.pollJob(jobId) else {
            throw APIError.refused(code: "unknown_job")
        }
        return status
    }

    func setupCard(providerId: String) async throws -> SetupCardResponse {
        try await pause()
        await providerStore.retrySetup(providerId)
        return SetupCardResponse(ok: true, dryRun: true)
    }

    func unlinkProvider(_ providerId: String) async throws -> UnlinkResponse {
        try await pause()
        let anyOtherLinked = await providerStore.unlink(providerId, scenario: providerScenario)
        return UnlinkResponse(ok: true, cardRemoval: "removed", cardFrozen: !anyOtherLinked)
    }

    // MARK: - Card

    func prepareCard() async throws -> CardPrepareResponse {
        try await pause()
        return CardPrepareResponse(
            created: cardScenario == .noCard,
            card: CardPrepareResponse.PreparedCard(
                stripeCardId: "ic_mock_1",
                last4: "4242",
                status: "pending_onboarding"
            )
        )
    }

    func topupIntent(amountUsd: Double) async throws -> TopupIntentResponse {
        try await pause()
        let policy = await policyStore.current().policy
        if amountUsd > policy.dailyCapUsd {
            throw APIError.refused(code: "amount_over_daily_cap")
        }
        // The mock is always dry run: no PaymentIntent exists and the Apple
        // Pay sheet is never presented, mirroring the server's fake secret.
        return TopupIntentResponse(clientSecret: "pi_dryrun_mock", paymentIntentId: nil, dryRun: true)
    }

    private var cardScenario: CardMockScenario {
        CardMockScenario(rawValue: UserDefaults.standard.string(forKey: CardMockScenario.defaultsKey) ?? "")
            ?? .ready
    }

    func card() async throws -> CardResponse {
        try await pause()
        let scenario = cardScenario
        if scenario == .noCard {
            return CardResponse(card: nil, funding: CardFunding(available: false), dryRun: true)
        }
        let state = await cardStore.state(startFrozen: scenario == .frozen)
        let fundingReady = scenario != .fundingNotReady
        return CardResponse(
            card: MockFixtures.cardSummary(frozen: state.frozen),
            funding: fundingReady
                ? CardFunding(available: true, balanceUsd: state.balanceUsd, pendingUsd: state.pendingUsd)
                : CardFunding(available: false),
            dryRun: true
        )
    }

    func cardTransactions(cursor: String?) async throws -> CardTransactionsResponse {
        try await pause()
        if cardScenario == .noCard || cardScenario == .noTransactions {
            return CardTransactionsResponse(items: [], nextCursor: nil)
        }
        return CardTransactionsResponse(items: MockFixtures.cardTransactions(), nextCursor: nil)
    }

    func cardTopup(amountUsd: Double) async throws -> CardFundingResponse {
        try await pause()
        if cardScenario == .fundingNotReady { throw APIError.refused(code: "funding_unavailable") }
        // The mock mirrors the server's dry-run refusal so the sheet's
        // banner and error path are walkable without a server.
        let state = await cardStore.topup(amountUsd)
        return CardFundingResponse(ok: true, balanceUsd: state.balanceUsd, pendingUsd: state.pendingUsd, decisionId: "mock-decision")
    }

    func cardWithdraw(amountUsd: Double) async throws -> CardFundingResponse {
        try await pause()
        if cardScenario == .fundingNotReady { throw APIError.refused(code: "funding_unavailable") }
        guard await cardStore.canWithdraw(amountUsd) else { throw APIError.refused(code: "insufficient_funds") }
        let state = await cardStore.withdraw(amountUsd)
        return CardFundingResponse(ok: true, balanceUsd: state.balanceUsd, pendingUsd: state.pendingUsd, decisionId: "mock-decision")
    }

    func revealCardDetails() async throws -> RevealedCardDetails {
        try await pause()
        if cardScenario == .noCard { throw APIError.refused(code: "no_card") }
        return RevealedCardDetails(number: "4242424242424242", cvc: "123", expMonth: 8, expYear: 2030)
    }

    func freezeCard() async throws -> CardStatusResponse {
        try await pause()
        await cardStore.setFrozen(true)
        return CardStatusResponse(status: "inactive")
    }

    func unfreezeCard() async throws -> CardStatusResponse {
        try await pause()
        await cardStore.setFrozen(false)
        return CardStatusResponse(status: "active")
    }

    /// A touch of latency so loading states are visible.
    private func pause() async throws {
        try await Task.sleep(for: .milliseconds(400))
    }
}

/// Frozen state and balance for the mock card, so freeze and funding moves
/// stick for the life of the app run (the real server owns this state).
private actor MockCardStore {
    struct State {
        var frozen: Bool
        var balanceUsd: Double
        var pendingUsd: Double
    }

    private var current: State?

    func state(startFrozen: Bool) -> State {
        if let current { return current }
        let fresh = State(frozen: startFrozen, balanceUsd: 42.50, pendingUsd: 0)
        current = fresh
        return fresh
    }

    func setFrozen(_ frozen: Bool) {
        var state = current ?? State(frozen: frozen, balanceUsd: 42.50, pendingUsd: 0)
        state.frozen = frozen
        current = state
    }

    func canWithdraw(_ amountUsd: Double) -> Bool {
        amountUsd <= (current?.balanceUsd ?? 42.50)
    }

    func topup(_ amountUsd: Double) -> State {
        var state = state(startFrozen: false)
        state.balanceUsd += amountUsd
        current = state
        return state
    }

    func withdraw(_ amountUsd: Double) -> State {
        var state = state(startFrozen: false)
        state.balanceUsd -= amountUsd
        current = state
        return state
    }
}

/// Provider-account state for the mock: link/unlink stick for the app run,
/// and chained card-setup jobs progress adding_card → done (or fail once
/// under the linkFails scenario) as the app polls.
private actor MockProviderStore {
    private var statusOverrides: [String: String] = [:]
    private var cardAddedFlags: [String: Bool] = [:]

    private struct Job {
        var provider: String
        var polls = 0
        var failsFirstSetup: Bool
        var retried = false
    }

    private var jobs: [String: Job] = [:]
    private var jobCounter = 0

    /// Scenario gives the starting state; link/unlink actions override it.
    func status(of providerId: String, scenario: ProviderMockScenario) -> String {
        if let override = statusOverrides[providerId] { return override }
        guard providerId == "parknyc" else { return "unlinked" }
        switch scenario {
        case .linked: return "linked"
        case .notLinked, .linkFails: return "unlinked"
        case .expired: return "expired"
        }
    }

    func cardAdded(of providerId: String) -> Bool {
        cardAddedFlags[providerId] ?? false
    }

    func link(_ providerId: String, setUpCard: Bool, failsFirstSetup: Bool) -> String? {
        statusOverrides[providerId] = "linked"
        guard setUpCard else { return nil }
        jobCounter += 1
        let id = "mock-job-\(jobCounter)"
        jobs[id] = Job(provider: providerId, failsFirstSetup: failsFirstSetup)
        return id
    }

    /// First poll reports adding_card, the second resolves — so the progress
    /// screen shows each phase.
    func pollJob(_ jobId: String) -> LinkStatusResponse? {
        guard var job = jobs[jobId] else { return nil }
        job.polls += 1
        jobs[jobId] = job
        if job.polls <= 1 {
            return LinkStatusResponse(phase: "adding_card", reason: nil, retrySafe: nil, dryRun: nil)
        }
        if job.failsFirstSetup && !job.retried {
            return LinkStatusResponse(phase: "failed", reason: "network", retrySafe: true, dryRun: nil)
        }
        cardAddedFlags[job.provider] = true
        return LinkStatusResponse(phase: "done", reason: nil, retrySafe: nil, dryRun: true)
    }

    func retrySetup(_ providerId: String) {
        for (id, var job) in jobs where job.provider == providerId {
            job.retried = true
            jobs[id] = job
        }
        cardAddedFlags[providerId] = true
    }

    /// Returns whether any other provider is still linked (drives cardFrozen).
    func unlink(_ providerId: String, scenario: ProviderMockScenario) -> Bool {
        statusOverrides[providerId] = "unlinked"
        cardAddedFlags[providerId] = false
        return ["parknyc", "passport"]
            .filter { $0 != providerId }
            .contains { status(of: $0, scenario: scenario) == "linked" }
    }
}

/// Holds budget edits from the onboarding budget step for the app run; the
/// real server rewrites policy.json.
private actor MockPolicyStore {
    private var policy: Policy?

    func current() -> PolicyResponse {
        wrap(policy ?? MockFixtures.policy().policy)
    }

    func replace(_ next: Policy) -> PolicyResponse {
        policy = next
        return wrap(next)
    }

    private func wrap(_ policy: Policy) -> PolicyResponse {
        PolicyResponse(policy: policy, hash: "sha256:mock", dryRun: true)
    }
}

/// Keeps the mock's expiry consistent across start/extend, since the real
/// server owns that state.
private actor MockSessionStore {
    private var expiresAt: Date?

    func start(minutes: Int) -> Date {
        let date = AppClock.now.addingTimeInterval(TimeInterval(minutes) * 60)
        expiresAt = date
        return date
    }

    func extend(minutes: Int) -> Date {
        let date = (expiresAt ?? AppClock.now).addingTimeInterval(TimeInterval(minutes) * 60)
        expiresAt = date
        return date
    }

    func clear() {
        expiresAt = nil
    }
}

/// Fixture data, based on the worked example in server/API.md (Columbus Ave
/// near W 81st St). Also used by AppModel for the manual zone-number path,
/// which has no server endpoint yet.
enum MockFixtures {
    static let hours = [
        EnforcementHours(days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "19:00")
    ]

    static func singleQuote(
        zoneNumber: String = "110436",
        provider: ParkedProvider? = MockFixtures.parkedProvider(id: "parknyc", status: "linked")
    ) -> ParkedResponse {
        let candidate = candidate(zoneNumber: zoneNumber, distanceM: 9.3, containsPoint: true)
        return response(
            action: .pay, rule: "auto_pay_ok",
            candidates: [candidate], quote: candidate.quote, provider: provider
        )
    }

    static func twoCandidates(
        provider: ParkedProvider? = MockFixtures.parkedProvider(id: "parknyc", status: "linked")
    ) -> ParkedResponse {
        let nearest = candidate(zoneNumber: "110436", distanceM: 9.3, containsPoint: true)
        let other = candidate(
            zoneNumber: "110437", distanceM: 14.8, containsPoint: false,
            firstHour: 5.50, additionalHour: 9.00, maxStayMinutes: 60, stayMinutes: 60
        )
        return response(
            action: .confirm, rule: "candidates_disagree",
            candidates: [nearest, other], quote: nearest.quote, provider: provider
        )
    }

    static func freePeriod(
        provider: ParkedProvider? = MockFixtures.parkedProvider(id: "parknyc", status: "linked")
    ) -> ParkedResponse {
        var free = candidate(zoneNumber: "110436", distanceM: 9.3, containsPoint: true)
        free.quote.chargedMinutes = 0
        free.quote.meterUsd = 0
        free.quote.feeUsd = 0
        free.quote.totalUsd = 0
        return response(
            action: .ignore, rule: "free_period",
            candidates: [free], quote: free.quote, provider: provider
        )
    }

    static func unknownZone() -> ParkedResponse {
        response(action: .unknownZone, rule: "unknown_zone", candidates: [], quote: nil, provider: nil)
    }

    // MARK: - Provider fixtures

    /// Mirrors src/providers/registry.ts on the server.
    static func parkedProvider(id: String, status: String) -> ParkedProvider {
        ParkedProvider(
            id: id,
            city: id == "passport" ? "bos" : "nyc",
            displayName: id == "passport" ? "ParkBoston" : "ParkNYC",
            loginUrl: id == "passport"
                ? "https://bostonma.ppprk.com/park/"
                : "https://my.nyc.flowbirdapp.com/#/Parking?panel=login",
            status: status,
            linked: status == "linked"
        )
    }

    static func providerStatus(id: String, status: String, cardAdded: Bool) -> ProviderAccountStatus {
        let base = parkedProvider(id: id, status: status)
        return ProviderAccountStatus(
            id: base.id,
            city: base.city,
            cityDisplayName: base.city == "bos" ? "Boston" : "New York City",
            displayName: base.displayName,
            loginUrl: base.loginUrl,
            cookieDomains: base.city == "bos"
                ? ["ppprk.com", "paywithpassport.com"]
                : ["nyc.flowbirdapp.com", "flowbirdapp.com"],
            status: status,
            linkedAt: status == "linked" ? AppClock.now : nil,
            lastVerifiedAt: status == "linked" ? AppClock.now : nil,
            cardAdded: cardAdded,
            walletBalanceCents: status == "linked" ? 1250 : nil
        )
    }

    /// What the mock sign-in button hands the link flow in place of real
    /// web-view cookies.
    static func linkCookies(for providerId: String) -> [ProviderCookie] {
        let domain = providerId == "passport" ? ".bostonma.ppprk.com" : ".nyc.flowbirdapp.com"
        return [
            ProviderCookie(
                name: "mock_session",
                value: "mock-cookie-value",
                domain: domain,
                path: "/",
                expires: AppClock.now.addingTimeInterval(86_400).timeIntervalSince1970,
                httpOnly: true,
                secure: true,
                sameSite: "Lax"
            )
        ]
    }

    static func policy() -> PolicyResponse {
        PolicyResponse(
            policy: Policy(
                dryRun: true,
                shadowMode: nil,
                sessionCapUsd: 45,
                dailyCapUsd: 60,
                autoPayMaxRatePerHour: 8.0,
                defaultStayMinutes: 90,
                parknycFeeUsd: 0.15,
                autoExtend: AutoExtendPolicy(
                    enabled: true,
                    maxCount: 2,
                    maxMinutesEach: 60,
                    noExtendWithinMinutesOfMaxStay: 15
                ),
                respectEnforcementHours: true,
                ticketCostUsd: 65,
                cityOverrides: [
                    "nyc": CityPolicyOverride(parkingFeeUsd: nil, ticketCostUsd: 65),
                    "bos": CityPolicyOverride(parkingFeeUsd: 0.35, ticketCostUsd: 40),
                ]
            ),
            hash: "sha256:mock",
            dryRun: true
        )
    }

    /// Rate ladder from API.md: first 60 min at the first-hour rate, the rest
    /// at the additional-hour rate, both prorated, plus the fixed fee.
    static func price(minutes: Int, firstHour: Double = 5.0, additionalHour: Double = 8.25) -> Double {
        let first = Double(min(minutes, 60)) / 60 * firstHour
        let rest = Double(max(0, minutes - 60)) / 60 * additionalHour
        return round2(round2(first + rest) + 0.15)
    }

    static func extensionPrice(minutes: Int, additionalHour: Double = 8.25) -> Double {
        round2(Double(minutes) / 60 * additionalHour)
    }

    // MARK: - Card fixtures

    static func cardSummary(frozen: Bool) -> CardSummary {
        CardSummary(
            stripeCardId: "ic_mock_1",
            last4: "4242",
            brand: "Visa",
            status: frozen ? "inactive" : "active",
            expMonth: 8,
            expYear: 2030,
            cardholderName: "Thomas Bardhi",
            spendingControls: CardSpendingControls(perAuthorizationUsd: 45, dailyUsd: 60),
            spentTodayUsd: 7.28,
            spentThisMonthUsd: 23.81
        )
    }

    /// A day of history: today's approved charge (linked to no session, it
    /// IS the active flow), a declined attempt, a pending hold, and
    /// yesterday's settled charge linked to the seeded history session.
    static func cardTransactions() -> [CardTransaction] {
        let now = AppClock.now
        let yesterday = now.addingTimeInterval(-24 * 3600)
        return [
            CardTransaction(
                id: "mock-txn-1",
                stripeAuthorizationId: "iauth_mock_1",
                merchantName: "ParkNYC Meter 110436",
                merchantCategory: "parking_lots_garages",
                amountUsd: 7.28,
                capturedUsd: nil,
                approved: true,
                decision: "approved",
                status: "pending",
                createdAt: now.addingTimeInterval(-45 * 60),
                sessionId: nil
            ),
            CardTransaction(
                id: "mock-txn-2",
                stripeAuthorizationId: "iauth_mock_2",
                merchantName: "MTA Vending",
                merchantCategory: "transportation",
                amountUsd: 2.90,
                capturedUsd: nil,
                approved: false,
                decision: "declined_wrong_mcc",
                status: "closed",
                createdAt: now.addingTimeInterval(-3 * 3600),
                sessionId: nil
            ),
            CardTransaction(
                id: "mock-txn-3",
                stripeAuthorizationId: "iauth_mock_3",
                merchantName: "ParkNYC Meter 110212",
                merchantCategory: "parking_lots_garages",
                amountUsd: 9.28,
                capturedUsd: 9.28,
                approved: true,
                decision: "approved",
                status: "closed",
                createdAt: yesterday,
                sessionId: "mock-history-1"
            ),
        ]
    }

    // MARK: - Builders

    private static func candidate(
        zoneNumber: String,
        distanceM: Double,
        containsPoint: Bool,
        firstHour: Double = 5.0,
        additionalHour: Double = 8.25,
        maxStayMinutes: Int = 120,
        stayMinutes: Int = 90
    ) -> Candidate {
        let meter = round2(
            Double(min(stayMinutes, 60)) / 60 * firstHour
                + Double(max(0, stayMinutes - 60)) / 60 * additionalHour
        )
        return Candidate(
            zoneId: "nyc-\(zoneNumber)",
            city: "nyc",
            parknycZoneNumber: zoneNumber,
            distanceM: distanceM,
            containsPoint: containsPoint,
            rateFirstHourUsd: firstHour,
            rateAdditionalHourUsd: additionalHour,
            maxStayMinutes: maxStayMinutes,
            hours: hours,
            quote: Quote(
                zoneId: "nyc-\(zoneNumber)",
                parknycZoneNumber: zoneNumber,
                stayMinutes: stayMinutes,
                chargedMinutes: stayMinutes,
                meterUsd: meter,
                feeUsd: 0.15,
                totalUsd: round2(meter + 0.15)
            )
        )
    }

    private static func response(
        action: ParkedAction,
        rule: String,
        candidates: [Candidate],
        quote: Quote?,
        provider: ParkedProvider?
    ) -> ParkedResponse {
        ParkedResponse(
            action: action,
            candidates: candidates,
            quote: quote,
            rule: rule,
            dryRun: true,
            provider: provider,
            parkedEventId: "mock-parked-\(UUID().uuidString.prefix(8))",
            decisionId: "mock-decision-\(UUID().uuidString.prefix(8))"
        )
    }

    private static func round2(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }
}
