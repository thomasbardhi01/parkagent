import SwiftUI

struct RootView: View {
    /// Set when the user finishes the flow. On a REAL launch it is only a
    /// this-session latch — the next launch re-derives the truth below —
    /// but UI tests (-skipOnboarding) rely on it to land on Home.
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
                OnboardingView(startAt: step)
            case .ready:
                MainTabView()
            }
        }
        .environment(model)
        .environment(permissions)
        .task {
            await model.loadPolicy()
            await evaluateGate()
        }
        .onChange(of: hasOnboarded) { _, onboarded in
            if onboarded {
                // The flow's own completion; re-derived from truth next launch.
                gate = .ready
            } else {
                // Diagnostics' Reset onboarding cleared it: back through the
                // gate, which now finds the vehicle and city missing.
                gate = .checking
                Task { await evaluateGate() }
            }
        }
        .onChange(of: gate) { _, gate in
            if gate == .ready { model.startBackgroundWork() }
        }
    }

    private func evaluateGate() async {
        guard gate == .checking else { return }
        // UI tests run against the mock with no OS permission grants; they
        // opt in/out of onboarding explicitly via -skipOnboarding.
        if LaunchOverrides.uiTesting {
            gate = hasOnboarded ? .ready : .onboarding(savedOrFirstStep)
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

        // The server's truth about the provider link. Unreachable server →
        // land on Home, where the connectivity error is shown; never trap
        // the user in onboarding over a network blip.
        guard let status = try? await model.api.providersStatus() else { return nil }
        let linked = status.providers.first { $0.id == providerId }?.isLinked ?? false
        return linked ? nil : .linkProvider
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
