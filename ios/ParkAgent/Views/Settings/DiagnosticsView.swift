#if DEBUG
import CoreLocation
import SwiftUI

/// Points to fire a simulated park from, so the whole detect → quote → pay
/// loop is testable without motion data. Every city we cover is
/// represented, and the picker defaults to the user's own city — there is no
/// home city. Works against mock and live APIs alike; against live, each
/// point exercises real zone lookup around that coordinate.
enum FixturePoint: String, CaseIterable, Identifiable {
    case boylstonBackBay
    case hanoverNorthEnd
    case columbusW81
    case grandLafayette
    case unmeteredPark

    var id: String { rawValue }

    /// Which city's zone data this point exercises; nil for the
    /// deliberately-unmetered point.
    var city: String? {
        switch self {
        case .boylstonBackBay, .hanoverNorthEnd: "bos"
        case .columbusW81, .grandLafayette: "nyc"
        case .unmeteredPark: nil
        }
    }

    var label: String {
        switch self {
        case .boylstonBackBay: "Boylston St, Back Bay"
        case .hanoverNorthEnd: "Hanover St, North End"
        case .columbusW81: "Columbus Ave & W 81st"
        case .grandLafayette: "Grand St & Lafayette"
        case .unmeteredPark: "Middle of a park (no meters)"
        }
    }

    var coordinate: CLLocationCoordinate2D {
        switch self {
        case .boylstonBackBay: CLLocationCoordinate2D(latitude: 42.3503, longitude: -71.0810)
        case .hanoverNorthEnd: CLLocationCoordinate2D(latitude: 42.3637, longitude: -71.0547)
        case .columbusW81: CLLocationCoordinate2D(latitude: 40.7784, longitude: -73.9818)
        case .grandLafayette: CLLocationCoordinate2D(latitude: 40.7191, longitude: -73.9987)
        case .unmeteredPark: CLLocationCoordinate2D(latitude: 42.3383, longitude: -71.1012)
        }
    }

    /// The first point in the given city, so the picker opens on somewhere
    /// the user could actually be parked.
    static func first(in city: String?) -> FixturePoint {
        allCases.first { $0.city == city } ?? .boylstonBackBay
    }
}

