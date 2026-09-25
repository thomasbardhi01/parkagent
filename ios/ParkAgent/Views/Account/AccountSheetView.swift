import SwiftUI

/// Everything that used to be the Settings tab, plus the account itself,
/// presented from Home's avatar button. Sections in the order someone
/// actually reaches for them: who you are, your cars, the cities you park
/// in, what you're allowed to spend, then the quieter settings, and the
/// two destructive actions last.
struct AccountSheetView: View {
    @Environment(AppModel.self) private var model
    @Environment(AuthModel.self) private var auth
    @Environment(PermissionsManager.self) private var permissions
    @Environment(\.dismiss) private var dismiss

    @AppStorage(AppearanceSetting.defaultsKey) private var appearanceRaw = AppearanceSetting.system.rawValue
    #if DEBUG
    /// Five taps on the version number reveal the Diagnostics link. Not
    /// persisted: it re-hides on the next launch, and neither property
    /// exists in a Release build.
    @State private var versionTaps = 0
    @State private var diagnosticsUnlocked = false
    #endif

    @State private var providerAccounts: [ProviderAccountStatus] = []
    /// nil until the first load answers, so the failure copy never flashes
    /// while the request is still in flight.
    @State private var providersLoadFailed: Bool?
    @State private var relinkProviderId: String?
    @State private var confirmingUnlink: ProviderAccountStatus?
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                profileSection
                vehiclesSection
                citiesSection
                limitsSection
                notificationsSection
                appearanceSection
                privacySection
                helpSection
                dangerSection
                aboutSection
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .tint(.actionCoral)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("account.doneButton")
                }
            }
            .refreshable { await reload() }
            .task { await reload() }
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
                "Disconnect \(confirmingUnlink?.displayName ?? "account")?",
                isPresented: Binding(
                    get: { confirmingUnlink != nil },
                    set: { if !$0 { confirmingUnlink = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    if let account = confirmingUnlink {
                        Task { await unlink(account) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(unlinkMessage)
            }
            .confirmationDialog(
                "Sign out?",
                isPresented: $confirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign out", role: .destructive) {
                    Task {
                        await auth.signOut()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Park detection stops until you sign in again. Your parking accounts stay connected.")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("account.view")
        }
    }

    // MARK: - Profile

    private var profileSection: some View {
        Section {
            NavigationLink {
                ProfileEditView()
            } label: {
                HStack(spacing: Spacing.unit) {
                    AccountAvatar(name: auth.user?.name ?? "", size: 44)
                    VStack(alignment: .leading, spacing: Spacing.quarter) {
                        Text(auth.user?.name.isEmpty == false ? auth.user!.name : "Your name")
                            .font(.bodyTextSemibold)
                            .foregroundStyle(Color.textPrimary)
                        Text(auth.user?.email ?? "No email")
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                    }
                    // Combine, not contain: the identifier on a plain
                    // container lands on its first child (here the avatar's
                    // initials), and the row would read "TB".
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("account.profileRow")
                }
            }
            .accessibilityIdentifier("account.profileLink")
        }
    }

    // MARK: - Vehicles

    private var vehiclesSection: some View {
        Section {
            NavigationLink("Vehicles") { VehiclesView() }
                .accessibilityIdentifier("account.vehiclesLink")
        } header: {
            Text("Cars")
        } footer: {
            Text("Meters are paid against a plate.")
        }
    }

    // MARK: - Cities & linked accounts

    @ViewBuilder
    private var citiesSection: some View {
        Section {
            Picker("City", selection: Binding(
                get: { model.cityOverride },
                set: { model.cityOverride = $0 }
            )) {
                Text("Detect automatically").tag("auto")
                // From the catalog, alphabetical — there is no home city.
                ForEach(CityCatalog.allByDisplayName, id: \.self) { city in
                    Text(CityCatalog.displayName(city) ?? city).tag(city)
                }
                Text("Somewhere else").tag("other")
            }
            .accessibilityIdentifier("account.cityPicker")

            if orderedAccounts.isEmpty {
                if providersLoadFailed == true {
                    Text("Couldn't load account status. Pull to retry.")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                        .accessibilityIdentifier("account.providersFailed")
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
                providerRow(account)
            }
        } header: {
            Text("Cities & accounts")
        } footer: {
            Text(model.cityDisplayName.map { "Paying \($0) meters." }
                ?? "Meters run in \(CityCatalog.supportedCitiesSentence) for now.")
        }
    }

    private func providerRow(_ account: ProviderAccountStatus) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(account.displayName)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                Text(providerDetail(account))
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            // Identifier on the text column, not the row: on the row it
            // propagates down and clobbers the action button's own.
            // Combined so the label carries the masked card too, not just
            // the provider name.
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("account.provider.\(account.id)")
            Spacer()
            statusPill(account)
            if account.isLinked && !account.needsReconnect {
                Menu {
                    Button("Reconnect") { relinkProviderId = account.id }
                    Button("Disconnect", role: .destructive) { confirmingUnlink = account }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .foregroundStyle(Color.textSecondary)
                }
                .accessibilityIdentifier("account.providerMenu.\(account.id)")
                .accessibilityLabel("\(account.displayName) account actions")
            } else {
                Button(account.status == "unlinked" ? "Connect" : "Reconnect") {
                    relinkProviderId = account.id
                }
                .foregroundStyle(Color.actionCoralLink)
                .accessibilityIdentifier("account.providerLink.\(account.id)")
            }
        }
    }

    /// The masked card is the useful detail once connected — it answers
    /// "which card is this actually charging?".
    private func providerDetail(_ account: ProviderAccountStatus) -> String {
        if account.status == "expired" { return "Sign in again to keep paying" }
        if account.status == "expiring" { return "Session expiring — reconnect soon" }
        if account.isLinked { return account.maskedCard ?? account.cityDisplayName }
        return account.cityDisplayName
    }

    private func statusPill(_ account: ProviderAccountStatus) -> some View {
        switch account.status {
        case "linked": TagPill(label: "Connected", color: .success)
        case "expiring": TagPill(label: "Reconnect soon", color: .warningGold)
        case "expired": TagPill(label: "Sign in again", color: .warningGold)
        default: TagPill(label: "Not connected", color: .textSecondary)
        }
    }

    // MARK: - Limits & how you pay

    @ViewBuilder
    private var limitsSection: some View {
        Section {
            NavigationLink("Spending limits") { SpendingLimitsView() }
                .accessibilityIdentifier("account.limitsLink")

            // The Wallet's own answer — the same GET /wallet the Wallet tab
            // and onboarding read, so the three can never disagree. Changing
            // it happens in the Wallet.
            Button {
                model.selectedTab = .wallet
                dismiss()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: Spacing.quarter) {
                        Text("How you pay")
                            .font(.bodyText)
                            .foregroundStyle(Color.textPrimary)
                        Text(paymentSummary)
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("account.howYouPay")
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("account.howYouPayRow")
        } header: {
            Text("Spending")
        } footer: {
            Text("Your caps apply whatever pays. Change how you pay in Wallet.")
        }
    }

    /// "Your card on ParkBoston ••1234", "Link · Visa ••1234", "ParkAgent card".
    private var paymentSummary: String {
        guard let response = model.wallet.response else { return "Loading…" }
        switch response.activeSource {
        case .providerCard:
            let title = WalletCopy.title(.providerCard, provider: providerShortName)
            let card = response.providerCard.cards.first { $0.displayName == providerShortName }
                ?? response.providerCard.cards.first
            return [title, card.flatMap { WalletCopy.masked(brand: $0.brand, last4: $0.last4) }]
                .compactMap { $0 }
                .joined(separator: " ")
        case .linkWallet:
            return WalletCopy.linkLine(response.link.paymentMethod)
        case .parkagentCard:
            return response.parkagentCard.card.map { "ParkAgent card ••\($0.last4)" } ?? "ParkAgent card"
        }
    }

    private var unlinkMessage: String {
        model.wallet.activeSource == .parkagentCard
            ? "Meters there can't be paid until you connect again. If no other account stays connected, your ParkAgent card is frozen — it unfreezes when you reconnect."
            : "Meters there can't be paid until you connect again."
    }

    /// Whose card pays here. The user's effective city first — including a
    /// DETECTED one, so a Boston user with the picker on "Detect
    /// automatically" is never told their card is on another city's
    /// provider. The linked-account fallback reads the city-ordered list,
    /// not the registry's own order, for the same reason.
    private var providerShortName: String {
        CityCatalog.providerDisplayName(for: model.effectiveCity)
            ?? CityCatalog.providerDisplayName(for: orderedAccounts.first(where: \.isLinked)?.city)
            ?? "your parking account"
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

    // MARK: - Notifications, appearance, privacy, help

    private var notificationsSection: some View {
        Section {
            LabeledContent("Push notifications", value: permissions.notificationsGranted ? "On" : "Off")
                .accessibilityIdentifier("account.notificationsStatus")
            if !permissions.notificationsGranted {
                Button("Turn on") { permissions.requestNotifications() }
                    .foregroundStyle(Color.actionCoralLink)
                    .accessibilityIdentifier("account.notificationsEnable")
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("Tells you when a meter was paid, is running out, or an account needs reconnecting.")
        }
    }

    private var appearanceSection: some View {
        Section("Appearance") {
            Picker("Appearance", selection: $appearanceRaw) {
                ForEach(AppearanceSetting.allCases) { setting in
                    Text(setting.label).tag(setting.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("account.appearancePicker")
        }
    }

    private var privacySection: some View {
        Section {
            LabeledContent("Location", value: locationStatusText)
                .accessibilityIdentifier("account.privacy.location")
            LabeledContent("Motion", value: motionStatusText)
                .accessibilityIdentifier("account.privacy.motion")
            if needsPermissionFix {
                Button("Fix in Settings") { openSystemSettings() }
                    .foregroundStyle(Color.actionCoralLink)
                    .accessibilityIdentifier("account.privacyFixButton")
            }
        } header: {
            Text("Privacy")
        } footer: {
            Text("Detection needs Location — Always and Motion. Your plate and location never leave your account.")
        }
    }

    private var helpSection: some View {
        Section("Help") {
            NavigationLink("How ParkAgent works") { HelpView() }
                .accessibilityIdentifier("account.helpLink")
        }
    }

    // MARK: - Sign out & delete

    private var dangerSection: some View {
        Section {
            Button("Sign out") { confirmingSignOut = true }
                .foregroundStyle(Color.actionCoralLink)
                .accessibilityIdentifier("account.signOutButton")
            NavigationLink {
                DeleteAccountView()
            } label: {
                Text("Delete account")
                    .foregroundStyle(Color.danger)
            }
            .accessibilityIdentifier("account.deleteAccountLink")
        }
    }

    // MARK: - About / hidden Diagnostics

    /// Last, under the destructive actions: nothing here is something a
    /// driver reaches for. Five taps on the version number opens
    /// Diagnostics — deliberately undiscoverable, and compiled out of
    /// Release builds entirely.
    private var aboutSection: some View {
        Section("About") {
            versionRow
        }
    }

    @ViewBuilder
    private var versionRow: some View {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        LabeledContent("Version", value: "\(version) (\(build))")
            .contentShape(Rectangle())
            .onTapGesture { registerVersionTap() }
            .accessibilityIdentifier("account.versionRow")

        #if DEBUG
        if diagnosticsUnlocked {
            NavigationLink("Diagnostics") { DiagnosticsView() }
                .accessibilityIdentifier("account.diagnosticsLink")
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

    // MARK: - Data

    private func reload() async {
        await model.loadPolicy()
        await loadProviders()
        await model.wallet.load(api: model.api)
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

    private var needsPermissionFix: Bool {
        permissions.locationDenied || permissions.motionStatus == .denied
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// Initials in a coral circle — the Home button and the sheet header.
struct AccountAvatar: View {
    let name: String
    var size: CGFloat = 32

    var body: some View {
        Circle()
            .fill(Color.actionCoral.opacity(0.18))
            .frame(width: size, height: size)
            .overlay {
                Text(initials)
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Color.actionCoral)
            }
            .accessibilityHidden(true)
    }

    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }.joined()
        return letters.isEmpty ? "?" : letters.uppercased()
    }
}

#Preview {
    AccountSheetView()
        .environment(AppModel())
        .environment(AuthModel(api: MockAPI(), store: AuthStore()))
        .environment(PermissionsManager())
}
