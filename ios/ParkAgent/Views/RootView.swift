import SwiftUI

struct RootView: View {
    /// Set when the user finishes the flow. It never drives the gate
    /// forward — finishing calls back (`onComplete`), because a returning
    /// user the gate sends back into onboarding already has it set, and
    /// re-setting a true value fires no change. A real launch re-derives
    /// the truth below; UI tests (-skipOnboarding) read it directly, and
    /// Diagnostics' reset clears it to re-run the gate.
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @State private var model = AppModel()
    @State private var permissions = PermissionsManager()
    @State private var gate: Gate = .checking

    /// Onboarding is gated by what is actually true — permissions, the
    /// stored vehicle and city, and the server's provider-link state — not
    /// by a persisted flag that can survive a reinstall or a mock run.
    enum Gate: Equatable {
        case checking
        case onboarding(OnboardingStep)
        case ready
    }

    var body: some View {
        Group {
            switch gate {
            case .checking:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.appBackground)
            case .onboarding(let step):
                OnboardingView(startAt: step) { gate = .ready }
            case .ready:
                MainTabView()
            }
        }
        .environment(model)
        .environment(permissions)
        // Independent: the gate needs no policy, and waiting on one network
        // call before starting the next only lengthens the launch spinner.
        .task { await model.loadPolicy() }
        .task { await evaluateGate() }
        .onChange(of: hasOnboarded) { _, onboarded in
            // Diagnostics' Reset onboarding cleared it: back through the
            // gate, which now finds the vehicle and city missing.
            guard !onboarded else { return }
            gate = .checking
            Task { await evaluateGate() }
        }
        .onChange(of: gate) { _, gate in
            if gate == .ready { model.startBackgroundWork() }
        }
    }

    private func evaluateGate() async {
        guard gate == .checking else { return }
        // UI tests run against the mock with no OS permission grants; they
        // opt in/out of onboarding explicitly via -skipOnboarding. A saved
        // step with the flag already set is a returning user re-entering
        // the flow (what the real gate does when a link lapses), which a
        // test reaches with -onboardingStep and the default -skipOnboarding.
        if LaunchOverrides.uiTesting {
            if !hasOnboarded {
                gate = .onboarding(savedOrFirstStep)
            } else if let saved = UserDefaults.standard.object(forKey: OnboardingStep.defaultsKey) as? Int,
                      let step = OnboardingStep(rawValue: saved) {
                gate = .onboarding(step)
            } else {
                gate = .ready
            }
            return
        }
        if let missing = await firstMissingStep() {
            gate = .onboarding(missing)
        } else {
            gate = .ready
        }
    }

    /// Where a UI-test onboarding launch starts (-onboardingStep resume).
    private var savedOrFirstStep: OnboardingStep {
        let saved = UserDefaults.standard.integer(forKey: OnboardingStep.defaultsKey)
        return OnboardingStep(rawValue: saved) ?? .welcome
    }

    /// The first onboarding step whose outcome is missing, or nil when the
    /// user is fully set up and lands on Home.
    private func firstMissingStep() async -> OnboardingStep? {
        await permissions.refreshNotificationStatus()

        let permissionsOK = permissions.locationStatus == .authorizedAlways
            && (!permissions.motionAvailable || permissions.motionStatus == .authorized)
            && permissions.notificationsGranted
        let defaults = UserDefaults.standard
        let plate = (defaults.string(forKey: "vehicle.plate") ?? "").trimmingCharacters(in: .whitespaces)
        let state = (defaults.string(forKey: "vehicle.state") ?? "").trimmingCharacters(in: .whitespaces)
        let vehicleOK = (2...8).contains(plate.count) && state.count == 2
        let city = defaults.string(forKey: "selectedCity")
        let cityOK = city == "nyc" || city == "bos" || city == "other"

        // Nothing set up at all → the full flow, from the welcome screen.
        if !permissionsOK && !vehicleOK && !cityOK { return .welcome }
        if !permissionsOK { return .permissions }
        if !vehicleOK { return .vehicle }
        guard cityOK else { return .city }
        // "Somewhere else": the flow finishes without a provider to link.
        guard let providerId = CityCatalog.providerId(for: city) else { return nil }

        // The server's truth about the provider link. Unreachable or slow
        // server → land on Home, where the connectivity error is shown;
        // never trap the user in onboarding (or on a spinner) over a
        // network blip.
        guard let linked = await providerLinked(providerId) else { return nil }
        return linked ? nil : .linkProvider
    }

    /// How long the launch gate waits on the server before giving up and
    /// landing on Home. URLSession's own timeout is 60 s — on one bar of
    /// signal in a garage that was a minute of spinner.
    private static let linkCheckTimeout: Duration = .seconds(4)

    /// Whether the provider is linked, or nil when the server didn't
    /// answer in time (or at all).
    private func providerLinked(_ providerId: String) async -> Bool? {
        let api = model.api
        let timeout = Self.linkCheckTimeout
        return await withTaskGroup(of: Bool?.self) { group in
            group.addTask {
                guard let status = try? await api.providersStatus() else { return nil }
                return status.providers.first { $0.id == providerId }?.isLinked ?? false
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        TabView {
            HomeView()
                .tabItem { Label("Home", systemImage: "map") }
            SessionsView()
                .tabItem { Label("Sessions", systemImage: "clock.arrow.circlepath") }
            CardView()
                .tabItem { Label("Card", systemImage: "creditcard") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.actionCoral)
        // At the tab level, not inside HomeView: a park detected while the
        // user is on another tab must still surface the sheet.
        .sheet(item: $model.pendingParked) { parked in
            ParkingDetectedSheet(parked: parked)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.hidden)
        }
        // Settings re-link and the provider_relink push land here; the
        // parked sheet presents its own copy (a sheet can't stack on it).
        .fullScreenCover(item: $model.providerLinkPrompt) { prompt in
            ProviderLinkFlowView(providerId: prompt.providerId)
        }
        // Home's Ask button, the Siri intent, and parkagent://assistant.
        .sheet(isPresented: $model.assistantPresented) {
            AssistantSheetView(initialQuery: model.assistantInitialQuery)
                .presentationDetents([.large])
        }
        .task {
            await model.refreshItineraries()
            await model.refreshLinkWalletStatus()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, let query = AssistantIntentRouter.shared.pendingQuery {
                AssistantIntentRouter.shared.pendingQuery = nil
                model.openAssistant(query: query.isEmpty ? nil : query)
            }
        }
        .onOpenURL { url in
            guard url.scheme == "parkagent" else { return }
            switch url.host {
            case "assistant":
                let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "q" })?.value
                model.openAssistant(query: query)
            case "link":
                // The OAuth callback page bounced back after connecting.
                Task { await model.refreshLinkWalletStatus() }
            default:
                break
            }
        }
        .overlay(alignment: .bottomLeading) {
            if LaunchOverrides.uiTesting {
                // UI tests read this to assert the appearance setting took.
                Text(colorScheme == .dark ? "dark" : "light")
                    .font(.system(size: 2))
                    .opacity(0.02)
                    .accessibilityIdentifier("root.colorSchemeProbe")
            }
        }
    }
}

#Preview {
    RootView()
}
