// UI tests and SwiftUI previews only. The whole file is compiled out of
// Release builds (ParkAgentReleaseTests proves it): a TestFlight build has
// no mock server, no fixtures, and no scenario switches.
#if DEBUG
import CoreLocation
import Foundation

/// Which canned `/parked` outcome the mock serves (`-mockScenario`); `MockAPI`
/// reads it on every call.
enum MockScenario: String, Sendable {
    case singleQuote
    case twoCandidates
    case freePeriod
    case unknownZone
    case paymentFailed
    /// Boston block with no known ParkBoston number: the sheet collects it
    /// from the meter, and later parks at the block are automatic.
    case bostonNeedsZone
    /// /parked quotes normally, but session/start answers free_period —
    /// the provider says the zone isn't charging right now.
    case freePeriodAtStart
    /// Boston capture flow where an import already claims the block with
    /// a DIFFERENT number: the report is outranked (import precedence)
    /// and the session pays the import's number.
    case bostonImportConflict
    /// session/start answers card_declined: the ParkAgent card's hold was
    /// refused, nothing was paid, and the fix is in the Wallet.
    case cardDeclined

    static let defaultsKey = "mockScenario"
}

/// Which canned provider-account state the mock serves (link flow, parked
/// sheet routing, the Account sheet's accounts). Set by `-providerScenario`.
enum ProviderMockScenario: String, Sendable {
    /// ParkNYC linked — pay flows work.
    case linked
    /// Nothing linked: the parked sheet routes into the link flow.
    case notLinked
    /// The ParkNYC session died; re-link required.
    case expired
    /// The health job saw ParkNYC's cookies dying soon: still pays, but
    /// the Account sheet asks for a reconnect.
    case expiring
    /// Nothing linked, and the chained card-setup job fails once —
    /// exercises the failed-link retry path.
    case linkFails

    static let defaultsKey = "providerScenario"
}

/// Which city the mock GET /city detects (`-cityScenario`).
enum CityMockScenario: String, Sendable {
    case nyc
    case bos
    /// Nowhere near a metered zone — "we're not there yet".
    case none

    static let defaultsKey = "cityScenario"
}

/// Which canned sign-in behavior the mock serves. UI tests drive the
/// welcome screen through this (a real Apple sheet can't be automated).
enum AuthMockScenario: String, Sendable {
    /// Every sign-in succeeds and returns an existing account.
    case returning
    /// Every sign-in succeeds and reports `created`. Where either lands is
    /// the onboarding gate's call, not this flag's.
    case newUser
    /// The email code is always wrong — exercises the retry copy.
    case badCode
    /// Apple sign-in fails verification server-side.
    case appleFails

    static let defaultsKey = "authScenario"
}

/// In-memory fixtures shaped by server/API.md, for UI tests and previews
/// only: a launch opts in with `-useMockAPI YES` and nothing persists it.
struct MockAPI: APIClient {
    static let policyReadOnlyKey = "policyReadOnly"

    private let store = MockSessionStore()
    private let providerStore = MockProviderStore()
    private let policyStore = MockPolicyStore()
    private let zoneStore = MockZoneNumberStore()
    private let profileStore = MockProfileStore()

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

    private var authScenario: AuthMockScenario {
        AuthMockScenario(rawValue: UserDefaults.standard.string(forKey: AuthMockScenario.defaultsKey) ?? "")
            ?? .returning
    }

    /// Which methods the mock server has switched on — Apple only, like a
    /// real deployment, unless a test passes `-authMethods apple,email`.
    private var enabledMethods: AuthMethods {
        let raw = UserDefaults.standard.string(forKey: Self.authMethodsKey) ?? "apple"
        let names = Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
        return AuthMethods(apple: true, email: names.contains("email"), google: names.contains("google"))
    }

    static let authMethodsKey = "authMethods"

    // MARK: - Identity

    func authMethods() async throws -> AuthMethods {
        try await pause()
        return enabledMethods
    }

