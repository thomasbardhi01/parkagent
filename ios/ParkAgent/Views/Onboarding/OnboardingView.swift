import SwiftUI

/// Onboarding, rebuilt around linking the local parking provider:
/// welcome → permissions → vehicle → your city → how you pay →
/// link provider → (add money, ParkAgent card only) → budget → done.
/// One coral action per screen; abandoning mid-way resumes at the last
/// incomplete step on next launch.
enum OnboardingStep: Int, CaseIterable {
    case welcome
    case permissions
    case vehicle
    case city
    /// "Somewhere else" — we're not there yet; finishes without a provider.
    case elsewhere
    /// "How do you want to pay": the card on the provider account
    /// (default), or the ParkAgent card when the server says it's live.
    case payment
    case linkProvider
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

    init() {
        let saved = UserDefaults.standard.integer(forKey: OnboardingStep.defaultsKey)
        _step = State(initialValue: OnboardingStep(rawValue: saved) ?? .welcome)
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
        case .welcome:
            OnboardingWelcomeStep { advance(to: .permissions) }
        case .permissions:
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
                    // provider_card users have nothing to fund — the card
                    // on their provider account already pays; skip Add money.
                    onDone: { advance(to: afterLinkStep) },
                    onSkip: { advance(to: afterLinkStep) }
                )
                .id(providerId)
            } else {
                // Resume landed here without a stored city — re-ask.
                OnboardingCityStep { city in
                    selectedCity = city
                    advance(to: city == "other" ? .elsewhere : .payment)
                }
            }
        case .addMoney:
            OnboardingAddMoneyStep { advance(to: .budget) }
        case .budget:
            OnboardingBudgetStep { advance(to: .done) }
        case .done:
            OnboardingDoneStep { complete() }
        }
    }

    private func advance(to next: OnboardingStep) {
        withAnimation { step = next }
    }

    /// Where linking leads: funding only matters for the ParkAgent card.
    private var afterLinkStep: OnboardingStep {
        PaymentSource.stored == .issuingCard ? .addMoney : .budget
    }

    private func complete() {
        UserDefaults.standard.removeObject(forKey: OnboardingStep.defaultsKey)
        hasOnboarded = true
    }
}

// MARK: - Step 1: Welcome

