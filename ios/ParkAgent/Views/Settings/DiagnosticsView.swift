#if DEBUG
import SwiftUI

/// The hidden Diagnostics screen: reachable only by tapping the version
/// number five times, and compiled out of Release builds entirely.
///
/// Exactly what a field test needs and nothing else: is the detector armed
/// (and if not, which permission is missing), the raw signal log to export
/// after a drive, whether the server can move money right now, a way back
/// through onboarding, and the ParkAgent card's sandbox switch. No
/// simulated parks, no fixture points, no mock switches — the mock only
/// exists behind the UI-test launch argument.
struct DiagnosticsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
    @AppStorage(SignalLog.enabledKey) private var signalLogEnabled = false
    @AppStorage(FeatureFlags.parkAgentSandboxKey) private var parkAgentSandbox = false
    @AppStorage("hasOnboarded") private var hasOnboarded = false

    @State private var confirmingReset = false

    var body: some View {
        Form {
            detectionSection
            signalLogSection
            dryRunSection
            sandboxSection
            resetSection
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        // The effective dry run can change under a running app (PUT
        // /policy, a redeploy), so read it fresh each time.
        .task { await model.loadPolicy() }
        .accessibilityIdentifier("diagnostics.view")
    }

    // MARK: - Detection

    @ViewBuilder
    private var detectionSection: some View {
        Section {
            LabeledContent("Detector", value: model.detector.isRunning ? "Running" : "Stopped")
                .accessibilityIdentifier("diagnostics.detectorStatus")
            LabeledContent("Location", value: locationStatusText)
            LabeledContent("Motion", value: motionStatusText)
            LabeledContent("Notifications", value: notificationStatusText)
            if model.detector.missingPermissions.isEmpty {
                Label("Fully armed", systemImage: "checkmark.circle.fill")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.success)
            } else {
                // The detector keeps running on whatever remains (two of
                // three signals still fire), so this is a warning, not an error.
                Label(
                    "Missing: \(model.detector.missingPermissions.map(\.rawValue).joined(separator: ", "))",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.captionTextSemibold)
                .foregroundStyle(Color.warningGold)
                .accessibilityIdentifier("diagnostics.missingPermissions")
                Button("Open Settings") { openSystemSettings() }
                    .foregroundStyle(Color.actionCoralLink)
            }
        } header: {
            Text("Detection")
        } footer: {
            Text("Park detection needs Location Always and Motion. It fires on any two of motion stop, car-audio disconnect, and location settling.")
        }
    }

    // MARK: - Signal log

    @ViewBuilder
    private var signalLogSection: some View {
        Section {
            Toggle("Log raw detector signals", isOn: $signalLogEnabled)
                .accessibilityIdentifier("diagnostics.signalLogToggle")
            if signalLogEnabled {
                LabeledContent("Logged events", value: "\(SignalLog.shared.lineCount)")
                ShareLink(item: SignalLog.shared.fileURL) {
                    Label("Export signal log", systemImage: "square.and.arrow.up")
                }
                .accessibilityIdentifier("diagnostics.exportSignalLog")
                Button("Clear log", role: .destructive) {
                    SignalLog.shared.clear()
                }
            }
        } header: {
            Text("Signal log")
        } footer: {
            Text("Every raw motion, car-audio, and location event with its timestamp, kept on this phone. Turn it on before a drive and export it afterwards to see what fired.")
        }
    }

    // MARK: - Dry run

    @ViewBuilder
    private var dryRunSection: some View {
        Section {
            // GET /policy's dryRun is the EFFECTIVE flag (env DRY_RUN or the
            // policy's dry_run) — what decides whether money can move.
            if let dryRun = model.policyResponse?.dryRun {
                LabeledContent("Dry run", value: dryRun ? "On — no money moves" : "OFF — real money")
                    .foregroundStyle(dryRun ? Color.textPrimary : Color.danger)
                    .accessibilityIdentifier("diagnostics.dryRun")
            } else if model.policyLoadFailed {
                Text("Couldn't reach the server to read it.")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .accessibilityIdentifier("diagnostics.dryRunUnknown")
            } else {
                ProgressView()
            }
        } header: {
            Text("Server")
        } footer: {
            Text("Whether the server can move real money right now. It is off only when both the server setting and the spending policy allow it.")
        }
    }

    // MARK: - ParkAgent card sandbox

    @ViewBuilder
    private var sandboxSection: some View {
        Section {
            Toggle("ParkAgent card sandbox", isOn: $parkAgentSandbox)
                .accessibilityIdentifier("diagnostics.sandboxToggle")
                .onChange(of: parkAgentSandbox) {
                    // The Wallet reads the flag when it renders; a fresh
                    // summary re-renders every screen that shows it.
                    Task { await model.wallet.load(api: model.api) }
                }
        } header: {
            Text("ParkAgent card")
        } footer: {
            Text("Lets this build choose the ParkAgent card before it's approved, only while the server uses a Stripe test key, so no real money can move. Turning it off doesn't change how you pay now — switch in Wallet first.")
        }
    }

    // MARK: - Reset

    @ViewBuilder
    private var resetSection: some View {
        Section {
            Button("Reset onboarding", role: .destructive) {
                confirmingReset = true
            }
            .accessibilityIdentifier("diagnostics.resetOnboardingButton")
        } header: {
            Text("Reset")
        } footer: {
            Text("Clears the stored vehicle, city, and setup progress on this phone and takes you back through setup. Your parking account link and server-side settings are untouched.")
        }
        .confirmationDialog(
            "Reset onboarding?",
            isPresented: $confirmingReset,
            titleVisibility: .visible
        ) {
            Button("Reset", role: .destructive) { resetOnboarding() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The vehicle and city you entered are cleared on this phone. Nothing on the server changes.")
        }
    }

    private func resetOnboarding() {
        let defaults = UserDefaults.standard
        for key in ["hasOnboarded", OnboardingStep.defaultsKey, "selectedCity",
                    "vehicle.plate", "vehicle.state", "vehicle.nickname"] {
            defaults.removeObject(forKey: key)
        }
        // @AppStorage holds its own copy; clear it through the wrapper too.
        hasOnboarded = false
    }

    // MARK: - Status text

    private var locationStatusText: String {
        switch permissions.locationStatus {
        case .authorizedAlways: "Always"
        case .authorizedWhenInUse: "While Using (needs Always)"
        case .denied, .restricted: "Denied"
        default: "Not requested"
        }
    }

    private var motionStatusText: String {
        guard permissions.motionAvailable else { return "Unavailable" }
        switch permissions.motionStatus {
        case .authorized: return "Allowed"
        case .denied, .restricted: return "Denied"
        default: return "Not requested"
        }
    }

    private var notificationStatusText: String {
        if permissions.notificationsGranted { return "Allowed" }
        if permissions.notificationsDenied { return "Denied" }
        return "Not requested"
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

#Preview {
    NavigationStack {
        DiagnosticsView()
            .environment(AppModel())
            .environment(PermissionsManager())
    }
}
#endif
