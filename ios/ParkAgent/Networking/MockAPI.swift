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

/// In-memory fixtures shaped by server/API.md. The default in DEBUG so every
/// screen is walkable on the simulator without a server or motion data.
struct MockAPI: APIClient {
    private let store = MockSessionStore()

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

    /// A touch of latency so loading states are visible.
    private func pause() async throws {
        try await Task.sleep(for: .milliseconds(400))
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
