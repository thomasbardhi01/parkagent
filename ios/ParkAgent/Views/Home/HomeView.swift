import MapKit
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(PermissionsManager.self) private var permissions
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
                    if permissions.locationDenied {
                        PermissionBanner()
                    }
                }
                .padding(.top, Spacing.half)
                .padding(.horizontal, Spacing.unit)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                BottomSheet { sheetContent }
            }
            .navigationDestination(for: String.self) { _ in
                ActiveSessionView()
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
        if let session = model.activeSession {
            return "Paid until \(Format.clockTime(session.expiresAt))"
        }
        return "No active session"
    }

    @ViewBuilder
    private var sheetContent: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            spendRow

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
                .buttonStyle(.plain)
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
