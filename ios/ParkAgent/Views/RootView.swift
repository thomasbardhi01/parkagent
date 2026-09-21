import SwiftUI

struct RootView: View {
    @AppStorage("hasOnboarded") private var hasOnboarded = false
    @State private var model = AppModel()
    @State private var permissions = PermissionsManager()

    var body: some View {
        Group {
            if hasOnboarded {
                MainTabView()
            } else {
                OnboardingView()
            }
        }
        .environment(model)
        .environment(permissions)
        .task { await model.loadPolicy() }
        .onChange(of: hasOnboarded, initial: true) { _, onboarded in
            if onboarded { model.startBackgroundWork() }
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
