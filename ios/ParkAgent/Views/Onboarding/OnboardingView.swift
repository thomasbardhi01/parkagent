import SwiftUI

/// Onboarding runs AFTER sign-in (the welcome screen owns the sign-in
/// itself), so the steps are only setup: permissions → vehicle → your city
/// → how you pay → connect the provider → budget → done. One coral action
/// per screen; abandoning mid-way resumes at the last incomplete step on
/// next launch.
///
/// `welcome` is kept as the raw value 0 so a resume key written by an
/// older build still decodes; the flow treats it as permissions.
enum OnboardingStep: Int, CaseIterable {
    case welcome
    case permissions
    case vehicle
    case city
    /// "Somewhere else" — we're not there yet; finishes without a provider.
    case elsewhere
    /// "How do you want to pay": the Wallet's three choices, the card on
    /// the provider account preselected.
    case payment
    case linkProvider
    /// Retired (there is no stored balance to fund any more); kept so a
    /// resume key written by an older build still decodes — it goes on to
    /// the budget step.
    case addMoney
    case budget
    case done

    static let defaultsKey = "onboardingStep"
}

struct OnboardingView: View {
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    /// The effective city chosen in step 4 ("nyc" | "bos" | "other").
    @AppStorage("selectedCity") private var selectedCity = ""
    @State private var step: OnboardingStep
    /// Tells RootView the flow is finished. A callback, not the flag: a
    /// returning user sent back through the flow already has
    /// `hasOnboarded` set, so setting it again changes nothing anyone can
    /// observe — they were left on the Done screen.
    private let onComplete: () -> Void

    /// RootView's truth gate decides where the flow starts (the first
    /// missing step); with no explicit start, resume from the persisted
    /// step of an abandoned run.
    init(startAt: OnboardingStep? = nil, onComplete: @escaping () -> Void = {}) {
        let saved = UserDefaults.standard.integer(forKey: OnboardingStep.defaultsKey)
        let start = startAt ?? OnboardingStep(rawValue: saved) ?? .permissions
        _step = State(initialValue: start == .welcome ? .permissions : start)
        self.onComplete = onComplete
    }

    var body: some View {
        // No accessibility container here: the switch renders each step
        // directly, so a container modifier on this node would stack on the
        // step's own and overwrite its identifier. Each step declares its
        // own "onboarding.<step>" container instead.
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.appBackground)
            .onChange(of: step) { _, next in
                UserDefaults.standard.set(next.rawValue, forKey: OnboardingStep.defaultsKey)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .welcome, .permissions:
            // Signing in IS the welcome now; the flow opens on permissions.
            OnboardingPermissionsStep { advance(to: .vehicle) }
        case .vehicle:
            OnboardingVehicleStep { advance(to: .city) }
        case .city:
            OnboardingCityStep { city in
                selectedCity = city
                advance(to: city == "other" ? .elsewhere : .payment)
            }
        case .elsewhere:
            OnboardingElsewhereStep { complete() }
        case .payment:
            OnboardingPaymentStep(selectedCity: selectedCity) { advance(to: .linkProvider) }
        case .linkProvider:
            if let providerId = CityCatalog.providerId(for: selectedCity) {
                OnboardingLinkStep(
                    providerId: providerId,
                    onDone: { advance(to: .budget) },
                    onSkip: { advance(to: .budget) }
                )
                .id(providerId)
            } else {
                // Resume landed here without a stored city — re-ask.
                OnboardingCityStep { city in
                    selectedCity = city
                    advance(to: city == "other" ? .elsewhere : .payment)
                }
            }
        case .addMoney, .budget:
            OnboardingBudgetStep { advance(to: .done) }
        case .done:
            OnboardingDoneStep { complete() }
        }
    }

    private func advance(to next: OnboardingStep) {
        withAnimation { step = next }
    }

    private func complete() {
        UserDefaults.standard.removeObject(forKey: OnboardingStep.defaultsKey)
        hasOnboarded = true
        onComplete()
    }
}

// MARK: - Step 1: Permissions

/// Location (While Using, then straight away the Always upgrade), Motion,
/// and Notifications, each row saying exactly where it stands. There is
/// no skipping past silently: Continue with anything missing shows what
/// won't work first, and only "Continue anyway" there moves on.
private struct OnboardingPermissionsStep: View {
    @Environment(PermissionsManager.self) private var permissions
    let onContinue: () -> Void

