// UI tests and SwiftUI previews only. The whole file is compiled out of
// Release builds (ParkAgentReleaseTests proves it): a TestFlight build has
// no mock server, no fixtures, and no scenario switches.
#if DEBUG
import Foundation

/// Which Wallet state the mock serves (UI tests: `-walletScenario <name>`).
/// Orthogonal to the park-flow scenarios (`-walletScenario`).
enum WalletMockScenario: String, Sendable {
    /// The default: the card on the provider account pays; Link is
    /// configured but not connected; the ParkAgent card is coming soon.
    case providerCard
    /// Link connected and active, one approval waiting.
    case linkActive
    /// The server has no Link credentials: "Link — coming soon".
    case linkNotConfigured
    /// The ParkAgent card active in sandbox: a saved Visa (Apple Pay), the
    /// virtual Mastercard on the account; reveal and freeze work.
    case parkagentSandbox
    /// Nothing linked, nothing spent, no activity.
    case empty

    static let defaultsKey = "walletScenario"


    static var current: WalletMockScenario {
        WalletMockScenario(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "")
            ?? .providerCard
    }
}

/// The mock server's wallet state for one app run: the active source,
/// saved cards, the virtual card's frozen flag. Link's connection lives in
/// MockAssistantStore (the assistant reads it too).
actor MockWalletStore {
    static let shared = MockWalletStore()

    private var source: PaymentSource?
    private var frozen = false
    private var funding: [FundingMethod]?
    private var cardExists: Bool?

    private var scenario: WalletMockScenario { WalletMockScenario.current }

    func activeSource() -> PaymentSource {
        if let source { return source }
        switch scenario {
        case .linkActive: return .linkWallet
        case .parkagentSandbox:
            // Active by default; `-paymentSource` starts it elsewhere with
            // the sandbox card still selectable (the Diagnostics toggle test).
            return UserDefaults.standard.string(forKey: PaymentSource.defaultsKey) != nil
                ? PaymentSource.stored : .parkagentCard
        default: return PaymentSource.stored
        }
    }

    func setSource(_ next: PaymentSource) {
        source = next
        UserDefaults.standard.set(next.rawValue, forKey: PaymentSource.defaultsKey)
        if next == .parkagentCard { cardExists = true }
    }

    func fundingMethods() -> [FundingMethod] {
        if let funding { return funding }
        return scenario == .parkagentSandbox ? [MockFixtures.savedVisa] : []
    }

    func addFunding(_ method: FundingMethod) -> FundingMethod {
        var methods = fundingMethods().map { var m = $0; m.isDefault = false; return m }
        methods.insert(method, at: 0)
        funding = methods
        return method
    }

    func hasParkAgentCard() -> Bool {
        cardExists ?? (scenario == .parkagentSandbox)
    }

    func isFrozen() -> Bool { frozen }

    /// Sessions paid through the mock this run, newest first — Activity
    /// lists them ahead of the fixtures, the way the server's ledger would.
    private var recorded: [ActivityItem] = []

    func recordStart(
        sessionId: String,
        zoneNumber: String,
        minutes: Int,
        totalUsd: Double,
        at: Date,
        lat: Double,
        lng: Double
    ) {
        var item = ActivityItem(id: "session:\(sessionId)", kind: "session", at: at, createdAt: at)
        item.sessionId = sessionId
        item.zoneNumber = zoneNumber
        item.durationMinutes = minutes
        item.totalUsd = totalUsd
        item.meterUsd = totalUsd
        item.feeUsd = 0
        item.status = "active"
        item.dryRun = true
        item.paymentSource = activeSource() == .parkagentCard ? "parkagent_card" : "provider_card"
        item.explanation = "Dry run — nothing was charged."
        item.startedAt = at
        item.lat = lat
        item.lng = lng
        item.receipt = ActivityReceipt(providerConfirmation: "dry-\(sessionId)", decisionId: nil, holds: [])
        item.timeline = [ActivityTimelineEntry(kind: "started", at: at, minutes: minutes, amountUsd: totalUsd, code: nil)]
        recorded.insert(item, at: 0)
    }

    func recordStop(sessionId: String, at: Date) {
        guard let index = recorded.firstIndex(where: { $0.sessionId == sessionId }) else { return }
        recorded[index].status = "stopped"
        recorded[index].stoppedAt = at
        recorded[index].timeline?.append(ActivityTimelineEntry(kind: "stopped", at: at, minutes: nil, amountUsd: nil, code: nil))
    }

    func recordedActivity() -> [ActivityItem] { recorded }

    func setFrozen(_ value: Bool) { frozen = value }
}

