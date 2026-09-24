import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
    @AppStorage(AppearanceSetting.defaultsKey) private var appearanceRaw = AppearanceSetting.system.rawValue
    /// Five taps on the version number reveal the Diagnostics link (DEBUG
    /// only). Not persisted: it re-hides on the next launch.
    @State private var versionTaps = 0
    @State private var diagnosticsUnlocked = false

    @State private var providerAccounts: [ProviderAccountStatus] = []
    /// nil until the first load answers, so the failure copy never flashes
    /// while the request is still in flight.
    @State private var providersLoadFailed: Bool?
    @State private var relinkProviderId: String?
    @State private var confirmingUnlink: ProviderAccountStatus?
    @State private var isConnectingLink = false
    @State private var paymentInfo: PaymentSourceResponse?
    @State private var isSwitchingPayment = false
    @State private var showIssuingComingSoon = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Appearance", selection: $appearanceRaw) {
                        ForEach(AppearanceSetting.allCases) { setting in
                            Text(setting.label).tag(setting.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("settings.appearancePicker")
                }

                citySection

                paymentSection

                linkedAccountsSection

                linkWalletSection

                policySection

                Section("Permissions") {
                    LabeledContent("Location", value: locationStatusText)
                    LabeledContent("Motion", value: motionStatusText)
                    if permissions.locationDenied || permissions.motionStatus == .denied {
                        Button("Open Settings") { openSystemSettings() }
                            .foregroundStyle(Color.actionCoralLink)
                    }
                }

                Section("About") {
                    versionRow
                }
            }
            .navigationTitle("Settings")
            .tint(.actionCoral)
            .refreshable {
                await model.loadPolicy()
                await loadProviders()
                paymentInfo = try? await model.api.paymentSource()
            }
            .task { await loadProviders() }
            .fullScreenCover(
                isPresented: Binding(
                    get: { relinkProviderId != nil },
                    set: { if !$0 { relinkProviderId = nil } }
                )
            ) {
                // The ?? "" is unreachable (the cover only presents with an
                // id); an empty id just lands on the flow's unavailable state.
                ProviderLinkFlowView(providerId: relinkProviderId ?? "") {
                    Task { await loadProviders() }
                }
            }
            .confirmationDialog(
                "Unlink \(confirmingUnlink?.displayName ?? "account")?",
                isPresented: Binding(
                    get: { confirmingUnlink != nil },
                    set: { if !$0 { confirmingUnlink = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Unlink", role: .destructive) {
                    if let account = confirmingUnlink {
                        Task { await unlink(account) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Meters there can't be paid until you link again. If no other account stays linked, your ParkAgent card is frozen — it unfreezes when you re-link.")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.view")
        }
    }

    // MARK: - About / hidden Diagnostics

    /// Five taps on the version number opens Diagnostics. Deliberately
    /// undiscoverable — nothing in the user-facing UI hints at it — and
    /// compiled out of Release builds entirely.
    @ViewBuilder
    private var versionRow: some View {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        LabeledContent("Version", value: "\(version) (\(build))")
            .contentShape(Rectangle())
            .onTapGesture { registerVersionTap() }
            .accessibilityIdentifier("settings.versionRow")

        #if DEBUG
        if diagnosticsUnlocked {
            NavigationLink("Diagnostics") { DiagnosticsView() }
                .accessibilityIdentifier("settings.diagnosticsLink")
        }
        #endif
    }

    private func registerVersionTap() {
        #if DEBUG
        versionTaps += 1
        if versionTaps >= 5 {
            versionTaps = 0
            withAnimation { diagnosticsUnlocked = true }
            Haptics.success()
        }
        #endif
    }

    // MARK: - City

    private var citySection: some View {
        Section {
            Picker("City", selection: Binding(
                get: { model.cityOverride },
                set: { model.cityOverride = $0 }
            )) {
                Text("Detect automatically").tag("auto")
                ForEach(CityCatalog.allByDisplayName, id: \.self) { city in
                    Text(CityCatalog.displayName(city) ?? city).tag(city)
                }
                Text("Somewhere else").tag("other")
            }
            .accessibilityIdentifier("settings.cityPicker")
        } header: {
            Text("City")
        } footer: {
            Text(model.cityDisplayName.map { "Paying \($0) meters." }
                ?? "No supported city detected — meters run in \(CityCatalog.supportedCitiesSentence) for now.")
        }
    }

    // MARK: - Payment source

    @ViewBuilder
    private var paymentSection: some View {
        Section {
            if let info = paymentInfo {
                paymentRow(
                    .providerCard,
                    label: "My card on \(providerShortName)",
                    current: info.paymentSource
                )
                if info.issuingLive {
                    paymentRow(.issuingCard, label: "ParkAgent card", current: info.paymentSource)
                } else {
                    HStack {
                        Text("ParkAgent card")
                            .font(.bodyText)
                            .foregroundStyle(Color.textSecondary)
                        Spacer()
                        TagPill(label: "Coming soon", color: .textSecondary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { showIssuingComingSoon = true }
                    .accessibilityIdentifier("settings.payment.comingSoon")
                }
            } else {
                HStack(spacing: Spacing.half) {
                    ProgressView()
                    Text("Checking payment source")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                }
            }
        } header: {
            Text("Payment")
        } footer: {
            Text("Which card pays the meter. Your per-stop and daily caps apply either way.")
        }
        .task {
            if paymentInfo == nil {
                paymentInfo = try? await model.api.paymentSource()
            }
        }
        .alert("Coming soon", isPresented: $showIssuingComingSoon) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("The ParkAgent card isn't available yet. Your \(providerShortName) card keeps paying.")
                .accessibilityIdentifier("settings.payment.comingSoonMessage")
        }
    }

    private func paymentRow(_ source: PaymentSource, label: String, current: PaymentSource) -> some View {
        Button {
            guard source != current, !isSwitchingPayment else { return }
            Task { await switchPayment(to: source) }
        } label: {
            HStack {
                Text(label)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                Spacer()
                if current == source {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.actionCoralLink)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings.payment.\(source.rawValue)")
        .accessibilityValue(current == source ? "selected" : "not selected")
    }

    private var providerShortName: String {
        CityCatalog.providerDisplayName(for: model.cityOverride == "auto" ? nil : model.cityOverride)
            ?? CityCatalog.providerDisplayName(for: providerAccounts.first(where: \.isLinked)?.city)
            ?? "your parking account"
    }

    private func switchPayment(to source: PaymentSource) async {
        isSwitchingPayment = true
        do {
            let saved = try await model.api.updatePaymentSource(source)
            paymentInfo = saved
            UserDefaults.standard.set(saved.paymentSource.rawValue, forKey: PaymentSource.defaultsKey)
        } catch APIError.refused(let code) where code == "issuing_not_live" {
            showIssuingComingSoon = true
        } catch {
            // Leave the current selection; pull-to-refresh retries the load.
        }
        isSwitchingPayment = false
    }

    // MARK: - Linked accounts

    @ViewBuilder
    private var linkedAccountsSection: some View {
        Section("Linked accounts") {
            if orderedAccounts.isEmpty {
                if providersLoadFailed == true {
                    Text("Couldn't load account status. Pull to retry.")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                } else {
                    HStack(spacing: Spacing.half) {
                        ProgressView()
                        Text("Checking accounts")
                            .font(.secondaryText)
                            .foregroundStyle(Color.textSecondary)
                    }
                }
            }
            ForEach(orderedAccounts) { account in
                HStack {
                    VStack(alignment: .leading, spacing: Spacing.quarter) {
                        Text(account.displayName)
                            .font(.bodyText)
                            .foregroundStyle(Color.textPrimary)
                        Text(account.cityDisplayName)
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                    }
                    // Identifier on the text column, not the row: on the
                    // row it propagates down and clobbers the action
                    // button's own identifier.
                    .accessibilityIdentifier("settings.provider.\(account.id)")
                    Spacer()
                    statusPill(account)
                    if account.isLinked {
                        Menu {
                            Button("Re-link") { relinkProviderId = account.id }
                            Button("Unlink", role: .destructive) { confirmingUnlink = account }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .foregroundStyle(Color.textSecondary)
                        }
                        .accessibilityIdentifier("settings.providerMenu.\(account.id)")
                        .accessibilityLabel("\(account.displayName) account actions")
                    } else {
                        Button(account.status == "expired" ? "Re-link" : "Link") {
                            relinkProviderId = account.id
                        }
                        .foregroundStyle(Color.actionCoralLink)
                        .accessibilityIdentifier("settings.providerLink.\(account.id)")
                    }
                }
            }
        }
    }

    private func statusPill(_ account: ProviderAccountStatus) -> some View {
        switch account.status {
        case "linked": TagPill(label: "Linked", color: .success)
        case "expired": TagPill(label: "Sign in again", color: .warningGold)
        default: TagPill(label: "Not linked", color: .textSecondary)
        }
    }

    /// The user's city's provider first, the rest alphabetically — the
    /// registry's own order carries no meaning for this user.
    private var orderedAccounts: [ProviderAccountStatus] {
        providerAccounts.sorted { a, b in
            let city = model.effectiveCity
            if (a.city == city) != (b.city == city) { return a.city == city }
            return a.displayName < b.displayName
        }
    }

    private func loadProviders() async {
        if let status = try? await model.api.providersStatus() {
            providerAccounts = status.providers
            providersLoadFailed = false
        } else {
            providersLoadFailed = true
        }
    }

    private func unlink(_ account: ProviderAccountStatus) async {
        _ = try? await model.api.unlinkProvider(account.id)
        await loadProviders()
    }

    @ViewBuilder
    private var linkWalletSection: some View {
        Section {
            if model.linkWalletConnected {
                LabeledContent("Link wallet", value: "Connected")
                Button("Disconnect", role: .destructive) {
                    Task {
                        try? await model.api.linkWalletDisconnect()
                        await model.refreshLinkWalletStatus()
                    }
                }
                .accessibilityIdentifier("settings.linkDisconnectButton")
            } else {
                Button(isConnectingLink ? "Connecting…" : "Connect Link wallet") {
                    Task {
                        isConnectingLink = true
                        if let response = try? await model.api.linkWalletConnect(),
                           let url = URL(string: response.url), !model.useMockAPI {
                            await UIApplication.shared.open(url)
                        }
                        await model.refreshLinkWalletStatus()
                        isConnectingLink = false
                    }
                }
                .disabled(isConnectingLink)
                .foregroundStyle(Color.actionCoralLink)
                .accessibilityIdentifier("settings.linkConnectButton")
            }
        } header: {
            Text("Link wallet")
        } footer: {
            Text("Pay assistant plans from your Stripe Link wallet: you approve each paid stop in Link. Automatic street parking stays on the ParkAgent card.")
        }
        .task { await model.refreshLinkWalletStatus() }
    }

    @ViewBuilder
    private var policySection: some View {
        Section {
            if let response = model.policyResponse {
                LabeledContent("Daily cap", value: Format.money(response.policy.dailyCapUsd))
                LabeledContent("Per-session cap", value: Format.money(response.policy.sessionCapUsd))
                LabeledContent("Auto-pay rate limit", value: "\(Format.money(response.policy.autoPayMaxRatePerHour))/hr")
                LabeledContent("Default stay", value: Format.minutes(response.policy.defaultStayMinutes))
                LabeledContent(
                    "Auto-extend",
                    value: response.policy.autoExtend.enabled
                        ? "Up to \(response.policy.autoExtend.maxCount)× \(Format.minutes(response.policy.autoExtend.maxMinutesEach))"
                        : "Off"
                )
                LabeledContent("Dry run", value: response.dryRun ? "On — no money moves" : "Off")
            } else if model.policyLoadFailed {
                VStack(alignment: .leading, spacing: Spacing.half) {
                    Text("Could not load the policy.")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                    Button("Try again") {
                        Task { await model.loadPolicy() }
                    }
                    .foregroundStyle(Color.actionCoralLink)
                }
            } else {
                HStack {
                    ProgressView()
                    Text("Loading policy")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                }
            }
        } header: {
            Text("Spending policy")
        } footer: {
            Text("Set in policy.json on the server. Every automated decision is checked against these limits first.")
        }
    }

    private var locationStatusText: String {
        if permissions.locationGranted { return "Allowed" }
        if permissions.locationDenied { return "Denied" }
        return "Not requested"
    }

    private var motionStatusText: String {
        guard permissions.motionAvailable else { return "Unavailable" }
        switch permissions.motionStatus {
        case .authorized: return "Allowed"
        case .denied, .restricted: return "Denied"
        default: return "Not requested"
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

#Preview {
    SettingsView()
        .environment(AppModel())
        .environment(PermissionsManager())
}
