import SwiftUI

/// Three stages, in order: no valid session → Welcome (sign-in); signed in
/// → the truth gate (`OnboardingGate`: resume at the first missing setup
/// step); nothing missing → Home. Auth comes first because every protected
/// request needs the access token, including the ones the gate and
/// onboarding make.
struct RootView: View {
    /// Set when the user finishes the flow. It never drives the gate
    /// forward — finishing calls back (`onComplete`), because a returning
    /// user the gate sends back into onboarding already has it set, and
    /// re-setting a true value fires no change. A real launch re-derives
    /// the truth below; UI tests (-skipOnboarding) read it directly, and
    /// Diagnostics' reset clears it to re-run the gate.
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @State private var authStore: AuthStore
    @State private var model: AppModel
    @State private var auth: AuthModel
    @State private var permissions = PermissionsManager()
    @State private var gate: Gate = .checking

    /// Onboarding is gated by what is actually true — permissions, the
    /// account's car, the chosen city, and the server's provider-link state
    /// — not by a persisted flag that can survive a reinstall or a mock run.
    enum Gate: Equatable {
        case checking
        case onboarding(OnboardingStep)
        case ready
    }

    /// Which side of the welcome screen we are on; `.task(id:)` keys off it
    /// so each sign-in runs the gate once and each sign-out tears down.
    private enum SessionPhase: Equatable {
        case loading, signedOut, signedIn
    }

    init() {
        // One store, shared: AppModel reads tokens through it and AuthModel
        // writes them. A second instance would mint a second device id.
        let store = AuthStore()
        let model = AppModel(authStore: store)
        _authStore = State(initialValue: store)
        _model = State(initialValue: model)
        #if DEBUG
        _auth = State(initialValue: AuthModel(
            api: model.api,
            store: store,
            usesMockSignIn: model.useMockAPI
        ))
        #else
        _auth = State(initialValue: AuthModel(api: model.api, store: store))
        #endif
    }

    var body: some View {
        // A ZStack, not a Group: a Group hands its modifiers to whichever
        // branch is showing, so the lifecycle tasks below were torn down
        // and restarted every time the screen changed — the policy load
        // was cancelled mid-flight the moment the gate flipped from the
        // spinner to Home, and Home showed "can't reach the server" over a
        // request that had in fact answered 200 (seen on the live path).
        ZStack {
            switch authStore.state {
            case .loading:
                // One frame while the Keychain is read; a spinner here
                // beats a welcome screen that flashes for signed-in users.
                spinner
            case .signedOut:
                // Never the "not configured" banner: without a server the
                // sign-in buttons say so themselves.
                WelcomeView()
            case .signedIn:
                switch gate {
                case .checking:
                    spinner
                case .onboarding(let step):
                    OnboardingView(startAt: step) { gate = .ready }
                case .ready:
                    MainTabView()
                }
            }
        }
        .environment(model)
        .environment(auth)
        .environment(authStore)
        .environment(permissions)
        // Read the Keychain and wire the refresh transport before anything
        // makes a protected request.
        .task { model.restoreSession() }
        .task(id: sessionPhase) { await enter(sessionPhase) }
        .onChange(of: hasOnboarded) { _, onboarded in
            // Diagnostics' Reset onboarding cleared it: back through the
            // gate, which now finds this phone's setup missing.
            guard !onboarded, authStore.isSignedIn else { return }
            gate = .checking
            Task { await evaluateGate() }
        }
        .onChange(of: gate) { _, gate in
            if gate == .ready { model.startBackgroundWork() }
        }
    }