extension MockAPI {
    private var linkScenario: LinkMockScenario {
        LinkMockScenario(rawValue: UserDefaults.standard.string(forKey: LinkMockScenario.defaultsKey) ?? "")
            ?? .disconnected
    }

    private var sandboxSelectable: Bool {
        WalletMockScenario.current == .parkagentSandbox
    }

    func wallet() async throws -> WalletResponse {
        try await pause()
        let scenario = WalletMockScenario.current
        let store = MockWalletStore.shared
        let active = await store.activeSource()
        let issuingLive = UserDefaults.standard.bool(forKey: "issuingLive")
        let linkConfigured = scenario != .linkNotConfigured
        let storeConnected = await MockAssistantStore.shared.isLinkConnected(scenario: linkScenario)
        let linkConnected = linkConfigured && (scenario == .linkActive || storeConnected)
        let funding = await store.fundingMethods()
        let hasCard = await store.hasParkAgentCard()
        let frozen = await store.isFrozen()
        let parkagentSelectable = issuingLive || sandboxSelectable

        // Linked accounts follow the provider scenario (nothing linked yet
        // during onboarding's notLinked runs), and the registry's order —
        // ParkNYC first — so "whose card" is the user's city's, never the
        // list's first row by accident.
        let providerScenario = ProviderMockScenario(
            rawValue: UserDefaults.standard.string(forKey: ProviderMockScenario.defaultsKey) ?? ""
        ) ?? .linked
        let linkedProviders: [String] = scenario == .empty
            || providerScenario == .notLinked || providerScenario == .linkFails
            ? []
            : ["parknyc", "passport"]
        let card = hasCard
            ? ParkAgentCard(
                stripeCardId: "ic_mock_1",
                last4: "4444",
                brand: "Mastercard",
                status: frozen ? "inactive" : "active",
                expMonth: 8,
                expYear: 2030,
                cardholderName: "Thomas Bardhi"
            )
            : nil

        return WalletResponse(
            activeSource: active,
            dryRun: true,
            options: [
                WalletSourceOption(source: .providerCard, availability: "available", needs: nil, sandbox: false),
                !linkConfigured
                    ? WalletSourceOption(source: .linkWallet, availability: "coming_soon", needs: nil, sandbox: false)
                    : linkConnected
                        ? WalletSourceOption(source: .linkWallet, availability: "available", needs: nil, sandbox: false)
                        : WalletSourceOption(source: .linkWallet, availability: "connect", needs: "connect_link", sandbox: false),
                !parkagentSelectable
                    ? WalletSourceOption(source: .parkagentCard, availability: "coming_soon", needs: nil, sandbox: false)
                    : funding.isEmpty
                        ? WalletSourceOption(source: .parkagentCard, availability: "connect", needs: "add_card", sandbox: !issuingLive)
                        : WalletSourceOption(source: .parkagentCard, availability: "available", needs: nil, sandbox: !issuingLive),
            ],
            providerCard: ProviderCardSource(cards: linkedProviders.map { id in
                ProviderCardSource.Card(
                    provider: id,
                    displayName: id == "passport" ? "ParkBoston" : "ParkNYC",
                    city: id == "passport" ? "bos" : "nyc",
                    brand: "Visa",
                    last4: id == "passport" ? "1234" : "4242"
                )
            }),
            link: WalletLink(
                configured: linkConfigured,
                connected: linkConnected,
                paymentMethod: linkConnected ? LinkPaymentMethod(type: "card", brand: "Visa", last4: "1234") : nil,
                pendingApprovals: scenario == .linkActive
                    ? [LinkPendingApproval(
                        spendRequestId: "lsrq_mock_1",
                        amountUsd: 18.00,
                        merchantName: "SpotHero",
                        approvalUrl: "https://app.link.com/approve/lsrq_mock_1",
                        expiresAt: AppClock.now.addingTimeInterval(8 * 60)
                    )]
                    : [],
                manageUrl: "https://app.link.com",
                covers: "plans_and_garages"
            ),
            parkagentCard: WalletParkAgentCard(
                live: issuingLive,
                sandboxSelectable: sandboxSelectable,
                fundingMethods: funding,
                card: card
            ),
            providers: ["parknyc", "passport"].map { id in
                let linked = linkedProviders.contains(id)
                let paysWith: WalletProvider.PaysWith? = !linked
                    ? nil
                    : active == .parkagentCard
                        ? WalletProvider.PaysWith(source: .parkagentCard, brand: "Mastercard", last4: "4444")
                        : WalletProvider.PaysWith(
                            source: .providerCard,
                            brand: "Visa",
                            last4: id == "passport" ? "1234" : "4242"
                        )
                return WalletProvider(
                    id: id,
                    city: id == "passport" ? "bos" : "nyc",
                    cityDisplayName: id == "passport" ? "Boston" : "New York City",
                    displayName: id == "passport" ? "ParkBoston" : "ParkNYC",
                    status: linked ? "linked" : "unlinked",
                    paysWith: paysWith,
                    attention: linked ? nil : "connect"
                )
            },
            spending: WalletSpending(
                todayUsd: scenario == .empty ? 0 : 4.10,
                dailyCapUsd: 60,
                sessionCapUsd: 45,
                // Link active: yesterday's garage, approved in Link, is this
                // month's spend too, on its own line.
                monthUsd: scenario == .empty ? 0 : scenario == .linkActive ? 41.81 : 23.81,
                byCity: [
                    WalletSpending.CitySpend(city: "bos", cityDisplayName: "Boston", monthUsd: scenario == .empty ? 0 : 16.53),
                    WalletSpending.CitySpend(city: "nyc", cityDisplayName: "New York City", monthUsd: scenario == .empty ? 0 : 7.28),
                ],
                linkMonthUsd: scenario == .linkActive ? 18 : 0
            ),
            activity: ActivityPage(
                items: Array((await store.recordedActivity() + MockFixtures.activity(scenario: scenario)).prefix(5)),
                nextCursor: nil
            )
        )
    }

