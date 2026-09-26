import SwiftUI

/// The Wallet tab: one place that answers "how am I paying, and what have I
/// spent". Calm and finance-grade — the active way to pay as the hero, the
/// three choices beneath it, each parking account and what pays there,
/// spend against the caps, and the latest activity. Everything comes from
/// GET /wallet (no fixtures outside the mock). Coral marks what needs doing
/// (a Connect or Add card tag, a Reconnect) — plus the spend bar, which
/// keeps the app's usual coral as on Home.
struct WalletView: View {
    @Environment(AppModel.self) private var model
    #if DEBUG
    /// Diagnostics' sandbox toggle, observed so flipping it re-renders the
    /// rows at once (FeatureFlags reads the same key).
    @AppStorage(FeatureFlags.parkAgentSandboxKey) private var sandboxAllowed = false
    #else
    private let sandboxAllowed = FeatureFlags.parkAgentSandbox
    #endif
    @State private var changing: PaymentSource?
    @State private var relinkProviderId: String?

    private var wallet: WalletModel { model.wallet }

    var body: some View {
        NavigationStack {
            Group {
                if let response = wallet.response {
                    content(response)
                } else if wallet.loadFailed {
                    EmptyStateView(
                        icon: "wifi.exclamationmark",
                        title: "Couldn't load your wallet",
                        message: "Check the connection and pull to retry."
                    )
                    .accessibilityIdentifier("wallet.loadFailed")
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("wallet.loading")
                }
            }
            .tabScreen()
            .navigationTitle("Wallet")
            .navigationDestination(for: ActivityItem.self) { item in
                ActivityDetailView(item: item)
            }
            .refreshable { await wallet.load(api: model.api) }
        }
        .task { await wallet.load(api: model.api) }
        .sheet(item: $changing) { source in
            ChangePaymentSheet(source: source)
                .presentationDetents([.medium, .large])
        }
        .fullScreenCover(
            isPresented: Binding(
                get: { relinkProviderId != nil },
                set: { if !$0 { relinkProviderId = nil } }
            )
        ) {
            ProviderLinkFlowView(providerId: relinkProviderId ?? "") {
                Task { await wallet.load(api: model.api) }
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { wallet.actionError != nil && changing == nil },
                set: { if !$0 { wallet.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(wallet.actionError?.errorDescription ?? "")
        }
    }

    private func content(_ response: WalletResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.unitAndHalf) {
                if response.dryRun {
                    dryRunNote
                }
                section("How you pay") {
                    WalletHeroView(
                        response: response,
                        provider: providerName(response),
                        providerAccount: cityProvider(response),
                        onConnect: { relinkProviderId = $0 }
                    )
                }
                section("Change how you pay") {
                    VStack(spacing: 0) {
                        ForEach(response.options, id: \.source) { option in
                            sourceRow(option, response: response)
                            if option.source != response.options.last?.source {
                                Divider().padding(.leading, Spacing.unit)
                            }
                        }
                    }
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }
                section("Parking accounts") {
                    VStack(spacing: 0) {
                        ForEach(orderedProviders(response)) { provider in
                            providerRow(provider)
                            if provider.id != orderedProviders(response).last?.id {
                                Divider().padding(.leading, Spacing.unit)
                            }
                        }
                    }
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }
                section("Spending") {
                    spending(response.spending)
                }
                activitySection(response.activity)
            }
            .padding(Spacing.unit)
        }
    }

    // MARK: - Pieces

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            Text(title)
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textSecondary)
                .textCase(.uppercase)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private var dryRunNote: some View {
        HStack(spacing: Spacing.half) {
            Image(systemName: "testtube.2")
                .foregroundStyle(Color.warningGold)
            Text("Dry run — nothing is charged. Amounts show what would have been paid.")
                .font(.captionText)
                .foregroundStyle(Color.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(Spacing.unit)
        .background(Color.warningGold.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("wallet.dryRunNote")
    }

    private func sourceRow(_ option: WalletSourceOption, response: WalletResponse) -> some View {
        let active = option.source == response.activeSource
        let comingSoon = WalletCopy.isComingSoon(option, sandboxAllowed: sandboxAllowed)
        let provider = providerName(response)
        // "Your card on ParkBoston — Active" with ParkBoston not connected
        // was a contradiction: the card there can't pay until it is.
        let unconnected = option.source == .providerCard && !(cityProvider(response)?.isLinked ?? false)
        let state = active && unconnected
            ? "Connect"
            : WalletCopy.stateLabel(option, active: active, sandboxAllowed: sandboxAllowed)
        return Button {
            // The "Connect" tag means what it says.
            if active && unconnected, let account = cityProvider(response) {
                relinkProviderId = account.id
                return
            }
            guard !active, !comingSoon else { return }
            changing = option.source
        } label: {
            HStack(alignment: .top, spacing: Spacing.unit) {
                sourceIcon(option.source)
                VStack(alignment: .leading, spacing: Spacing.quarter) {
                    Text(comingSoonTitle(option, comingSoon: comingSoon, provider: provider))
                        .font(.bodyText)
                        .foregroundStyle(comingSoon ? Color.textSecondary : Color.textPrimary)
                    Text(comingSoon && option.source == .parkagentCard
                        ? WalletCopy.parkAgentComingSoon
                        : WalletCopy.explanation(option.source, provider: provider))
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: Spacing.quarter) {
                    TagPill(label: state, color: pillColor(state))
                    if option.sandbox && !comingSoon && !response.parkagentCard.live {
                        TagPill(label: "Sandbox", color: .textSecondary)
                    }
                }
                .accessibilityHidden(true)
            }
            .padding(Spacing.unit)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Only what can't be chosen is dimmed. The active row stays at full
        // contrast — the way you pay must not look switched off — and a tap
        // on it does nothing (the guard above) unless it says Connect.
        .disabled(comingSoon)
        .accessibilityIdentifier("wallet.sourceRow.\(option.source.rawValue)")
        // The state tag, exactly: Active / Available / Connect / Add card /
        // Coming soon.
        .accessibilityValue(state)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private func comingSoonTitle(_ option: WalletSourceOption, comingSoon: Bool, provider: String) -> String {
        guard comingSoon else { return WalletCopy.title(option.source, provider: provider) }
        // Link's own words; the ParkAgent card keeps its name and says
        // "Coming soon — pending approval" underneath.
        return option.source == .linkWallet
            ? WalletCopy.linkComingSoon
            : WalletCopy.title(option.source, provider: provider)
    }

    private func pillColor(_ state: String) -> Color {
        switch state {
        case "Active": .success
        case "Connect", "Add card": .actionCoralLink
        default: .textSecondary
        }
    }

    private func sourceIcon(_ source: PaymentSource) -> some View {
        let symbol = switch source {
        case .providerCard: "parkingsign.circle"
        case .linkWallet: "link.circle"
        case .parkagentCard: "creditcard.circle"
        }
        return Image(systemName: symbol)
            .font(.system(size: 26))
            .foregroundStyle(Color.textSecondary)
            .frame(width: 30)
            .accessibilityHidden(true)
    }

    private func providerRow(_ provider: WalletProvider) -> some View {
        HStack(spacing: Spacing.unit) {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(provider.displayName)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                Text(WalletCopy.paysWith(provider))
                    .font(.captionText)
                    // Gold only for something to fix; an account never
                    // connected is just "Not connected".
                    .foregroundStyle(
                        provider.attention == nil || provider.attention == "connect"
                            ? Color.textSecondary : Color.warningGold
                    )
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("wallet.provider.\(provider.id)")
            Spacer(minLength: 0)
            if let action = providerAction(provider) {
                Button(action) { relinkProviderId = provider.id }
                    .font(.secondaryText)
                    .foregroundStyle(Color.actionCoralLink)
                    .accessibilityIdentifier("wallet.providerAction.\(provider.id)")
            } else {
                TagPill(label: "Connected", color: .success)
            }
        }
        .padding(Spacing.unit)
    }

    private func providerAction(_ provider: WalletProvider) -> String? {
        switch provider.attention {
        case "connect": "Connect"
        case "reconnect", "add_parkagent_card": "Reconnect"
        default: nil
        }
    }

    private func spending(_ spending: WalletSpending) -> some View {
        let share = spending.dailyCapUsd > 0 ? spending.todayUsd / spending.dailyCapUsd : 0
        return VStack(alignment: .leading, spacing: Spacing.half) {
            HStack(alignment: .firstTextBaseline) {
                Text("Today")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
                Spacer()
                Text("\(Format.money(spending.todayUsd)) of \(Format.money(spending.dailyCapUsd))")
                    .font(.captionTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
                    .accessibilityIdentifier("wallet.spendToday")
            }
            ProgressBar(value: share, tint: share >= 1 ? .danger : share > 0.8 ? .warningGold : .actionCoral)
            Text("Up to \(Format.money(spending.sessionCapUsd)) per stop, whatever pays.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            Divider()
            HStack {
                Text("This month")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
                Spacer()
                Text(Format.money(spending.monthUsd))
                    .font(.bodyTextSemibold)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
                    .accessibilityIdentifier("wallet.spendMonth")
            }
            ForEach(spending.byCity) { city in
                HStack {
                    Text(city.cityDisplayName)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                    Spacer()
                    Text(Format.money(city.monthUsd))
                        .font(.captionTextSemibold)
                        .monospacedDigit()
                        .foregroundStyle(Color.textPrimary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("wallet.cityspend.\(city.city)")
            }
            // Garages have no meter city; their own line keeps the month
            // adding up.
            if let linkUsd = spending.linkMonthUsd, linkUsd > 0 {
                HStack {
                    Text("Garages with Link")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                    Spacer()
                    Text(Format.money(linkUsd))
                        .font(.captionTextSemibold)
                        .monospacedDigit()
                        .foregroundStyle(Color.textPrimary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("wallet.linkspend")
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    private func activitySection(_ page: ActivityPage) -> some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack {
                Text("Activity")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
                    .textCase(.uppercase)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if !page.items.isEmpty {
                    Button("See all") { model.selectedTab = .activity }
                        .font(.secondaryText)
                        .foregroundStyle(Color.actionCoralLink)
                        .accessibilityIdentifier("wallet.seeAllActivity")
                }
            }
            if page.items.isEmpty {
                Text("Payments show up here as they happen.")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
                    .padding(Spacing.unit)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardStyle()
                    .accessibilityIdentifier("wallet.activityEmpty")
            } else {
                VStack(spacing: 0) {
                    ForEach(page.items) { item in
                        NavigationLink(value: item) {
                            ActivityRow(item: item)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("wallet.activityRow.\(item.id)")
                        if item.id != page.items.last?.id {
                            Divider().padding(.leading, Spacing.unit)
                        }
                    }
                }
                .background(Color.surface)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            }
        }
    }

    // MARK: - Helpers

    /// The parking account the hero's "Your card on …" means: the city's,
    /// else the first linked one.
    private func cityProvider(_ response: WalletResponse) -> WalletProvider? {
        let city = model.effectiveCity
        return response.providers.first(where: { $0.city == city })
            ?? response.providers.first(where: \.isLinked)
    }

    /// Whose card "Your card on …" means: the user's city's provider first
    /// (detected or chosen), else the first connected one.
    private func providerName(_ response: WalletResponse) -> String {
        let city = model.effectiveCity
        return response.providers.first(where: { $0.city == city })?.displayName
            ?? response.providers.first(where: \.isLinked)?.displayName
            ?? CityCatalog.providerDisplayName(for: city)
            ?? "your parking account"
    }

    /// The user's city's account first, the rest alphabetically.
    private func orderedProviders(_ response: WalletResponse) -> [WalletProvider] {
        let city = model.effectiveCity
        return response.providers.sorted { a, b in
            if (a.city == city) != (b.city == city) { return a.city == city }
            return a.displayName < b.displayName
        }
    }
}

extension PaymentSource: Identifiable {
    var id: String { rawValue }
}

/// One tile in the ParkAgent card's row of actions: icon over a short label.
struct CardActionButton: View {
    let icon: String
    let label: String
    var tint: Color = .textPrimary
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Spacing.half) {
                Image(systemName: icon)
                    .font(.system(size: 22))
                Text(label)
                    .font(.captionTextSemibold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.pressable)
        .accessibilityIdentifier(identifier)
    }
}

#if DEBUG
#Preview {
    WalletView()
        .environment(AppModel())
}
#endif
