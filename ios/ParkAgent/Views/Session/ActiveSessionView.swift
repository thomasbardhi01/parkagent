import SwiftUI

/// The running meter: big countdown, auto-extend, distance from the car,
/// and the Extend/Stop actions. Three states: normal, expiring (gold, under
/// 10 minutes), and max-stay (extension off).
struct ActiveSessionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var confirmingStop = false
    /// Tracks the normal → expiring edge so the warning haptic fires once.
    @State private var wasExpiring = false

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
        .alert(
            "Could not update the session",
            isPresented: Binding(
                get: { model.sessionActionError != nil },
                set: { if !$0 { model.sessionActionError = nil } }
            )
        ) {
            Button("OK") { model.sessionActionError = nil }
        } message: {
            Text(sessionErrorMessage)
        }
    }

    private func content(_ session: ActiveSession) -> some View {
        @Bindable var model = model
        return ScrollView {
            VStack(spacing: Spacing.unit) {
                // AppClock.now, not context.date: with the test clock frozen,
                // the countdown must agree with the mock's expiry.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    countdown(session, at: AppClock.now)
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
                            .foregroundStyle(Color.textSecondary)
                        Text("About \(Format.distanceMeters(distance)) from your car")
                            .font(.secondaryText)
                            .foregroundStyle(Color.textSecondary)
                        Spacer()
                    }
                    .padding(Spacing.unit)
                    .background(Color.surface)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                }

                // Read-only on purpose: auto-extend follows the spending
                // policy on the server. There is no per-session switch —
                // the old toggle here changed nothing the extension worker
                // reads, so turning it off still extended (and spent).
                autoExtendRow

                Button {
                    Task { await model.extendSession() }
                } label: {
                    HStack(spacing: Spacing.half) {
                        if model.isExtending {
                            ProgressView().controlSize(.small).tint(.white)
                        }
                        Text(model.isExtending ? "Extending…" : extendTitle)
                    }
                }
                .buttonStyle(.primary)
                .disabled(!session.canExtend || model.isExtending)
                .accessibilityIdentifier("session.extendButton")

                Button("Stop session") { confirmingStop = true }
                    .buttonStyle(.destructive)
                    .accessibilityIdentifier("session.stopButton")
            }
            .padding(Spacing.unit)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("session.view")
        }
        .confirmationDialog("Stop this session?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop session", role: .destructive) {
                Task { await model.stopSession() }
            }
        } message: {
            Text("Paid time is not refunded.")
        }
        // .task, not onReceive(Timer.publish…): a publisher built in body
        // is torn down and re-phased on every re-evaluation (which the
        // walking-away distance updates cause about once a second), so the
        // 1s tick could be starved exactly when the session nears expiry.
        // The task survives re-evaluations and cancels on disappear.
        .task {
            while !Task.isCancelled {
                let expiring = model.activeSession?.isExpiring(at: AppClock.now) ?? false
                if expiring && !wasExpiring {
                    Haptics.warning()
                }
                wasExpiring = expiring
                try? await Task.sleep(for: .seconds(1))
            }
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
                // Seconds roll down instead of snapping; color morphs into
                // the gold expiring state. Both skipped under Reduce Motion.
                .contentTransition(reduceMotion ? .identity : .numericText(countsDown: true))
                .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: remaining.rounded())
                .animation(Motion.morph, value: expiring)
                .accessibilityIdentifier("session.countdown")
            Text("until \(Format.clockTime(session.expiresAt))")
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            ProgressBar(
                value: total > 0 ? 1 - remaining / total : 1,
                tint: expired ? .danger : expiring ? .warningGold : .actionCoral
            )
            StatusPill(status: expired ? .failed : expiring ? .expiring : .active)
            TagPill(
                label: session.paymentSource == .parkagentCard ? "ParkAgent card" : "Card on your account",
                color: .textSecondary
            )
        }
        .padding(Spacing.unitAndHalf)
        .frame(maxWidth: .infinity)
        .cardStyle()
    }

    private var sessionErrorMessage: String {
        model.sessionActionError?.errorDescription ?? ""
    }

    private var autoExtendRow: some View {
        let policy = model.policyResponse?.policy.autoExtend
        let on = policy?.enabled ?? true
        return HStack(alignment: .top, spacing: Spacing.unit) {
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text("Auto-extend")
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                Text(autoExtendSubtitle(policy))
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            Spacer()
            Text(on ? "On" : "Off")
                .font(.bodyTextSemibold)
                .foregroundStyle(on ? Color.textPrimary : Color.textSecondary)
        }
        .padding(Spacing.unit)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("session.autoExtendRow")
    }

    private func autoExtendSubtitle(_ policy: AutoExtendPolicy?) -> String {
        guard let policy else { return "Follows your spending limits" }
        guard policy.enabled else {
            return "You'll get a reminder before the meter runs out"
        }
        return "When you're far from the car: up to \(policy.maxCount) times, \(Format.minutes(policy.maxMinutesEach)) each"
    }

    private var extendTitle: String {
        let minutes = model.policyResponse?.policy.autoExtend.maxMinutesEach ?? 60
        return "Extend \(Format.minutes(minutes))"
    }
}

#if DEBUG
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
        maxStayReached: false
    )
    model.distanceFromCarMeters = 120
    return model
}
#endif