    private enum Phase {
        case rows
        /// Always was declined, or iOS didn't show its prompt.
        case alwaysExplainer
        /// Continue was tapped with something missing.
        case limitedSummary
    }

    @State private var phase: Phase = .rows

    var body: some View {
        switch phase {
        case .rows:
            rows
        case .alwaysExplainer:
            AlwaysLocationExplainer(onDone: { withAnimation { phase = .rows } })
        case .limitedSummary:
            limitedSummary
        }
    }

    private var capabilities: DetectionCapabilities { permissions.capabilities }

    private var rows: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Three permissions")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)

            permissionRow(
                icon: "location.fill",
                title: "Location — Always",
                reason: capabilities.locationUsable && !capabilities.preciseLocation
                    ? "Precise Location is off, so ParkAgent can't tell which block you parked on."
                    : "Notices where you parked, even with the app closed.",
                state: locationState,
                satisfied: capabilities.detectionLevel == .full && capabilities.preciseLocation,
                identifier: "onboarding.permission.location",
                action: locationAction
            )
            permissionRow(
                icon: "figure.walk.motion",
                title: "Motion",
                reason: "Tells driving from walking, so parks are real.",
                state: capabilities.value(of: .motion),
                satisfied: capabilities.isSatisfied(.motion),
                identifier: "onboarding.permission.motion",
                action: rowAction(.motion)
            )
            permissionRow(
                icon: "bell.fill",
                title: "Notifications",
                reason: "Tells you a park was noticed, a meter was paid, or time is running out.",
                state: capabilities.value(of: .notifications),
                satisfied: capabilities.isSatisfied(.notifications),
                identifier: "onboarding.permission.notifications",
                action: rowAction(.notifications)
            )

            Text(DetectionCopy.levelSentence(capabilities.detectionLevel))
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("onboarding.permissionsNote")
            Spacer()
            Button(capabilities.fullyGranted ? "Continue" : "Continue with limited detection") {
                if capabilities.fullyGranted {
                    onContinue()
                } else {
                    withAnimation { phase = .limitedSummary }
                }
            }
            .buttonStyle(.primary)
            .accessibilityIdentifier("onboarding.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.permissions")
    }

    /// iOS Settings' word for it, plus Precise when that's the problem.
    private var locationState: String {
        let value = capabilities.value(of: .location)
        guard capabilities.locationUsable, !capabilities.preciseLocation else { return value }
        return "\(value), not precise"
    }

    /// The location row's button: ask for While Using (and then Always)
    /// while iOS will; after that the explainer, which leads to Settings.
    private var locationAction: (title: String, run: () -> Void)? {
        guard capabilities.locationServicesEnabled else { return ("Open Settings", { open(.openAppSettings) }) }
        switch capabilities.location {
        case .notDetermined:
            return ("Enable", requestLocation)
        case .whileUsing:
            if permissions.alwaysUpgradeAvailable { return ("Allow Always", requestLocation) }
            return ("Allow Always", showAlwaysExplainer)
        case .always:
            if capabilities.preciseLocation { return nil }
            return ("Turn on", { open(.openAppSettings) })
        case .denied:
            return ("Open Settings", { open(.openAppSettings) })
        case .restricted:
            return nil
        }
    }

    private func rowAction(_ row: CapabilityRow) -> (title: String, run: () -> Void)? {
        guard !capabilities.isSatisfied(row) else { return nil }
        let action = capabilities.action(for: row, alwaysUpgradeAvailable: permissions.alwaysUpgradeAvailable)
        switch action {
        case .none: return nil
        case .requestMotion, .requestNotifications: return ("Enable", { open(action) })
        default: return ("Open Settings", { open(action) })
        }
    }

    private func showAlwaysExplainer() {
        withAnimation { phase = .alwaysExplainer }
    }

    private func requestLocation() {
        Task {
            let outcome = await permissions.requestLocation()
            // Kept While Using, or iOS didn't show the upgrade: the only
            // road to Always is Settings, so explain it right here.
            if outcome == .declined || outcome == .notShown {
                withAnimation { phase = .alwaysExplainer }
            }
        }
    }

    private func open(_ action: CapabilityAction) {
        Task { await permissions.perform(action) }
    }

    private var limitedSummary: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("What won't work")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text(DetectionCopy.levelSentence(capabilities.detectionLevel))
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("onboarding.limited.level")
            ForEach(capabilities.issues) { issue in
                VStack(alignment: .leading, spacing: 2) {
                    Text(issue.title)
                        .font(.bodyTextSemibold)
                        .foregroundStyle(Color.textPrimary)
                    Text(issue.consequence)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("onboarding.limited.issue.\(issue.rawValue)")
            }
            Text("You can fix any of these later from the banner on the map or Account → Privacy.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            Button("Go back and allow") { withAnimation { phase = .rows } }
                .buttonStyle(.primary)
                .accessibilityIdentifier("onboarding.limited.goBack")
            Button("Continue anyway") {
                OnboardingGate.limitedDetectionAcknowledged = true
                onContinue()
            }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("onboarding.limited.continueAnyway")
        }
        .padding(Spacing.unitAndHalf)
        .onChange(of: capabilities.fullyGranted) { _, granted in
            // Fixed it in Settings and came back: nothing left to warn about.
            if granted { withAnimation { phase = .rows } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.limited")
    }

    private func permissionRow(
        icon: String,
        title: String,
        reason: String,
        state: String,
        satisfied: Bool,
        identifier: String,
        action: (title: String, run: () -> Void)?
    ) -> some View {
        HStack(alignment: .top, spacing: Spacing.unit) {
            Image(systemName: icon)
                .foregroundStyle(Color.textSecondary)
                .frame(width: 28)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(title)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                Text(reason)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            // The row's identifier lives on its text, not the whole row: on
            // the row it would overwrite the state's and button's own.
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(identifier)
            Spacer()
            VStack(alignment: .trailing, spacing: Spacing.quarter) {
                if satisfied {
                    // Identifier on the Text, not a Label: on a Label it
                    // lands on the icon, whose label is "Selected".
                    HStack(spacing: Spacing.quarter) {
                        Image(systemName: "checkmark.circle.fill")
                            .accessibilityHidden(true)
                        Text(state)
                            .accessibilityIdentifier("\(identifier).state")
                    }
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.success)
                } else {
                    Text(state)
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.textSecondary)
                        .accessibilityIdentifier("\(identifier).state")
                }
                if let action {
                    Button(action.title, action: action.run)
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.actionCoralLink)
                        .accessibilityIdentifier("\(identifier).action")
                }
            }
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
    }
}

