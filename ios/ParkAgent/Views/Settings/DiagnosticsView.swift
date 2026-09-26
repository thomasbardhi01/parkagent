#if DEBUG
import SwiftUI

/// The hidden Diagnostics screen: reachable only by tapping the version
/// number five times, and compiled out of Release builds entirely.
///
/// Exactly what a field test needs and nothing else: every capability the
/// detector depends on with its live state, the detector's own state and
/// self-test, the raw signal log to export after a drive, whether the
/// server can move money right now, a way back through onboarding, and the
/// ParkAgent card's sandbox switch. No
/// simulated parks, no fixture points, no mock switches — the mock only
/// exists behind the UI-test launch argument.
struct DiagnosticsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
    @AppStorage(SignalLog.enabledKey) private var signalLogEnabled = false
    @AppStorage(FeatureFlags.parkAgentSandboxKey) private var parkAgentSandbox = false
    @AppStorage("hasOnboarded") private var hasOnboarded = false

    @State private var confirmingReset = false
    @State private var selfTest = DetectorSelfTest()

    var body: some View {
        Form {
            detectionSection
            selfTestSection
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
        let detector = model.detector
        Section {
            LabeledContent("Detector", value: detector.isArmed ? "Running (\(detector.mode.rawValue))" : "Stopped")
                .accessibilityIdentifier("diagnostics.detectorStatus")
            // Every capability, live, each tappable like Account → Privacy.
            CapabilityRowsView(identifierPrefix: "diagnostics.capability")
            LabeledContent("Low Power Mode", value: permissions.capabilities.lowPowerMode ? "On" : "Off")
                .accessibilityIdentifier("diagnostics.capability.lowPower")
            LabeledContent(
                "Background wake-ups",
                value: "Significant-change \(detector.monitoringSignificantChanges ? "on" : "off"), visits \(detector.monitoringVisits ? "on" : "off")"
            )
            if let wake = detector.lastWake {
                LabeledContent("Last wake", value: "\(wake.reason.rawValue), \(Format.clockTime(wake.at))")
            }
            if let fix = detector.lastFix {
                LabeledContent("Last fix", value: String(format: "±%.0f m, %@", fix.accuracy, Format.clockTime(fix.at)))
            }
            LabeledContent("Pending stop", value: detector.engine.hasPendingStop ? "Yes" : "No")
            let issues = permissions.capabilities.issues
            if issues.isEmpty {
                Label("Fully armed", systemImage: "checkmark.circle.fill")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.success)
            } else {
                // Detection keeps running on whatever remains, so this is
                // a warning list, not an error.
                Label(
                    "Missing: \(issues.map(\.title).joined(separator: "; "))",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.captionTextSemibold)
                .foregroundStyle(Color.warningGold)
                .accessibilityIdentifier("diagnostics.missingPermissions")
            }
        } header: {
            Text("Detection")
        } footer: {
            Text(DetectionCopy.levelSentence(permissions.capabilities.detectionLevel) + " A park needs two of: motion stop or walking away, car audio disconnecting, the location settling or an iOS visit — and a precise fix.")
        }
    }

    // MARK: - Self-test

    @ViewBuilder
    private var selfTestSection: some View {
        Section {
            Button(selfTest.isRunning ? "Testing…" : "Run detector self-test") {
                Task { await selfTest.run(model: model, permissions: permissions) }
            }
            .disabled(selfTest.isRunning)
            .accessibilityIdentifier("diagnostics.selfTest.run")
            ForEach(selfTest.checks) { check in
                HStack(alignment: .firstTextBaseline) {
                    Image(systemName: check.outcome == .pass ? "checkmark.circle.fill"
                        : check.outcome == .warn ? "exclamationmark.triangle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(check.outcome == .pass ? Color.success
                            : check.outcome == .warn ? Color.warningGold : Color.danger)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(check.title).font(.bodyText)
                        Text(check.detail)
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("diagnostics.selfTest.\(check.id)")
            }
            if !selfTest.checks.isEmpty, !selfTest.isRunning {
                Text(selfTest.passed ? "PASS — ready to drive" : "FAIL — fix the red items first")
                    .font(.captionTextSemibold)
                    .foregroundStyle(selfTest.passed ? Color.success : Color.danger)
                    .accessibilityIdentifier("diagnostics.selfTest.verdict")
            }
        } header: {
            Text("Detector self-test")
        } footer: {
            Text("Checks each permission and signal source live: a real location fix, motion history, the car audio route, background wake-ups, notifications, and the server.")
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
        for key in ["hasOnboarded", OnboardingStep.defaultsKey, "selectedCity", OnboardingGate.limitedDetectionKey,
                    "vehicle.plate", "vehicle.state", "vehicle.nickname"] {
            defaults.removeObject(forKey: key)
        }
        // @AppStorage holds its own copy; clear it through the wrapper too.
        hasOnboarded = false
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
