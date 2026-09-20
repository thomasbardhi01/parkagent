#if DEBUG
import CoreLocation
import SwiftUI

/// NYC points to fire a simulated park from, so the whole detect → quote →
/// pay loop is testable on the simulator without motion data. Works against
/// mock and live APIs alike; against live, each point exercises real zone
/// lookup around that coordinate.
enum NYCFixturePoint: String, CaseIterable, Identifiable {
    case columbusW81
    case broadwayW96
    case grandLafayette
    case centralParkLoop

    var id: String { rawValue }

    var label: String {
        switch self {
        case .columbusW81: "Columbus Ave & W 81st"
        case .broadwayW96: "Broadway & W 96th"
        case .grandLafayette: "Grand St & Lafayette"
        case .centralParkLoop: "Central Park loop (no meters)"
        }
    }

    var coordinate: CLLocationCoordinate2D {
        switch self {
        case .columbusW81: CLLocationCoordinate2D(latitude: 40.7784, longitude: -73.9818)
        case .broadwayW96: CLLocationCoordinate2D(latitude: 40.7942, longitude: -73.9722)
        case .grandLafayette: CLLocationCoordinate2D(latitude: 40.7191, longitude: -73.9987)
        case .centralParkLoop: CLLocationCoordinate2D(latitude: 40.7745, longitude: -73.9708)
        }
    }
}

struct DebugMenuView: View {
    @Environment(AppModel.self) private var model
    @State private var fixture = NYCFixturePoint.columbusW81
    @State private var simulating = false

    var body: some View {
        Form {
            Section {
                Picker("Fixture point", selection: $fixture) {
                    ForEach(NYCFixturePoint.allCases) { point in
                        Text(point.label).tag(point)
                    }
                }
                Button(simulating ? "Reporting…" : "Simulate park here") {
                    simulating = true
                    Task {
                        await model.handleDetectedPark(
                            coordinate: fixture.coordinate,
                            accuracy: 12.5,
                            signals: ["simulated"]
                        )
                        simulating = false
                    }
                }
                .disabled(simulating)
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