    private var spinner: some View {
        ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.appBackground)
    }

    private var sessionPhase: SessionPhase {
        switch authStore.state {
        case .loading: .loading
        case .signedOut: .signedOut
        case .signedIn: .signedIn
        }
    }

    /// Per-account lifecycle. Signing in (or launching signed in) loads the
    /// policy and runs the gate side by side — the gate needs no policy,
    /// and waiting on one before the other only lengthens the spinner.
    /// Signing out stops everything that belonged to the account and resets
    /// the gate for whoever signs in next.
    private func enter(_ phase: SessionPhase) async {
        switch phase {
        case .loading:
            return
        case .signedOut:
            model.stopBackgroundWork()
            gate = .checking
        case .signedIn:
            gate = .checking
            async let policy: Void = model.loadPolicy()
            await evaluateGate()
            await policy
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
        let missing = OnboardingGate.firstMissingStep(await gatherFacts())
        // Signed out while the server was answering: the next sign-in
        // runs its own check.
        guard authStore.isSignedIn, gate == .checking else { return }
        gate = missing.map(Gate.onboarding) ?? .ready
    }

    /// Where a UI-test onboarding launch starts (-onboardingStep resume).
    /// Step 0 is the retired onboarding welcome; sign-in replaced it.
    private var savedOrFirstStep: OnboardingStep {
        let saved = UserDefaults.standard.integer(forKey: OnboardingStep.defaultsKey)
        let step = OnboardingStep(rawValue: saved) ?? .permissions
        return step == .welcome ? .permissions : step
    }

    private func gatherFacts() async -> OnboardingGate.Facts {
        await permissions.refreshNotificationStatus()
        let permissionsOK = permissions.locationStatus == .authorizedAlways
            && (!permissions.motionAvailable || permissions.motionStatus == .authorized)
            && permissions.notificationsGranted
        let server = await OnboardingGate.serverFacts(api: model.api)
        return OnboardingGate.Facts(
            permissionsOK: permissionsOK,
            serverHasVehicle: server.hasVehicle,
            localVehicleOK: OnboardingGate.localVehicleOK(),
            city: UserDefaults.standard.string(forKey: "selectedCity"),
            usableProviders: server.usableProviders
        )
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        // Park · Activity · Wallet. Settings lives in the Account sheet
        // behind the Park tab's avatar button.
        TabView(selection: $model.selectedTab) {
            HomeView()
                .tabItem { Label("Park", systemImage: "map") }
                .tag(AppTab.park)
            ActivityView()
                .tabItem { Label("Activity", systemImage: "clock.arrow.circlepath") }
                .tag(AppTab.activity)
            WalletView()
                .tabItem { Label("Wallet", systemImage: "wallet.bifold") }
                .tag(AppTab.wallet)
        }
        .tint(.actionCoral)
        // At the tab level, not inside HomeView: a park detected while the
        // user is on another tab must still surface the sheet.
        .sheet(item: $model.pendingParked) { parked in
            ParkingDetectedSheet(parked: parked)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.hidden)
        }
        // The Account sheet's re-link and the provider_relink push land
        // here; the parked sheet presents its own copy (a sheet can't
        // stack on it).
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
        .task {
            // The Wallet summary feeds Home's "today" bar too — load it at
            // launch, not only when the Wallet tab opens, or Home would
            // show nothing spent while the Wallet shows the real day.
            await model.wallet.load(api: model.api)
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
            case "providers":
                // The provider_relink / reconnect push deep link.
                let provider = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "provider" })?.value
                if let provider {
                    model.providerLinkPrompt = ProviderLinkPrompt(providerId: provider)
                }
            case "link":
                // The OAuth callback page bounced back after connecting.
                Task {
                    await model.refreshLinkWalletStatus()
                    await model.wallet.load(api: model.api)
                }
            case "wallet":
                // The card_declined push: fix the card in the Wallet.
                model.selectedTab = .wallet
            case "pay":
                // The payment_failed push's link: the Park tab, where the
                // session (or the zone number to pay elsewhere) is.
                model.selectedTab = .park
            default:
                break
            }
        }
        #if DEBUG
        .overlay(alignment: .bottomLeading) {
            if LaunchOverrides.uiTesting {
                // UI tests read this to assert the appearance setting took.
                Text(colorScheme == .dark ? "dark" : "light")
                    .font(.system(size: 2))
                    .opacity(0.02)
                    .accessibilityIdentifier("root.colorSchemeProbe")
            }
        }
        #endif
    }
}

#if DEBUG
#Preview {
    RootView()
}
#endif