// MARK: - Step 2: Vehicle

private struct OnboardingVehicleStep: View {
    @Environment(AppModel.self) private var model
    @AppStorage("vehicle.plate") private var plate = ""
    @AppStorage("vehicle.state") private var state = ""
    @AppStorage("vehicle.nickname") private var nickname = ""
    let onContinue: () -> Void

    @State private var loadedExisting = false
    @State private var existingId: String?
    @State private var isSaving = false
    @State private var saveError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Your car")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text(existingId == nil
                ? "Meters are paid against a plate."
                : "We already have this one — change it if it's wrong.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("onboarding.vehicleSubtitle")

            field("Plate", text: $plate, identifier: "onboarding.plateField")
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            field("State (2 letters)", text: $state, identifier: "onboarding.stateField")
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            field("Nickname (optional)", text: $nickname, identifier: "onboarding.nicknameField")

            if let saveError {
                Text(saveError)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .accessibilityIdentifier("onboarding.vehicleError")
            }

            Spacer()
            Button(isSaving ? "Saving…" : "Continue") {
                Task { await save() }
            }
            .buttonStyle(.primary)
            .disabled(!isValid || isSaving)
            .accessibilityIdentifier("onboarding.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .task {
            // Prefilled if known: a returning driver (or one who added a
            // car and came back) never retypes their plate.
            guard !loadedExisting else { return }
            loadedExisting = true
            guard let existing = try? await model.api.vehicles().first else { return }
            existingId = existing.id
            plate = existing.plate
            state = existing.state
            nickname = existing.label ?? ""
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.vehicle")
    }

    /// The plate belongs to the ACCOUNT now, not just this phone — it is
    /// what the executor types at the provider.
    private func save() async {
        isSaving = true
        saveError = nil
        let label = nickname.trimmingCharacters(in: .whitespaces)
        do {
            if let existingId {
                _ = try await model.api.updateVehicle(
                    id: existingId,
                    plate: plate.trimmingCharacters(in: .whitespaces),
                    state: state.trimmingCharacters(in: .whitespaces),
                    label: label.isEmpty ? nil : label
                )
            } else {
                _ = try await model.api.addVehicle(
                    plate: plate.trimmingCharacters(in: .whitespaces),
                    state: state.trimmingCharacters(in: .whitespaces),
                    label: label.isEmpty ? nil : label
                )
            }
            isSaving = false
            onContinue()
        } catch {
            isSaving = false
            saveError = (error as? APIError)?.errorDescription
                ?? "Couldn't save that plate. Try again."
        }
    }