    func walletActivity(cursor: String?) async throws -> ActivityPage {
        try await pause()
        let recorded = await MockWalletStore.shared.recordedActivity()
        return ActivityPage(
            items: recorded + MockFixtures.activity(scenario: WalletMockScenario.current),
            nextCursor: nil
        )
    }

    func setWalletSource(_ source: PaymentSource, sandbox: Bool, consent: Bool) async throws -> WalletSourceResponse {
        try await pause()
        let scenario = WalletMockScenario.current
        switch source {
        case .linkWallet:
            if scenario == .linkNotConfigured { throw APIError.refused(code: "link_not_configured") }
            let storeConnected = await MockAssistantStore.shared.isLinkConnected(scenario: linkScenario)
            if !(scenario == .linkActive || storeConnected) {
                throw APIError.refused(code: "link_not_connected")
            }
        case .parkagentCard:
            let live = UserDefaults.standard.bool(forKey: "issuingLive")
            if !live && !(sandbox && sandboxSelectable) {
                throw APIError.refused(code: "parkagent_card_not_live")
            }
            if await MockWalletStore.shared.fundingMethods().isEmpty {
                throw APIError.refused(code: "no_funding_method")
            }
            let providerScenario = ProviderMockScenario(
                rawValue: UserDefaults.standard.string(forKey: ProviderMockScenario.defaultsKey) ?? ""
            ) ?? .linked
            let anyLinked = scenario != .empty && providerScenario != .notLinked && providerScenario != .linkFails
            if anyLinked && !consent && scenario != .parkagentSandbox {
                throw APIError.refused(code: "consent_required")
            }
        case .providerCard:
            break
        }
        await MockWalletStore.shared.setSource(source)
        return WalletSourceResponse(activeSource: source, setupJobs: [], decisionId: "mock-decision")
    }

