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
    }
}

struct MainTabView: View {
    var body: some View {
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
    }
}

#Preview {
    RootView()
}