private struct OnboardingWelcomeStep: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: Spacing.unit) {
            Spacer()
            Image(systemName: "parkingsign.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(Color.actionCoral)
            Text("Meet ParkAgent")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("Park at a meter and ParkAgent notices, quotes the cost, and pays through your own parking account — within limits you set.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
            Spacer()
            Button("Continue") { onContinue() }
                .buttonStyle(.primary)
                .accessibilityIdentifier("onboarding.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.welcome")
    }
}

// MARK: - Step 2: Permissions

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

// MARK: - Step 3: Vehicle

private struct OnboardingVehicleStep: View {
    @AppStorage("vehicle.plate") private var plate = ""
    @AppStorage("vehicle.state") private var state = ""
    @AppStorage("vehicle.nickname") private var nickname = ""
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("Your car")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("Meters are paid against a plate. This stays on your phone.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)

            field("Plate", text: $plate, identifier: "onboarding.plateField")
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            field("State (e.g. NY)", text: $state, identifier: "onboarding.stateField")
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            field("Nickname (optional)", text: $nickname, identifier: "onboarding.nicknameField")

            Spacer()
            Button("Continue") { onContinue() }
                .buttonStyle(.primary)
                .disabled(!isValid)
                .accessibilityIdentifier("onboarding.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.vehicle")
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

            cityOption("nyc", label: "New York City", detail: "ParkNYC")
            cityOption("bos", label: "Boston", detail: "ParkBoston")
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
            Text("ParkAgent pays meters in New York City and Boston for now. You can still browse the app, and pick a city later in Settings when you're in one.")
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

private struct OnboardingPaymentStep: View {
    @Environment(AppModel.self) private var model
    @AppStorage(PaymentSource.defaultsKey) private var storedSource = PaymentSource.providerCard.rawValue
    let selectedCity: String
    let onContinue: () -> Void

    @State private var choice: PaymentSource = .providerCard
    @State private var issuingLive = false
    @State private var isSaving = false
    @State private var saveFailed = false

    private var providerName: String {
        CityCatalog.providerDisplayName(for: selectedCity) ?? "your parking account"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            Spacer()
            Text("How do you want to pay")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
            Text("Meters are charged to one of these. Your limits apply either way.")
                .font(.bodyText)
                .foregroundStyle(Color.textSecondary)

            option(
                .providerCard,
                label: "My card on \(providerName)",
                detail: "The card already saved in your \(providerName) account pays. Nothing to set up."
            )
            if issuingLive {
                option(
                    .issuingCard,
                    label: "ParkAgent card",
                    detail: "A virtual card we manage, added to \(providerName) for you."
                )
            } else {
                comingSoonRow
            }

            if saveFailed {
                Text("Couldn't save your choice to the server. Try again.")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .accessibilityIdentifier("onboarding.paymentSaveFailed")
            }

            Spacer()
            Button(isSaving ? "Saving…" : "Continue") {
                Task { await save() }
            }
            .buttonStyle(.primary)
            .disabled(isSaving)
            .accessibilityIdentifier("onboarding.continueButton")
        }
        .padding(Spacing.unitAndHalf)
        .task {
            if let current = try? await model.api.paymentSource() {
                issuingLive = current.issuingLive
                choice = current.paymentSource
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding.payment")
    }

    private func save() async {
        isSaving = true
        saveFailed = false
        do {
            let saved = try await model.api.updatePaymentSource(choice)
            storedSource = saved.paymentSource.rawValue
            isSaving = false
            onContinue()
        } catch {
            isSaving = false
            saveFailed = true
        }
    }

    private func option(_ source: PaymentSource, label: String, detail: String) -> some View {
        Button {
            choice = source
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: Spacing.quarter) {
                    Text(label)
                        .font(.bodyText)
                        .foregroundStyle(Color.textPrimary)
                    Text(detail)
                        .font(.captionText)
                        .foregroundStyle(Color.textSecondary)
                }
                Spacer()
                Image(systemName: choice == source ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(choice == source ? Color.actionCoralLink : Color.separator)
            }
            .padding(Spacing.unit)
            .background(Color.surface)
            .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
            // Chrome and shape live inside the label: with them outside, a
            // tap over the Spacer falls through the plain button style.
            .contentShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("onboarding.payment.\(source.rawValue)")
    }

    private var comingSoonRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text("ParkAgent card")
                    .font(.bodyText)
                    .foregroundStyle(Color.textSecondary)
                Text("Coming soon — a virtual card we manage, with your caps built in.")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            TagPill(label: "Coming soon", color: .textSecondary)
        }
        .padding(Spacing.unit)
        .background(Color.surface.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityIdentifier("onboarding.payment.comingSoon")
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

// MARK: - Step 6: Add money

private struct OnboardingAddMoneyStep: View {
    let onContinue: () -> Void

    var body: some View {
        // AddMoneyView carries the "addMoney.view" container; wrapping it
        // in another would flatten it away.
        VStack(alignment: .leading, spacing: 0) {
            Text("Add money")
                .font(.numeral)
                .foregroundStyle(Color.textPrimary)
                .padding(.horizontal, Spacing.unitAndHalf)
                .padding(.top, Spacing.double)
            AddMoneyView(allowSkip: true) { onContinue() }
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

            if saveFailed {
                Text("Couldn't save to the server. Try again, or continue with the server's current limits.")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
            }

            Spacer()
            Button(isSaving ? "Saving…" : "Save and continue") {
                Task { await save() }
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
            Button(action: decrement) {
                Image(systemName: "minus.circle")
                    .foregroundStyle(Color.textSecondary)
                    // 44pt targets: the glyph alone is well under HIG size.
                    .frame(width: 44, height: 44)
            }
            .accessibilityIdentifier("\(identifier).minus")
            .accessibilityLabel("Decrease \(label)")
            Text(value)
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
                .frame(minWidth: 90)
                .accessibilityIdentifier(identifier)
                // VoiceOver reads the field with its value ("Per stop, $45").
                .accessibilityLabel("\(label), \(value)")
            Button(action: increment) {
                Image(systemName: "plus.circle")
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 44, height: 44)
            }
            .accessibilityIdentifier("\(identifier).plus")
            .accessibilityLabel("Increase \(label)")
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

#Preview {
    OnboardingView()
        .environment(AppModel())
        .environment(PermissionsManager())
}