    func walletSetupIntent(sandbox: Bool) async throws -> WalletSetupIntent {
        try await pause()
        // The mock never reaches Stripe: the sheet short-circuits on a
        // seti_mock_ secret (see StripeWallet).
        return WalletSetupIntent(
            setupIntentId: "seti_mock_1",
            clientSecret: "seti_mock_1_secret_mock",
            customerId: "cus_mock",
            merchantId: "merchant.com.thomasbardhi.parkagent"
        )
    }

    func addFundingMethod(setupIntentId: String) async throws -> FundingMethodResponse {
        try await pause()
        let method = await MockWalletStore.shared.addFunding(MockFixtures.savedVisa)
        return FundingMethodResponse(fundingMethod: method)
    }

    func setDefaultFundingMethod(id: String) async throws -> FundingMethodResponse {
        try await pause()
        return FundingMethodResponse(fundingMethod: MockFixtures.savedVisa)
    }

    func removeFundingMethod(id: String) async throws -> FundingMethodRemoveResponse {
        try await pause()
        throw APIError.refused(code: "funding_method_in_use")
    }

    func revealLinkCard(spendRequestId: String) async throws -> LinkCardDetails {
        try await pause()
        // Link's documented test card.
        return LinkCardDetails(
            spendRequestId: spendRequestId,
            brand: "visa",
            number: "4000009990001984",
            cvc: "100",
            expMonth: 6,
            expYear: 2029,
            validUntil: AppClock.now.addingTimeInterval(12 * 3600).formatted(.iso8601)
        )
    }
}

extension MockFixtures {
    static let savedVisa = FundingMethod(
        id: "fm_mock_1",
        brand: "Visa",
        last4: "4242",
        wallet: "apple_pay",
        expMonth: 12,
        expYear: 2031,
        isDefault: true
    )

    /// A few days of Activity for the scenario — sessions, a garage, a Link
    /// payment — shaped exactly like GET /wallet/activity rows.
    static func activity(scenario: WalletMockScenario) -> [ActivityItem] {
        if scenario == .empty { return [] }
        let now = AppClock.now
        let calendar = Calendar.current
        let earlier = now.addingTimeInterval(-50 * 60)
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now) ?? now
        let lastWeek = calendar.date(byAdding: .day, value: -3, to: now) ?? now