/// The hidden Diagnostics screen: everything that used to clutter Settings
/// as a "Developer" section, reachable only by tapping the version number
/// five times, and compiled out of Release builds entirely.
///
/// It answers the questions a field test actually raises — is the detector
/// armed, which permissions are missing, what fired, which server am I
/// talking to — plus the two destructive-ish tools (simulate a park, reset
/// onboarding). No mock/scenario pickers: the mock only exists behind the
/// UI-test launch argument now.
struct DiagnosticsView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
    @AppStorage(SignalLog.enabledKey) private var signalLogEnabled = false
    @AppStorage("hasOnboarded") private var hasOnboarded = false

    @State private var fixture: FixturePoint?
    @State private var simulating = false
    @State private var simulateError: String?
    @State private var health: HealthResponse?
    @State private var healthFailed = false
    @State private var confirmingReset = false

    /// Defaults to a point in the user's own city.
    private var selectedFixture: FixturePoint {
        fixture ?? .first(in: model.effectiveCity)
    }

    var body: some View {
        Form {
            detectionSection
            simulateSection
            signalLogSection
            serverSection
            resetSection
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            health = try? await model.api.health()
            healthFailed = health == nil
        }
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
            LabeledContent(
                "Car coordinate",
                value: model.carCoordinate.map {
                    String(format: "%.4f, %.4f", $0.latitude, $0.longitude)
                } ?? "none"
            )
        } header: {
            Text("Detection")
        } footer: {
            Text("Park detection needs Location Always and Motion; it fires on any two of motion stop, car-audio disconnect, and location settling.")
        }
    }

    // MARK: - Simulate a park

    @ViewBuilder
    private var simulateSection: some View {
        Section {
            Button(simulating ? "Reporting…" : "Simulate park here") {
                Task { await simulate(at: nil) }
            }
            .disabled(simulating)
            .accessibilityIdentifier("diagnostics.simulateHereButton")

            Picker("Fixture point", selection: Binding(
                get: { selectedFixture },
                set: { fixture = $0 }
            )) {
                ForEach(FixturePoint.allCases) { point in
                    Text(point.label).tag(point)
                }
            }
            .accessibilityIdentifier("diagnostics.fixturePicker")

            Button(simulating ? "Reporting…" : "Simulate park at \(selectedFixture.label)") {
                Task { await simulate(at: selectedFixture.coordinate) }
            }
            .disabled(simulating)
            .accessibilityIdentifier("diagnostics.simulateParkButton")

            if let simulateError {
                Text(simulateError)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.danger)
                    .accessibilityIdentifier("diagnostics.simulateError")
            }
        } header: {
            Text("Simulate a park")
        } footer: {
            Text("Sends POST /parked and opens the parked sheet, exactly as the detector would. \"Here\" uses a real location fix, so it exercises the zone data where you actually are.")
        }
    }

    /// nil coordinate → a real fix from where the phone is now.
    private func simulate(at coordinate: CLLocationCoordinate2D?) async {
        simulating = true
        simulateError = nil
        defer { simulating = false }
        var point = coordinate
        if point == nil {
            point = await OneShotLocation.request()
            if point == nil {
                simulateError = "Couldn't get a location fix — allow location, or pick a fixture point."
                return
            }
        }
        guard let point else { return }
        await model.handleDetectedPark(coordinate: point, accuracy: 12.5, signals: ["simulated"])
    }

    // MARK: - Signal log

    @ViewBuilder
    private var signalLogSection: some View {
        Section {
            Toggle("Log raw detector signals", isOn: $signalLogEnabled)
                .accessibilityIdentifier("diagnostics.signalLogToggle")
            if signalLogEnabled {
                LabeledContent("Logged events", value: "\(SignalLog.shared.lineCount)")
                ForEach(SignalLog.shared.tail(), id: \.self) { line in
                    Text(line)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.textSecondary)
                }
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
            Text("Every raw motion, car-audio, and location event with its timestamp, kept on this phone. Export it after a drive to see what fired.")
        }
    }

    // MARK: - Server

    @ViewBuilder
    private var serverSection: some View {
        Section {
            LabeledContent("API base", value: AppConfig.apiBaseURL?.absoluteString ?? "not set")
                .accessibilityIdentifier("diagnostics.apiBase")
            if let health {
                LabeledContent("Commit", value: health.commit)
                    .accessibilityIdentifier("diagnostics.commit")
                LabeledContent("Built", value: health.builtAt)
                // Effective dry run is env DRY_RUN OR the policy's dry_run;
                // /health only echoes the env half, so a server with the env
                // off but the policy on read "OFF — real money" when nothing
                // could move. GET /policy carries the effective value.
                let dryRun = model.policyResponse?.dryRun ?? health.dryRun
                LabeledContent("Dry run", value: dryRun ? "On — no money moves" : "OFF — real money")
                    .foregroundStyle(dryRun ? Color.textPrimary : Color.danger)
                    .accessibilityIdentifier("diagnostics.dryRun")
            } else if healthFailed {
                Text(model.liveAPIUnavailable
                    ? "No API_BASE_URL in Config.xcconfig."
                    : "Couldn't reach /health.")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .accessibilityIdentifier("diagnostics.healthFailed")
            } else {
                HStack(spacing: Spacing.half) {
                    ProgressView()
                    Text("Checking /health")
                        .font(.secondaryText)
                        .foregroundStyle(Color.textSecondary)
                }
            }
            LabeledContent("Client", value: model.useMockAPI ? "MOCK (launch argument)" : "Live")
                .accessibilityIdentifier("diagnostics.client")
        } header: {
            Text("Server")
        } footer: {
            Text("Which server build this phone is talking to. If the commit isn't what you just deployed, the app is pointed somewhere else.")
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
            Text("Clears the stored vehicle, city, and completion flag, then quit and reopen the app to walk onboarding again. Your provider link and server-side settings are untouched.")
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