    func signInWithApple(
        identityToken: String,
        deviceId: String,
        fullName: (given: String?, family: String?)?
    ) async throws -> AuthSession {
        try await pause()
        if authScenario == .appleFails {
            throw APIError.refused(code: "invalid_identity_token")
        }
        let name = [fullName?.given, fullName?.family]
            .compactMap { $0 }
            .joined(separator: " ")
        return await profileStore.session(
            named: name.isEmpty ? nil : name,
            email: "thomas@example.com",
            appleLinked: true,
            created: authScenario == .newUser
        )
    }

    func signInWithGoogle(idToken: String, deviceId: String) async throws -> AuthSession {
        try await pause()
        guard enabledMethods.google else { throw APIError.refused(code: "google_signin_disabled") }
        return await profileStore.session(
            named: nil,
            email: "thomas@example.com",
            googleLinked: true,
            created: authScenario == .newUser
        )
    }

    func startEmailSignIn(email: String) async throws {
        try await pause()
        guard enabledMethods.email else { throw APIError.refused(code: "email_signin_disabled") }
    }

    func verifyEmailSignIn(email: String, code: String, deviceId: String) async throws -> AuthSession {
        try await pause()
        guard enabledMethods.email else { throw APIError.refused(code: "email_signin_disabled") }
        if authScenario == .badCode {
            throw APIError.refused(code: "invalid_code")
        }
        return await profileStore.session(
            named: nil,
            email: email,
            created: authScenario == .newUser
        )
    }

    func logout(refreshToken: String) async throws {
        try await pause()
    }

    func me() async throws -> MeResponse {
        try await pause()
        return MeResponse(
            user: await profileStore.user(),
            // The same fact GET /wallet reports — Account and Wallet agree.
            paymentSource: await MockWalletStore.shared.activeSource(),
            issuingLive: UserDefaults.standard.bool(forKey: "issuingLive")
        )
    }

    func updateMe(name: String?, phone: String?) async throws -> AuthUser {
        try await pause()
        return await profileStore.update(name: name, phone: phone)
    }

    func deleteAccount() async throws {
        try await pause()
    }

    // MARK: - Vehicles

    func vehicles() async throws -> [VehicleSummary] {
        try await pause()
        return await profileStore.vehicles()
    }

    func addVehicle(plate: String, state: String, label: String?) async throws -> VehicleSummary {
        try await pause()
        return try await profileStore.addVehicle(plate: plate, state: state, label: label)
    }

    func updateVehicle(
        id: String,
        plate: String?,
        state: String?,
        label: String?
    ) async throws -> VehicleSummary {
        try await pause()
        return try await profileStore.updateVehicle(id: id, plate: plate, state: state, label: label)
    }

    func removeVehicle(id: String) async throws {
        try await pause()
        await profileStore.removeVehicle(id: id)
    }

    func parked(_ request: ParkedRequest) async throws -> ParkedResponse {
        try await pause()
        let provider = await parknycProvider()
        switch scenario {
        case .singleQuote, .paymentFailed, .freePeriodAtStart, .cardDeclined:
            return MockFixtures.singleQuote(provider: provider)
        case .twoCandidates:
            return MockFixtures.twoCandidates(provider: provider)
        case .freePeriod:
            return MockFixtures.freePeriod(provider: provider)
        case .unknownZone:
            return MockFixtures.unknownZone()
        case .bostonNeedsZone, .bostonImportConflict:
            // Once someone reported the block's number, parking there is
            // automatic — like the real zones table.
            let passportStatus = await providerStore.status(of: "passport", scenario: providerScenario)
            let reported = await zoneStore.number(for: MockFixtures.bostonZoneId)
            return MockFixtures.bostonQuote(
                provider: MockFixtures.parkedProvider(id: "passport", status: passportStatus),
                zoneNumber: reported
            )
        }
    }