        let parkagent = scenario == .parkagentSandbox
        var paid = ActivityItem(
            id: "session:mock-s1",
            kind: "session",
            at: earlier,
            createdAt: earlier,
            sessionId: "mock-s1",
            city: "bos",
            cityDisplayName: "Boston",
            providerDisplayName: "ParkBoston",
            zoneNumber: "456",
            street: "BOYLSTON ST",
            durationMinutes: 60,
            meterUsd: 3.75,
            feeUsd: 0.35,
            totalUsd: 4.10,
            status: "stopped",
            dryRun: false,
            paymentSource: parkagent ? "parkagent_card" : "provider_card",
            explanation: parkagent
                ? "Paid with the ParkAgent card — $4.10 taken from your card, the rest of the hold released."
                : "Paid with your card on ParkBoston ••1234.",
            startedAt: earlier,
            expiresAt: earlier.addingTimeInterval(3600),
            stoppedAt: earlier.addingTimeInterval(45 * 60),
            lat: 42.3495,
            lng: -71.0798,
            receipt: ActivityReceipt(
                providerConfirmation: "PB-831908580",
                decisionId: "mock-decision-1",
                holds: parkagent
                    ? [HoldReceipt(leg: "start", heldUsd: 6.10, capturedUsd: 4.10, status: "captured", paymentIntentId: "pi_mock_1")]
                    : []
            ),
            timeline: []
        )
        // In time order, as the server sends it: hold, meter, capture, stop.
        paid.timeline = (parkagent
            ? [ActivityTimelineEntry(kind: "hold_placed", at: earlier, minutes: nil, amountUsd: 6.10, code: nil)]
            : [])
            + [ActivityTimelineEntry(kind: "started", at: earlier, minutes: 60, amountUsd: 4.10, code: nil)]
            + (parkagent
                ? [ActivityTimelineEntry(kind: "hold_captured", at: earlier.addingTimeInterval(60), minutes: nil, amountUsd: 4.10, code: nil)]
                : [])
            + [ActivityTimelineEntry(kind: "stopped", at: earlier.addingTimeInterval(45 * 60), minutes: nil, amountUsd: nil, code: nil)]

        let garage = ActivityItem(
            id: "garage:mock-g1",
            kind: "garage",
            at: yesterday,
            createdAt: yesterday,
            status: "handed_off",
            paymentSource: scenario == .linkActive ? "link_wallet" : "provider_card",
            label: "Deck on Clarendon",
            provider: "spothero",
            priceUsd: 18,
            startsAt: yesterday,
            endsAt: yesterday.addingTimeInterval(2 * 3600),
            deepLink: "https://spothero.com/checkout/135220",
            link: scenario == .linkActive
                ? ActivityLink(spendRequestId: "lsrq_mock_0", status: "approved", approvalUrl: nil)
                : nil,
            providerDisplayNameOverride: "SpotHero"
        )

        let declined = ActivityItem(
            id: "session:mock-s0",
            kind: "session",
            at: lastWeek,
            createdAt: lastWeek,
            sessionId: "mock-s0",
            city: "nyc",
            cityDisplayName: "New York City",
            providerDisplayName: "ParkNYC",
            zoneNumber: "417371",
            street: nil,
            durationMinutes: 90,
            meterUsd: 0,
            feeUsd: 0,
            totalUsd: 0,
            status: "failed",
            dryRun: false,
            paymentSource: "provider_card",
            explanation: "Couldn't pay at ParkNYC: the card saved there was declined — the meter was unpaid.",
            startedAt: nil,
            lat: 40.7659,
            lng: -73.9197,
            receipt: ActivityReceipt(providerConfirmation: nil, decisionId: "mock-decision-0", holds: []),
            timeline: [ActivityTimelineEntry(kind: "failed", at: lastWeek, minutes: 90, amountUsd: nil, code: "payment_declined")]
        )
        return [paid, garage, declined]
    }
}

extension ActivityItem {
    /// Fixture convenience: a garage row with its display name set.
    init(
        id: String,
        kind: String,
        at: Date,
        createdAt: Date,
        status: String?,
        paymentSource: String?,
        label: String,
        provider: String,
        priceUsd: Double,
        startsAt: Date?,
        endsAt: Date?,
        deepLink: String?,
        link: ActivityLink?,
        providerDisplayNameOverride: String
    ) {
        self.init(id: id, kind: kind, at: at, createdAt: createdAt)
        self.status = status
        self.paymentSource = paymentSource
        self.label = label
        self.provider = provider
        self.providerDisplayName = providerDisplayNameOverride
        self.priceUsd = priceUsd
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.deepLink = deepLink
        self.link = link
        self.bookingId = String(id.dropFirst("garage:".count))
    }
}
#endif