    /// Loose on purpose: plates vary wildly; 2–8 characters is enough of a
    /// sanity check.
    private var isValid: Bool {
        let trimmedPlate = plate.trimmingCharacters(in: .whitespaces)
        let trimmedState = state.trimmingCharacters(in: .whitespaces)
        return (2...8).contains(trimmedPlate.count) && trimmedState.count == 2
    }

    private func field(_ placeholder: String, text: Binding<String>, identifier: String) -> some View {
        TextField(placeholder, text: text)
            .font(.bodyText)
            .padding(Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            .accessibilityIdentifier(identifier)
    }
}

// MARK: - Step 4: Your city

private struct OnboardingCityStep: View {
    @Environment(AppModel.self) private var model
    /// Called with "nyc" | "bos" | "other".
    let onSelect: (String) -> Void

    @State private var isDetecting = true
    @State private var detection: CityDetectResponse?
    @State private var choice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Your city")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)

            if isDetecting {
                HStack(spacing: Spacing.half) {
                    ProgressView()
                    Text("Checking where you are")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                }
            } else if let detection, let name = detection.cityDisplayName {
                Label {
                    // Identifier on the text, not the Label: on the Label it
                    // propagates to the icon too, and the tests would match
                    // the image (labeled "Location Services") first.
                    Text("Looks like \(name)\(detection.provider.map { " — meters run on \($0.displayName)" } ?? "")")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textPrimary)
                        .accessibilityIdentifier("onboarding.cityDetected")
                } icon: {
                    Image(systemName: "location.fill")
                        .foregroundStyle(Color.textSecondary)
                }
            } else {
                Text("Couldn't tell from here — pick your city.")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("onboarding.cityUnknown")
            }

            // From the catalog, alphabetical — the flow has no home city.
            ForEach(CityCatalog.allByDisplayName, id: \.self) { city in
                cityOption(
                    city,
                    label: CityCatalog.displayName(city) ?? city,
                    detail: CityCatalog.providerDisplayName(for: city)
                )
            }
            cityOption("other", label: "Somewhere else", detail: nil)

            Spacer()
            Button("Continue") {
                if let choice { onSelect(choice) }
            }
            .buttonStyle(.primary)
            .disabled(choice == nil)
            .accessibilityIdentifier("onboarding.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .task {
            guard detection == nil else { return }
            detection = await model.detectCityFromCurrentLocation()
            if let city = detection?.city, CityCatalog.displayName(city) != nil {
                choice = choice ?? city
            }
            isDetecting = false
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.city")
    }

    private func cityOption(_ key: String, label: String, detail: String?) -> some View {
        Button {
            choice = key
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: Spacing.quarter) {
                    Text(label)
                        .font(.bodyText)
                        .foregroundStyle(Color.textPrimary)
                    if let detail {
                        Text(detail)
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                    }
                }
                Spacer()
                Image(systemName: choice == key ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(choice == key ? Color.actionCoralLink : Color.separator)
            }
            .padding(Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            // Chrome and shape live inside the label: with them outside, a
            // tap over the Spacer falls through the plain button style.
            .contentShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("onboarding.city.\(key)")
    }
}

// MARK: - Step 4b: Somewhere else

private struct OnboardingElsewhereStep: View {
    let onFinish: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "map")
                .font(.system(size: 56))
                .foregroundStyle(Color.textSecondary)
            Text("We're not there yet")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("ParkAgent pays meters in \(CityCatalog.supportedCitiesSentence) for now. You can still browse the app, and pick a city later in your Account when you're in one.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Finish") { onFinish() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("onboarding.finishButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.elsewhere")
    }
}

// MARK: - Step 5: How do you want to pay

