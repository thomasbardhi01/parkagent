import SwiftUI

/// The running meter: big countdown, auto-extend, distance from the car,
/// and the Extend/Stop actions. Three states: normal, expiring (gold, under
/// 10 minutes), and max-stay (extension off).
struct ActiveSessionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingStop = false

    var body: some View {
        Group {
            if let session = model.activeSession {
                content(session)
            } else {
                EmptyStateView(
                    icon: "checkmark.circle",
                    title: "Session ended",
                    message: "This session has been stopped."
                )
            }
        }
        .navigationTitle("Active session")
        .navigationBarTitleDisplayMode(.inline)
        .background(Color.appBackground)
        .onChange(of: model.activeSession == nil) { _, ended in
            if ended { dismiss() }
        }
    }

    private func content(_ session: ActiveSession) -> some View {
        @Bindable var model = model
        return ScrollView {
            VStack(spacing: Spacing.unit) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    countdown(session, at: context.date)
                }

                if session.maxStayReached {
                    Label("Max stay reached — this session cannot be extended", systemImage: "hand.raised.fill")
                        .font(.secondaryText)
                        .foregroundStyle(Color.warningGold)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(Spacing.unit)
                        .background(Color.warningGold.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }

                SessionRow(
                    street: session.zoneLabel,
                    zoneNumber: session.zoneNumber,
                    date: "Started \(Format.clockTime(session.startedAt))",
                    amountUsd: session.amountUsd,
                    status: .active
                )

                if let distance = model.distanceFromCarMeters {
                    HStack(spacing: Spacing.half) {
                        Image(systemName: "figure.walk")
                            .foregroundStyle(Color.slate)
                        Text("About \(Format.distanceMeters(distance)) from your car")
                            .font(.secondaryText)
                            .foregroundStyle(Color.textSecondary)
                        Spacer()
                    }
                    .padding(Spacing.unit)
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }

                ToggleRow(
                    title: "Auto-extend",
                    subtitle: autoExtendSubtitle,
                    isOn: Binding(
                        get: { model.activeSession?.autoExtend ?? false },
                        set: { model.activeSession?.autoExtend = $0 }
                    )
                )

                Button(extendTitle) {
                    Task { await model.extendSession() }
                }
                .buttonStyle(.primary)
                .disabled(!session.canExtend)

                Button("Stop session") { confirmingStop = true }
                    .buttonStyle(.destructive)
            }
            .padding(Spacing.unit)
        }
        .confirmationDialog("Stop this session?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop session", role: .destructive) {
                Task { await model.stopSession() }
            }
        } message: {
            Text("Paid time is not refunded.")
        }
    }

    private func countdown(_ session: ActiveSession, at date: Date) -> some View {
        let remaining = session.remaining(at: date)
        let total = session.expiresAt.timeIntervalSince(session.startedAt)
        let expired = remaining <= 0
        let expiring = session.isExpiring(at: date)

        return VStack(spacing: Spacing.half) {
            Text(expired ? "Expired" : Format.countdown(remaining))
                .font(.numeralLarge)
                .foregroundStyle(expired ? Color.danger : expiring ? Color.warningGold : Color.textPrimary)
            Text("until \(Format.clockTime(session.expiresAt))")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            ProgressBar(
                value: total > 0 ? 1 - remaining / total : 1,
                tint: expired ? .danger : expiring ? .warningGold : .actionCoral
            )
            StatusPill(status: expired ? .failed : expiring ? .expiring : .active)
        }
        .padding(Spacing.unitAndHalf)
        .frame(maxWidth: .infinity)
        .cardStyle()
    }

    private var autoExtendSubtitle: String {
        guard let policy = model.policyResponse?.policy.autoExtend else {
            return "Follows your policy limits"
        }
        return "Up to \(policy.maxCount) times, \(Format.minutes(policy.maxMinutesEach)) each"
    }

    private var extendTitle: String {
        let minutes = model.policyResponse?.policy.autoExtend.maxMinutesEach ?? 60
        return "Extend \(Format.minutes(minutes))"
    }
}

#Preview {
    NavigationStack {
        ActiveSessionView()
            .environment(previewModel())
    }
}

@MainActor
private func previewModel() -> AppModel {
    let model = AppModel()
    model.activeSession = ActiveSession(
        sessionId: "preview",
        zoneNumber: "110436",
        zoneLabel: "Zone 110436",
        startedAt: .now.addingTimeInterval(-30 * 60),
        expiresAt: .now.addingTimeInterval(60 * 60),
        amountUsd: 9.28,
        extendCount: 0,
        maxExtendCount: 2,
        maxStayReached: false,
        autoExtend: true
    )
    model.distanceFromCarMeters = 120
    return model
}