    func reportZoneNumber(zoneId: String, number: String) async throws -> ZoneNumberReportResponse {
        try await pause()
        // Import precedence, like the real route: a single unverified
        // report loses to an existing import's number.
        let importNumber = scenario == .bostonImportConflict ? MockFixtures.importedZoneNumber : nil
        let applied = importNumber ?? number
        await zoneStore.report(applied, for: zoneId)
        return ZoneNumberReportResponse(
            ok: true,
            zoneId: zoneId,
            number: applied,
            appliedSource: importNumber != nil ? "import" : "report",
            verified: false,
            confirmations: 1
        )
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

    func startSession(_ request: SessionStartRequest) async throws -> SessionStartOutcome {
        try await pause()
        // What the server answers when the executor fails at the provider.
        if scenario == .paymentFailed { throw APIError.refused(code: "executor_failed") }
        if scenario == .cardDeclined { throw APIError.refused(code: "card_declined") }
        if scenario == .freePeriodAtStart {
            // Mirrors the server's 200 {status: "free_period"}: quoted as
            // payable, but the provider said no charge at start time.
            return .freePeriod(notice: "No Meter Parking. Please Check Signage. Mon-Sat 8am-8pm")
        }
        // The zone's city names its provider, like the real server.
        let providerId = request.zoneId.hasPrefix("bos-") ? "passport" : "parknyc"
        if await providerStore.status(of: providerId, scenario: providerScenario) != "linked" {
            throw APIError.refused(code: "provider_not_linked")
        }
        let expiresAt = await store.start(minutes: request.minutes)
        let sessionId = "mock-\(UUID().uuidString.prefix(8))"
        let amount = MockFixtures.price(minutes: request.minutes)
        await MockWalletStore.shared.recordStart(
            sessionId: sessionId,
            zoneNumber: request.zoneId.split(separator: "-").last.map(String.init) ?? request.zoneId,
            minutes: request.minutes,
            totalUsd: amount,
            at: AppClock.now,
            lat: await MockFixtures.currentCoordinate().latitude,
            lng: await MockFixtures.currentCoordinate().longitude
        )
        return .started(SessionStartResponse(
            sessionId: sessionId,
            expiresAt: expiresAt,
            amountUsd: amount
        ))
    }

    func stopSession(sessionId: String) async throws -> SessionStopResponse {
        try await pause()
        await store.clear()
        await MockWalletStore.shared.recordStop(sessionId: sessionId, at: AppClock.now)
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

    func nearbyZones(lat: Double, lng: Double, radiusM: Double) async throws -> NearbyZonesResponse {
        try await pause()
        return MockFixtures.nearbyZones(around: (lat: lat, lng: lng), radiusM: radiusM)
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
        return ProviderLinkResponse(
            status: "linked",
            cardBrand: "Visa",
            cardLast4: providerId == "passport" ? "1234" : "4242",
            jobId: jobId
        )
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
            created: false,
            card: CardPrepareResponse.PreparedCard(
                stripeCardId: "ic_mock_1",
                last4: "4444",
                status: "pending_onboarding"
            )
        )
    }

    func revealCardDetails() async throws -> RevealedCardDetails {
        try await pause()
        guard await MockWalletStore.shared.hasParkAgentCard() else { throw APIError.refused(code: "no_card") }
        // Stripe's Mastercard test PAN, so the last4 match the card's.
        return RevealedCardDetails(number: "5555555555554444", cvc: "123", expMonth: 8, expYear: 2030)
    }

    func freezeCard() async throws -> CardStatusResponse {
        try await pause()
        await MockWalletStore.shared.setFrozen(true)
        return CardStatusResponse(status: "inactive")
    }

    func unfreezeCard() async throws -> CardStatusResponse {
        try await pause()
        await MockWalletStore.shared.setFrozen(false)
        return CardStatusResponse(status: "active")
    }

    /// A touch of latency so loading states are visible.
    func pause() async throws {
        try await Task.sleep(for: .milliseconds(400))
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
        switch scenario {
        // Both providers linked, so NYC and Boston pay flows both work.
        case .linked: return "linked"
        case .notLinked, .linkFails: return "unlinked"
        case .expired: return providerId == "parknyc" ? "expired" : "unlinked"
        case .expiring: return providerId == "parknyc" ? "expiring" : "unlinked"
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

/// The signed-in profile and garage for the mock: sign-in mints a session,
/// the Account sheet edits it, and vehicle changes stick for the app run.
private actor MockProfileStore {
    private var profile = AuthUser(
        id: "mock-user",
        name: "Thomas",
        email: "thomas@example.com",
        emailVerified: true,
        phone: nil,
        phoneVerified: false,
        appleLinked: false,
        googleLinked: false
    )
    private var garage: [VehicleSummary] = [
        VehicleSummary(id: "mock-v1", plate: "ABC1234", state: "NY", label: nil)
    ]
    private var nextVehicle = 2

    func session(
        named name: String? = nil,
        email: String,
        appleLinked: Bool = false,
        googleLinked: Bool = false,
        created: Bool
    ) -> AuthSession {
        if let name { profile.name = name }
        profile.email = email
        profile.emailVerified = true
        if appleLinked { profile.appleLinked = true }
        if googleLinked { profile.googleLinked = true }
        return AuthSession(
            accessToken: "mock-access-token",
            accessExpiresAt: AppClock.now.addingTimeInterval(15 * 60),
            refreshToken: "mock-refresh-token",
            user: profile,
            created: created
        )
    }

    func user() -> AuthUser { profile }

    func update(name: String?, phone: String?) -> AuthUser {
        if let name { profile.name = name }
        profile.phone = phone
        profile.phoneVerified = false
        return profile
    }

    func vehicles() -> [VehicleSummary] { garage }

    func addVehicle(plate: String, state: String, label: String?) throws -> VehicleSummary {
        let normalized = plate.uppercased()
        guard !garage.contains(where: { $0.plate == normalized && $0.state == state.uppercased() })
        else { throw APIError.refused(code: "plate_taken") }
        let vehicle = VehicleSummary(
            id: "mock-v\(nextVehicle)",
            plate: normalized,
            state: state.uppercased(),
            label: label
        )
        nextVehicle += 1
        garage.append(vehicle)
        return vehicle
    }

    func updateVehicle(
        id: String,
        plate: String?,
        state: String?,
        label: String?
    ) throws -> VehicleSummary {
        guard let index = garage.firstIndex(where: { $0.id == id }) else {
            throw APIError.server(status: 404)
        }
        if let plate { garage[index].plate = plate.uppercased() }
        if let state { garage[index].state = state.uppercased() }
        garage[index].label = label
        return garage[index]
    }

    func removeVehicle(id: String) {
        garage.removeAll { $0.id == id }
    }
}

/// User-reported zone numbers for the mock (the real ones live on the
/// server's zones table). Reporting sticks for the app run, so a second
/// park at the block is automatic.
private actor MockZoneNumberStore {
    private var numbers: [String: String] = [:]

    func number(for zoneId: String) -> String? {
        numbers[zoneId]
    }

    func report(_ number: String, for zoneId: String) {
        numbers[zoneId] = number
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
        PolicyResponse(
            policy: policy,
            hash: "sha256:mock",
            dryRun: true,
            // `-policyReadOnly YES`: sign in as someone who isn't the operator.
            editable: !UserDefaults.standard.bool(forKey: MockAPI.policyReadOnlyKey)
        )
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

    /// The Boylston St Back Bay block from server/test fixtures: flat
    /// $3.75/hr, 120 min max, $0.35 ParkBoston fee.
    static let bostonZoneId = "bos-boylston-st-e-d-819305"

    /// What the Find Parking importer claims for that block in the
    /// bostonImportConflict scenario — deliberately not what a driver at
    /// the meter would type.
    static let importedZoneNumber = "55555"

    /// Boston quote; `zoneNumber` nil means nobody has reported the block's
    /// ParkBoston number yet (action confirm + needsZoneNumber).
    static func bostonQuote(provider: ParkedProvider?, zoneNumber: String?) -> ParkedResponse {
        let stayMinutes = 90
        let meter = round2(Double(stayMinutes) / 60 * 3.75)
        let quote = Quote(
            zoneId: bostonZoneId,
            providerZoneNumber: zoneNumber ?? "",
            stayMinutes: stayMinutes,
            chargedMinutes: stayMinutes,
            meterUsd: meter,
            feeUsd: 0.35,
            totalUsd: round2(meter + 0.35)
        )
        let candidate = Candidate(
            zoneId: bostonZoneId,
            city: "bos",
            providerZoneNumber: zoneNumber ?? "",
            distanceM: 6.1,
            containsPoint: true,
            rateFirstHourUsd: 3.75,
            rateAdditionalHourUsd: 3.75,
            maxStayMinutes: 120,
            hours: [EnforcementHours(days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], start: "08:00", end: "20:00")],
            quote: quote
        )
        let known = zoneNumber != nil
        return response(
            action: known ? .pay : .confirm,
            rule: known ? "auto_pay_ok" : "needs_zone_number",
            candidates: [candidate],
            quote: quote,
            provider: provider,
            needsZoneNumber: !known
        )
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
            linked: status == "linked" || status == "expiring",
            signup: providerSignup(id: id)
        )
    }

    /// The registry's link-or-create block (see registry.ts `signup`).
    static func providerSignup(id: String) -> ProviderSignup {
        id == "passport"
            ? ProviderSignup(
                url: "https://bostonma.ppprk.com/park/",
                mode: "passwordless",
                note: "Sign in or sign up on ParkBoston's own page — we never see a password; there isn't one.",
                prefill: [SignupPrefillField(field: "emailOrPhone", selector: "#regEmail")]
            )
            : ProviderSignup(
                url: "https://my.nyc.flowbirdapp.com/#/Parking?panel=register",
                mode: "form",
                note: "Create your ParkNYC account on ParkNYC's own page — we never see your password.",
                prefill: [
                    SignupPrefillField(field: "firstName", selector: "input[name='firstName']"),
                    SignupPrefillField(field: "lastName", selector: "input[name='lastName']"),
                    SignupPrefillField(field: "email", selector: "input[name='email']"),
                    SignupPrefillField(field: "phone", selector: "input[name='phoneNumber']"),
                    SignupPrefillField(field: "zip", selector: "input[name='zipCode']"),
                    SignupPrefillField(field: "plate", selector: "input[name='licensePlate']"),
                ]
            )
    }

    static func providerStatus(id: String, status: String, cardAdded: Bool) -> ProviderAccountStatus {
        let base = parkedProvider(id: id, status: status)
        let usable = status == "linked" || status == "expiring"
        return ProviderAccountStatus(
            id: base.id,
            city: base.city,
            cityDisplayName: base.city == "bos" ? "Boston" : "New York City",
            displayName: base.displayName,
            loginUrl: base.loginUrl,
            cookieDomains: base.city == "bos"
                ? ["ppprk.com", "paywithpassport.com"]
                : ["nyc.flowbirdapp.com", "flowbirdapp.com"],
            signup: base.signup,
            status: status,
            linkedAt: usable ? AppClock.now : nil,
            lastVerifiedAt: usable ? AppClock.now : nil,
            cardAdded: cardAdded,
            // What the provider account's own Your Cards screen showed.
            // The Wallet mock's cards: ParkBoston ••1234, ParkNYC ••4242
            // (live, both read the same provider-account row).
            cardBrand: usable ? "Visa" : nil,
            cardLast4: usable ? (base.city == "bos" ? "1234" : "4242") : nil
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
                parknycFeeUsd: nil,
                autoExtend: AutoExtendPolicy(
                    enabled: true,
                    maxCount: 2,
                    maxMinutesEach: 60,
                    noExtendWithinMinutesOfMaxStay: 15
                ),
                respectEnforcementHours: true,
                ticketCostUsd: 65,
                cityOverrides: [
                    "nyc": CityPolicyOverride(parkingFeeUsd: 0.15, ticketCostUsd: 65),
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

    // MARK: - Map fixtures

    /// Columbus Ave near W 81st St — the worked example in server/API.md.
    /// The NYC fixtures are built around this point, so UI tests and
    /// previews are deterministic. Nothing on a live launch may default to
    /// it (see CityCatalog.center for the city fallbacks).
    static let fixtureCoordinate = CLLocationCoordinate2D(latitude: 40.7784, longitude: -73.9818)

    /// Where the mock says the phone is: the city scenario's center, so a
    /// `-cityScenario bos` launch sees a Boston map rather than the NYC
    /// quote fixtures' coordinate.
    static func currentCoordinate() -> CLLocationCoordinate2D {
        let scenario = CityMockScenario(
            rawValue: UserDefaults.standard.string(forKey: CityMockScenario.defaultsKey) ?? ""
        ) ?? .nyc
        switch scenario {
        case .bos:
            // Boylston St in Back Bay — the block the Boston quote fixtures
            // are built around. The city centroid would put the phone in
            // the middle of the Common, where no curb line belongs.
            return CLLocationCoordinate2D(latitude: 42.3503, longitude: -71.0810)
        case .nyc, .none:
            return fixtureCoordinate
        }
    }

    /// Curb lines for the map layer: a short grid of block faces around the
    /// point, half of them currently free, so the two colors and the tapped
    /// -zone card are both walkable without a server.
    static func nearbyZones(
        around point: (lat: Double, lng: Double),
        radiusM: Double
    ) -> NearbyZonesResponse {
        // ~0.0009° of latitude is about 100 m; enough spread to see distinct
        // lines at street zoom.
        let step = 0.0009
        let zones = (0..<6).map { index -> NearbyZone in
            let row = Double(index / 2)
            let side = Double(index % 2)
            let lat = point.lat + (row - 1) * step
            let lng = point.lng + (side - 0.5) * step
            let enforced = index % 3 != 2
            return NearbyZone(
                zoneId: "mock-zone-\(index)",
                city: point.lat > 41 ? "bos" : "nyc",
                providerZoneNumber: "8\(1230 + index)",
                street: ["BOYLSTON ST", "NEWBURY ST", "HANOVER ST"][index % 3],
                rateFirstHourUsd: 3.75,
                rateAdditionalHourUsd: 3.75,
                maxStayMinutes: 120,
                distanceM: Double(index) * 35 + 12,
                enforcedNow: enforced,
                todayHours: enforced
                    ? [NearbyZone.TodayInterval(start: "08:00", end: "20:00")]
                    : [NearbyZone.TodayInterval(start: "08:00", end: "12:00")],
                hours: [
                    EnforcementHours(
                        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
                        start: "08:00",
                        end: enforced ? "20:00" : "12:00"
                    )
                ],
                centerline: [[[lng, lat], [lng + step * 0.8, lat + step * 0.15]]]
            )
        }
        return NearbyZonesResponse(
            radiusM: radiusM,
            at: AppClock.now,
            truncated: false,
            zones: zones
        )
    }

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
            providerZoneNumber: zoneNumber,
            distanceM: distanceM,
            containsPoint: containsPoint,
            rateFirstHourUsd: firstHour,
            rateAdditionalHourUsd: additionalHour,
            maxStayMinutes: maxStayMinutes,
            hours: hours,
            quote: Quote(
                zoneId: "nyc-\(zoneNumber)",
                providerZoneNumber: zoneNumber,
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
        provider: ParkedProvider?,
        needsZoneNumber: Bool = false
    ) -> ParkedResponse {
        ParkedResponse(
            action: action,
            candidates: candidates,
            quote: quote,
            rule: rule,
            dryRun: true,
            provider: provider,
            needsZoneNumber: needsZoneNumber,
            parkedEventId: "mock-parked-\(UUID().uuidString.prefix(8))",
            decisionId: "mock-decision-\(UUID().uuidString.prefix(8))"
        )
    }

    private static func round2(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }
}
#endif
