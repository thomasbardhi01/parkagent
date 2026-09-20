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

/// In-memory fixtures shaped by server/API.md. The default in DEBUG so every
/// screen is walkable on the simulator without a server or motion data.
struct MockAPI: APIClient {
    private let store = MockSessionStore()
    private let cardStore = MockCardStore()

    private var scenario: MockScenario {
        MockScenario(rawValue: UserDefaults.standard.string(forKey: MockScenario.defaultsKey) ?? "")
            ?? .singleQuote
    }

    func parked(_ request: ParkedRequest) async throws -> ParkedResponse {
        try await pause()
        switch scenario {
        case .singleQuote, .paymentFailed:
            return MockFixtures.singleQuote()
        case .twoCandidates:
            return MockFixtures.twoCandidates()
        case .freePeriod:
            return MockFixtures.freePeriod()
        case .unknownZone:
            return MockFixtures.unknownZone()
        }
    }

    func policy() async throws -> PolicyResponse {
        try await pause()
        return MockFixtures.policy()
    }

    func startSession(_ request: SessionStartRequest) async throws -> SessionStartResponse {
        try await pause()
        if scenario == .paymentFailed { throw APIError.paymentFailed }
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

    // MARK: - Card

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

    static func singleQuote(zoneNumber: String = "110436") -> ParkedResponse {
        let candidate = candidate(zoneNumber: zoneNumber, distanceM: 9.3, containsPoint: true)
        return response(action: .pay, rule: "auto_pay_ok", candidates: [candidate], quote: candidate.quote)
    }

    static func twoCandidates() -> ParkedResponse {
        let nearest = candidate(zoneNumber: "110436", distanceM: 9.3, containsPoint: true)
        let other = candidate(
            zoneNumber: "110437", distanceM: 14.8, containsPoint: false,
            firstHour: 5.50, additionalHour: 9.00, maxStayMinutes: 60, stayMinutes: 60
        )
        return response(
            action: .confirm, rule: "candidates_disagree",
            candidates: [nearest, other], quote: nearest.quote
        )
    }

    static func freePeriod() -> ParkedResponse {
        var free = candidate(zoneNumber: "110436", distanceM: 9.3, containsPoint: true)
        free.quote.chargedMinutes = 0
        free.quote.meterUsd = 0
        free.quote.feeUsd = 0
        free.quote.totalUsd = 0
        return response(action: .ignore, rule: "free_period", candidates: [free], quote: free.quote)
    }

    static func unknownZone() -> ParkedResponse {
        response(action: .unknownZone, rule: "unknown_zone", candidates: [], quote: nil)
    }

    static func policy() -> PolicyResponse {
        PolicyResponse(
            policy: Policy(
                dryRun: true,
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
                ticketCostUsd: 65
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
        quote: Quote?
    ) -> ParkedResponse {
        ParkedResponse(
            action: action,
            candidates: candidates,
            quote: quote,
            rule: rule,
            dryRun: true,
            parkedEventId: "mock-parked-\(UUID().uuidString.prefix(8))",
            decisionId: "mock-decision-\(UUID().uuidString.prefix(8))"
        )
    }

    private static func round2(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }
}
