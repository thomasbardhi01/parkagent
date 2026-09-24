#if DEBUG
import CoreLocation
import SwiftUI

/// Points to fire a simulated park from, so the whole detect → quote → pay
/// loop is testable on the simulator without motion data. Every city we
/// cover is represented, and the picker defaults to the user's own city —
/// there is no home city. Works against mock and live APIs alike; against
/// live, each point exercises real zone lookup around that coordinate.
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

struct DebugMenuView: View {
    @Environment(AppModel.self) private var model
    @State private var fixture: FixturePoint?
    @State private var simulating = false
    @AppStorage(SignalLog.enabledKey) private var signalLogEnabled = false

    /// Defaults to a point in the user's own city.
    private var selectedFixture: FixturePoint {
        fixture ?? .first(in: model.effectiveCity)
    }

    var body: some View {
        Form {
            Section {
                Picker("Fixture point", selection: Binding(
                    get: { selectedFixture },
                    set: { fixture = $0 }
                )) {
                    ForEach(FixturePoint.allCases) { point in
                        Text(point.label).tag(point)
                    }
                }
                Button(simulating ? "Reporting…" : "Simulate park here") {
                    simulating = true
                    Task {
                        await model.handleDetectedPark(
                            coordinate: selectedFixture.coordinate,
                            accuracy: 12.5,
                            signals: ["simulated"]
                        )
                        simulating = false
                    }
                }
                .disabled(simulating)
                .accessibilityIdentifier("debug.simulateParkButton")
            } header: {
                Text("Simulate a park")
            } footer: {
                Text("Sends POST /parked from the chosen point. On the mock API the scenario picker decides the response; on the live API this exercises real zone lookup.")
            }

            Section("Active session") {
                if model.activeSession != nil {
                    Button("Make session expiring") { model.debugMakeSessionExpiring() }
                    Button("Mark max stay reached") { model.debugMarkMaxStayReached() }
                } else {
                    Text("No active session")
                        .foregroundStyle(Color.textSecondary)
                }
            }

            Section("Detection") {
                LabeledContent("Detector running", value: model.detector.isRunning ? "Yes" : "No")
                LabeledContent(
                    "Car coordinate",
                    value: model.carCoordinate.map {
                        String(format: "%.4f, %.4f", $0.latitude, $0.longitude)
                    } ?? "none"
                )
                if !model.detector.missingPermissions.isEmpty {
                    LabeledContent(
                        "Missing permissions",
                        value: model.detector.missingPermissions
                            .map(\.rawValue).joined(separator: ", ")
                    )
                }
            }

            Section {
                Toggle("Log raw detector signals", isOn: $signalLogEnabled)
                    .accessibilityIdentifier("debug.signalLogToggle")
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
                    Button("Clear log", role: .destructive) {
                        SignalLog.shared.clear()
                    }
                }
            } header: {
                Text("Signal log")
            } footer: {
                Text("Every raw motion, car-audio, and location event with its timestamp, kept on this phone. Export it after a field-test drive to see what fired.")
            }
        }
        .navigationTitle("Debug")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        DebugMenuView()
            .environment(AppModel())
    }
}
#endif
