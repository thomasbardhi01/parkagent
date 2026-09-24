import MapKit
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
    @Namespace private var sessionZoom
    @State private var camera: MapCameraPosition = .region(MKCoordinateRegion(
        center: AppModel.fixtureCoordinate,
        span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
    ))

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Map(position: $camera) {
                UserAnnotation()
                if let car = model.carCoordinate {
                    Annotation("Your car", coordinate: car) {
                        MapPin(kind: .car)
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .overlay(alignment: .top) {
                VStack(spacing: Spacing.half) {
                    statusChip
                    if model.liveAPIUnavailable {
                        ErrorBanner(
                            icon: "exclamationmark.triangle.fill",
                            title: "Not connected to ParkAgent",
                            message: "The live API isn't configured — add API_BASE_URL and API_KEY to Config.xcconfig and reinstall."
                        )
                    } else if model.policyLoadFailed {
                        ErrorBanner(
                            title: "Can't reach the ParkAgent server",
                            message: "Nothing loads until the connection is back.",
                            retryTitle: "Retry",
                            retry: { Task { await model.loadPolicy() } }
                        )
                    }
                    if permissions.locationDenied {
                        PermissionBanner()
                    }
                    if permissions.motionDenied {
                        PermissionBanner(
                            icon: "figure.walk.circle",
                            title: "Motion & Fitness is off",
                            message: "Park detection loses its driving-to-walking signal without it."
                        )
                    }
                }
                .padding(.top, Spacing.half)
                .padding(.horizontal, Spacing.unit)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // The living wash lives in the sheet surface — layering it
                // over the map itself would fight the map.
                BottomSheet(livingBackdrop: true) { sheetContent }
            }
            .navigationDestination(for: String.self) { sessionId in
                ActiveSessionView()
                    .zoomDestination(id: sessionId, in: sessionZoom)
            }
        }
    }

    private var statusChip: some View {
        HStack(spacing: Spacing.half) {
            Circle()
                // textSecondary, not steel: steel is under 3:1 against the
                // light chip surface.
                .fill(model.activeSession == nil ? Color.textSecondary : Color.success)
                .frame(width: 8, height: 8)
            Text(chipText)
                .font(.captionTextSemibold)
                .foregroundStyle(Color.textPrimary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, Spacing.half)
        .background(Color.surface)
        .clipShape(Capsule())
        .shadow(color: .black.opacity(0.1), radius: 4, y: 1)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("home.statusChip")
    }

    private var chipText: String {
        let status: String
        if let session = model.activeSession {
            status = "Paid until \(Format.clockTime(session.expiresAt))"
        } else {
            status = "No active session"
        }
        // Multi-city state, always in view: which city's meters we'd pay.
        if let city = model.cityDisplayName {
            return "\(city) · \(status)"
        }
        return status
    }

    @ViewBuilder
    private var sheetContent: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            spendRow

            Button {
                model.openAssistant()
            } label: {
                Label("Ask ParkAgent", systemImage: "bubble.left.and.text.bubble.right")
            }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("home.askAssistantButton")

            if let day = model.activeItinerary {
                ItineraryDaySection(day: day)
            }

            if let session = model.activeSession {
                NavigationLink(value: session.sessionId) {
                    SessionRow(
                        street: session.zoneLabel,
                        zoneNumber: session.zoneNumber,
                        date: "Until \(Format.clockTime(session.expiresAt))",
                        amountUsd: session.amountUsd,
                        status: .active
                    )
                }
                .buttonStyle(.pressable)
                .zoomSource(id: session.sessionId, in: sessionZoom)
                .accessibilityIdentifier("home.activeSessionRow")
            }

            #if DEBUG
            if model.useMockAPI && model.activeSession == nil {
                Button("Simulate park") {
                    Task { await model.simulatePark() }
                }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("home.simulateParkButton")
            }
            #endif
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.view")
    }

    private var spendRow: some View {
        let cap = model.policyResponse?.policy.dailyCapUsd ?? 60
        let fraction = cap > 0 ? model.todaySpendUsd / cap : 0
        return VStack(alignment: .leading, spacing: Spacing.half) {
            HStack {
                Text("Today")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
                    .textCase(.uppercase)
                Spacer()
                Text("\(Format.money(model.todaySpendUsd)) of \(Format.money(cap))")
                    .font(.secondaryText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
            }
            ProgressBar(value: fraction, tint: fraction < 0.8 ? .actionCoral : .warningGold)
        }
    }
}

#Preview {
    HomeView()
        .environment(AppModel())
        .environment(PermissionsManager())
}
