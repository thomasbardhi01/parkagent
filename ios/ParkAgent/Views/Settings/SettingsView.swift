import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
    @AppStorage(MockScenario.defaultsKey) private var mockScenario = MockScenario.singleQuote.rawValue
    @AppStorage(CardMockScenario.defaultsKey) private var cardScenario = CardMockScenario.ready.rawValue
    @AppStorage(ProviderMockScenario.defaultsKey) private var providerScenario = ProviderMockScenario.linked.rawValue
    @AppStorage(CityMockScenario.defaultsKey) private var cityScenarioRaw = CityMockScenario.nyc.rawValue
    @AppStorage(AppearanceSetting.defaultsKey) private var appearanceRaw = AppearanceSetting.system.rawValue

    @State private var providerAccounts: [ProviderAccountStatus] = []
    @State private var relinkProviderId: String?
    @State private var confirmingUnlink: ProviderAccountStatus?

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

                linkedAccountsSection

                policySection

                Section("Permissions") {
                    LabeledContent("Location", value: locationStatusText)
                    LabeledContent("Motion", value: motionStatusText)
                    if permissions.locationDenied || permissions.motionStatus == .denied {
                        Button("Open Settings") { openSystemSettings() }
                            .foregroundStyle(Color.actionCoralLink)
                    }
                }

                #if DEBUG
                Section {
                    Toggle("Use mock API", isOn: $model.useMockAPI)
                        .accessibilityIdentifier("settings.mockToggle")
                    if model.useMockAPI {
                        Picker("Mock scenario", selection: $mockScenario) {
                            ForEach(MockScenario.allCases) { scenario in
                                Text(scenario.label).tag(scenario.rawValue)
                            }
                        }
                        .accessibilityIdentifier("settings.scenarioPicker")
                        Picker("Card scenario", selection: $cardScenario) {
                            ForEach(CardMockScenario.allCases) { scenario in
                                Text(scenario.label).tag(scenario.rawValue)
                            }
                        }
                        .accessibilityIdentifier("settings.cardScenarioPicker")
                        Picker("Provider scenario", selection: $providerScenario) {
                            ForEach(ProviderMockScenario.allCases) { scenario in
                                Text(scenario.label).tag(scenario.rawValue)
                            }
                        }
                        .accessibilityIdentifier("settings.providerScenarioPicker")
                        Picker("City scenario", selection: $cityScenarioRaw) {
                            ForEach(CityMockScenario.allCases) { scenario in
                                Text(scenario.label).tag(scenario.rawValue)
                            }
                        }
                        .accessibilityIdentifier("settings.cityScenarioPicker")
                    }
                    if model.liveAPIUnavailable {
                        Text("Live API is not configured — add API_BASE_URL and API_KEY to Config.xcconfig. Using the mock instead.")
                            .font(.captionText)
                            .foregroundStyle(Color.warningGold)
                    }
                    LabeledContent("API base", value: AppConfig.apiBaseURL?.absoluteString ?? "not set")
                    NavigationLink("Debug menu") { DebugMenuView() }
                        .accessibilityIdentifier("settings.debugMenuLink")
                } header: {
                    Text("Developer")
                } footer: {
                    Text("Debug builds only. Scenario applies to the next simulated park.")
                }
                #endif

                Section("About") {
                    LabeledContent(
                        "Version",
                        value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
                    )
                }
            }
            .navigationTitle("Settings")
            .tint(.actionCoral)
            .refreshable {
                await model.loadPolicy()
                await loadProviders()
            }
            .task { await loadProviders() }
            .fullScreenCover(
                isPresented: Binding(
                    get: { relinkProviderId != nil },
                    set: { if !$0 { relinkProviderId = nil } }
                )
            ) {
                ProviderLinkFlowView(providerId: relinkProviderId ?? "parknyc") {
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

    // MARK: - City

    private var citySection: some View {
        Section {
            Picker("City", selection: Binding(
                get: { model.cityOverride },
                set: { model.cityOverride = $0 }
            )) {
                Text("Detect automatically").tag("auto")
                Text("New York City").tag("nyc")
                Text("Boston").tag("bos")
                Text("Somewhere else").tag("other")
            }
            .accessibilityIdentifier("settings.cityPicker")
        } header: {
            Text("City")
        } footer: {
            Text(model.cityDisplayName.map { "Paying \($0) meters." }
                ?? "No supported city detected — meters run in New York City and Boston for now.")
        }
    }

    // MARK: - Linked accounts

    @ViewBuilder
    private var linkedAccountsSection: some View {
        Section("Linked accounts") {
            if providerAccounts.isEmpty {
                Text("Couldn't load account status. Pull to retry.")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
            }
            ForEach(providerAccounts) { account in
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

    private func loadProviders() async {
        if let status = try? await model.api.providersStatus() {
            providerAccounts = status.providers
        }
    }

    private func unlink(_ account: ProviderAccountStatus) async {
        _ = try? await model.api.unlinkProvider(account.id)
        await loadProviders()
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
