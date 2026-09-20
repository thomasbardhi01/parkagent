import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
    @AppStorage(MockScenario.defaultsKey) private var mockScenario = MockScenario.singleQuote.rawValue

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                policySection

                Section("Permissions") {
                    LabeledContent("Location", value: locationStatusText)
                    LabeledContent("Motion", value: motionStatusText)
                    if permissions.locationDenied || permissions.motionStatus == .denied {
                        Button("Open Settings") { openSystemSettings() }
                            .foregroundStyle(Color.actionCoral)
                    }
                }

                #if DEBUG
                Section {
                    Toggle("Use mock API", isOn: $model.useMockAPI)
                    if model.useMockAPI {
                        Picker("Mock scenario", selection: $mockScenario) {
                            ForEach(MockScenario.allCases) { scenario in
                                Text(scenario.label).tag(scenario.rawValue)
                            }
                        }
                    }
                    if model.liveAPIUnavailable {
                        Text("Live API is not configured — add API_BASE_URL and API_KEY to Config.xcconfig. Using the mock instead.")
                            .font(.captionText)
                            .foregroundStyle(Color.warningGold)
                    }
                    LabeledContent("API base", value: AppConfig.apiBaseURL?.absoluteString ?? "not set")
                    NavigationLink("Debug menu") { DebugMenuView() }
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
            .refreshable { await model.loadPolicy() }
        }
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
                    .foregroundStyle(Color.actionCoral)
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
