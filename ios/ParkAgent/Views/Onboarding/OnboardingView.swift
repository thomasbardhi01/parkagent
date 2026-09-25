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

private struct OnboardingPermissionsStep: View {
    @Environment(PermissionsManager.self) private var permissions
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Three permissions")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)

            permissionRow(
                icon: "location.fill",
                title: "Location — Always",
                reason: "Notices where you parked, even in the background.",
                granted: permissions.locationGranted,
                denied: permissions.locationDenied,
                identifier: "onboarding.permission.location",
                action: permissions.requestLocation
            )
            permissionRow(
                icon: "figure.walk.motion",
                title: "Motion",
                reason: "Tells driving from walking, so parks are real.",
                granted: permissions.motionStatus == .authorized,
                denied: permissions.motionStatus == .denied || !permissions.motionAvailable,
                deniedLabel: permissions.motionAvailable ? "Denied" : "Unavailable here",
                identifier: "onboarding.permission.motion",
                action: permissions.requestMotion
            )
            permissionRow(
                icon: "bell.fill",
                title: "Notifications",
                reason: "Tells you when a meter was paid or is running out.",
                granted: permissions.notificationsGranted,
                denied: permissions.notificationsDenied,
                identifier: "onboarding.permission.notifications",
                action: permissions.requestNotifications
            )

            Text("You can skip any of these, but detection won't work without location and motion.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("onboarding.permissionsNote")
            Spacer()
            Button("Continue") { onContinue() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("onboarding.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.permissions")
    }

    private func permissionRow(
        icon: String,
        title: String,
        reason: String,
        granted: Bool,
        denied: Bool,
        deniedLabel: String = "Denied",
        identifier: String,
        action: @escaping () -> Void
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
            Spacer()
            if granted {
                Label("On", systemImage: "checkmark.circle.fill")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.success)
            } else if denied {
                Text(deniedLabel)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
            } else {
                Button("Enable", action: action)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.actionCoralLink)
            }
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        // Identifier only, no container: a container here would be
        // flattened by the step's own and vanish from the hierarchy.
        .accessibilityIdentifier(identifier)
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

    @State private var sessionCap: Double = 45
    @State private var dailyCap: Double = 60
    @State private var defaultMinutes: Int = 90
    @State private var seeded = false
    @State private var isSaving = false
    @State private var saveFailed = false

    /// Only the operator can change the shared limits (PUT /policy is
    /// admin-only); everyone else is shown them, not handed steppers that
    /// can't save.
    private var editable: Bool { model.policyResponse?.canEdit ?? true }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Your limits")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)

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
        .padding(Spacing.unitAndHalf)
        .task {
            guard !seeded, let policy = model.policyResponse?.policy else { return }
            seeded = true
            sessionCap = policy.sessionCapUsd
            dailyCap = policy.dailyCapUsd
            defaultMinutes = policy.defaultStayMinutes
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.budget")
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