/// The Wallet's three ways to pay, with the Wallet's own copy (WalletCopy)
/// and the Wallet's own state (GET /wallet through the shared WalletModel)
/// — so what onboarding promises is exactly what the Wallet shows after.
/// "Your card on <provider>" is preselected.
private struct OnboardingPaymentStep: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let selectedCity: String
    let onContinue: () -> Void

    @State private var choice: PaymentSource = .providerCard
    @State private var consented = false
    @State private var saveFailed = false

    private var wallet: WalletModel { model.wallet }

    private var providerName: String {
        CityCatalog.providerDisplayName(for: selectedCity) ?? "your parking account"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                Text("How do you want to pay")
                    .font(.numeral)
                    .foregroundStyle(Color.textPrimary)
                    .padding(.top, Spacing.double)
                Text("Pick one — you can change it any time in Wallet. Your limits apply whichever pays.")
                    .font(.bodyText)
                    .foregroundStyle(Color.textSecondary)

                if let response = wallet.response {
                    ForEach(response.options, id: \.source) { option in
                        row(option)
                    }
                    requirement(response)
                } else if wallet.loadFailed {
                    // Can't ask the server: the default still works.
                    row(WalletSourceOption(source: .providerCard, availability: "available", needs: nil, sandbox: false))
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }

                if saveFailed, let error = wallet.actionError {
                    Text(error.errorDescription ?? "Couldn't save your choice. Try again.")
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.warningGold)
                        .accessibilityIdentifier("onboarding.paymentSaveFailed")
                }
            }
            .padding(Spacing.unitAndHalf)
        }
        .safeAreaInset(edge: .bottom) {
            Button(wallet.isWorking ? "Saving…" : "Continue") {
                Task { await save() }
            }
            .buttonStyle(.primary)
            .disabled(wallet.isWorking || !ready)
            .padding(Spacing.unitAndHalf)
            .background(Color.appBackground)
            .accessibilityIdentifier("onboarding.continueButton")
        }
        .task {
            await wallet.load(api: model.api)
            // Resuming: start from what the server already has.
            if let active = wallet.response?.activeSource { choice = active }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.payment")
    }

    private func row(_ option: WalletSourceOption) -> some View {
        let comingSoon = WalletCopy.isComingSoon(option, sandboxAllowed: FeatureFlags.parkAgentSandbox)
        let selected = choice == option.source
        return Button {
            guard !comingSoon else { return }
            choice = option.source
        } label: {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: Spacing.quarter) {
                    Text(comingSoon
                        ? (option.source == .linkWallet ? WalletCopy.linkComingSoon : "ParkAgent card")
                        : WalletCopy.title(option.source, provider: providerName))
                        .font(.bodyText)
                        .foregroundStyle(comingSoon ? Color.textSecondary : Color.textPrimary)
                    Text(comingSoon && option.source == .parkagentCard
                        ? WalletCopy.parkAgentComingSoon
                        : WalletCopy.explanation(option.source, provider: providerName))
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if option.source == .linkWallet && !comingSoon {
                        Text(WalletCopy.linkApprovalNote)
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                    }
                }
                Spacer()
                if comingSoon {
                    TagPill(label: "Coming soon", color: .textSecondary)
                } else {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.actionCoralLink : Color.separator)
                }
            }
            .padding(Spacing.unit)
            .background(comingSoon ? Color.surface.opacity(0.6) : Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            // Chrome and shape live inside the label: with them outside, a
            // tap over the Spacer falls through the plain button style.
            .contentShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(comingSoon)
        .accessibilityIdentifier("onboarding.payment.\(option.source.rawValue)")
        .accessibilityValue(selected ? "selected" : "not selected")
    }

    /// What the chosen way needs before it can be saved.
    @ViewBuilder
    private func requirement(_ response: WalletResponse) -> some View {
        switch choice {
        case .providerCard:
            EmptyView()
        case .linkWallet:
            if !response.link.connected {
                Button {
                    Task { await wallet.connectLink(api: model.api) { openURL($0) } }
                } label: {
                    Label("Connect Link", systemImage: "link")
                }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("onboarding.payment.connectLink")
            }
        case .parkagentCard:
            if response.parkagentCard.defaultFundingMethod == nil {
                VStack(spacing: Spacing.half) {
                    if StripeWallet.applePayAvailable || LaunchOverrides.useMockAPI {
                        Button {
                            Task { _ = await wallet.addCard(applePay: true, api: model.api) }
                        } label: {
                            Label("Add with Apple Pay", systemImage: "apple.logo")
                        }
                        .buttonStyle(.secondary)
                        .accessibilityIdentifier("onboarding.payment.applePay")
                    }
                    Button("Enter a card") {
                        Task { _ = await wallet.addCard(applePay: false, api: model.api) }
                    }
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("onboarding.payment.enterCard")
                }
            } else if let method = response.parkagentCard.defaultFundingMethod {
                Label(WalletCopy.fundingLine(method), systemImage: "checkmark.circle.fill")
                    .font(.secondaryText)
                    .foregroundStyle(Color.textPrimary)
                    .accessibilityIdentifier("onboarding.payment.cardSaved")
            }
            if !linkedWithoutCard(response).isEmpty {
                Button {
                    consented.toggle()
                } label: {
                    HStack(alignment: .top) {
                        Image(systemName: consented ? "checkmark.square.fill" : "square")
                            .foregroundStyle(consented ? Color.actionCoralLink : Color.textSecondary)
                        Text(WalletCopy.parkAgentConsent(providers: linkedWithoutCard(response)))
                            .font(.captionText)
                            .foregroundStyle(Color.textPrimary)
                            .multilineTextAlignment(.leading)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("onboarding.payment.consent")
            }
        }
    }

    private func linkedWithoutCard(_ response: WalletResponse) -> [String] {
        response.providers
            .filter { $0.isLinked && $0.paysWith?.source != .parkagentCard }
            .map(\.displayName)
    }

    private var ready: Bool {
        guard let response = wallet.response else { return choice == .providerCard }
        switch choice {
        case .providerCard: return true
        case .linkWallet: return response.link.connected
        case .parkagentCard:
            return response.parkagentCard.defaultFundingMethod != nil
                && (linkedWithoutCard(response).isEmpty || consented)
        }
    }

    private func save() async {
        saveFailed = false
        // Already the active way (the default for a new account): nothing
        // to write.
        if wallet.response?.activeSource == choice {
            onContinue()
            return
        }
        if await wallet.choose(choice, consent: consented, api: model.api) {
            onContinue()
        } else {
            saveFailed = true
        }
    }
}

// MARK: - Step 6: Link provider

private struct OnboardingLinkStep: View {
    @State private var link: ProviderLinkModel
    let onDone: () -> Void
    let onSkip: () -> Void

    init(providerId: String, onDone: @escaping () -> Void, onSkip: @escaping () -> Void) {
        _link = State(initialValue: ProviderLinkModel(providerId: providerId))
        self.onDone = onDone
        self.onSkip = onSkip
    }

    var body: some View {
        // No container identifier here — it would swallow the stage
        // containers (link.intro, link.done, …) the tests key off.
        VStack(spacing: 0) {
            ProviderLinkStagesView(link: link, onDone: onDone)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if showsSkip {
                Button("Skip for now") { onSkip() }
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
                    .padding(.bottom, Spacing.unit)
                    .accessibilityIdentifier("onboarding.linkSkipButton")
            }
        }
    }

    /// Never mid-flight: skipping while the server is adding the card
    /// would just hide the outcome.
    private var showsSkip: Bool {
        switch link.stage {
        case .intro, .unavailable, .failed: true
        default: false
        }
    }
}

// MARK: - Step 7: Budget

private struct OnboardingBudgetStep: View {
    @Environment(AppModel.self) private var model
    let onContinue: () -> Void

    @State private var sessionCap: Double = 0
    @State private var dailyCap: Double = 0
    @State private var defaultMinutes: Int = 0
    /// The policy hash the values came from; nil until the policy loads —
    /// no made-up numbers are ever shown, or saved over the real caps.
    @State private var seededHash: String?
    @State private var isSaving = false
    @State private var saveFailed = false

    /// Only the operator can change the shared limits (PUT /policy is
    /// admin-only); everyone else is shown them, not handed steppers that
    /// can't save. Not editable until the policy says so.
    private var editable: Bool { model.policyResponse?.canEdit ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Your limits")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)

            if seededHash == nil {
                policyPending
            } else {
                limits
            }
        }
        .padding(Spacing.unitAndHalf)
        // Re-seed whenever the policy arrives or changes: onboarding can
        // resume straight onto this step while the policy is still loading.
        .task(id: model.policyResponse?.hash) { seed() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.budget")
    }

    private func seed() {
        guard let response = model.policyResponse, response.hash != seededHash else { return }
        seededHash = response.hash
        sessionCap = response.policy.sessionCapUsd
        dailyCap = response.policy.dailyCapUsd
        defaultMinutes = response.policy.defaultStayMinutes
    }

    /// Still loading, or the load failed: say so, and never block setup on
    /// it — the limits can be read later in Account.
    @ViewBuilder
    private var policyPending: some View {
        if model.policyLoadFailed {
            Text("Couldn't load your limits. You can see them later in Account → Spending limits.")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("onboarding.budgetUnavailable")
            Button("Try again") { Task { await model.loadPolicy() } }
                .buttonStyle(.secondary)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity)
        }
        Spacer()
        Button("Continue") { onContinue() }
            .buttonStyle(.primary)
            .disabled(!model.policyLoadFailed)
            .accessibilityIdentifier("onboarding.continueButton")
    }

    @ViewBuilder
    private var limits: some View {
        stepperRow(
            "Per stop",
            value: Format.money(sessionCap),
            identifier: "onboarding.budget.sessionCap",
            decrement: { sessionCap = max(5, sessionCap - 5) },
            increment: { sessionCap = min(200, sessionCap + 5) }
        )
        stepperRow(
            "Per day",
            value: Format.money(dailyCap),
            identifier: "onboarding.budget.dailyCap",
            decrement: { dailyCap = max(5, dailyCap - 5) },
            increment: { dailyCap = min(400, dailyCap + 5) }
        )
        stepperRow(
            "Default stay",
            value: Format.minutes(defaultMinutes),
            identifier: "onboarding.budget.defaultStay",
            decrement: { defaultMinutes = max(15, defaultMinutes - 15) },
            increment: { defaultMinutes = min(240, defaultMinutes + 15) }
        )

        Text("We'll pay up to \(Format.money(sessionCap)) per stop and \(Format.money(dailyCap)) per day without asking.")
            .font(.secondaryText)
            .foregroundStyle(Color.textSecondary)
            .accessibilityIdentifier("onboarding.budgetPreview")
        if !editable {
            Text(SharedLimitsCopy.note)
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("onboarding.budgetShared")
        }

        if saveFailed {
            Text("Couldn't save to the server. Try again, or continue with the server's current limits.")
                .font(.captionTextSemibold)
                .foregroundStyle(Color.warningGold)
        }

        Spacer()
        Button(editable ? (isSaving ? "Saving…" : "Save and continue") : "Continue") {
            if editable {
                Task { await save() }
            } else {
                onContinue()
            }
        }
        .buttonStyle(.primary)
        .disabled(isSaving)
        .accessibilityIdentifier("onboarding.continueButton")
        if saveFailed {
            Button("Continue without saving") { onContinue() }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("onboarding.budgetSkipSave")
        }
    }

    private func save() async {
        isSaving = true
        saveFailed = false
        let ok = await model.saveBudget(
            sessionCapUsd: sessionCap,
            dailyCapUsd: dailyCap,
            defaultStayMinutes: defaultMinutes
        )
        isSaving = false
        if ok {
            onContinue()
        } else {
            saveFailed = true
        }
    }

    private func stepperRow(
        _ label: String,
        value: String,
        identifier: String,
        decrement: @escaping () -> Void,
        increment: @escaping () -> Void
    ) -> some View {
        HStack {
            Text(label)
                .font(.bodyText)
                .foregroundStyle(Color.textPrimary)
            Spacer()
            if editable {
                Button(action: decrement) {
                    Image(systemName: "minus.circle")
                        .foregroundStyle(Color.textSecondary)
                        // 44pt targets: the glyph alone is well under HIG size.
                        .frame(width: 44, height: 44)
                }
                .accessibilityIdentifier("\(identifier).minus")
                .accessibilityLabel("Decrease \(label)")
            }
            Text(value)
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
                .frame(minWidth: 90)
                .accessibilityIdentifier(identifier)
                // VoiceOver reads the field with its value ("Per stop, $45").
                .accessibilityLabel("\(label), \(value)")
            if editable {
                Button(action: increment) {
                    Image(systemName: "plus.circle")
                        .foregroundStyle(Color.textSecondary)
                        .frame(width: 44, height: 44)
                }
                .accessibilityIdentifier("\(identifier).plus")
                .accessibilityLabel("Increase \(label)")
            }
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
    }
}

// MARK: - Step 8: Done

private struct OnboardingDoneStep: View {
    let onFinish: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(Color.success)
            Text("You're set")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("Park at a meter and ParkAgent takes it from there.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Go to Home") { onFinish() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("onboarding.goHomeButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.done")
    }
}

#if DEBUG
#Preview {
    OnboardingView()
        .environment(AppModel())
        .environment(PermissionsManager())
}
#endif
