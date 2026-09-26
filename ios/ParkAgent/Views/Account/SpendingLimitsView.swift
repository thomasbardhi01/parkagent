import SwiftUI

/// This user's own limits (GET/PUT /me/limits): per stop, per day, and the
/// default stay — anyone may set theirs, within the ceilings the server
/// sends. The operator's rules (rate ceiling, auto-extend, dry run) are
/// shown read-only below.
struct SpendingLimitsView: View {
    @Environment(AppModel.self) private var model

    /// nil until the limits load — made-up numbers are never shown, or
    /// saved over the real ones.
    @State private var draft: LimitsDraft?
    @State private var isSaving = false
    /// The exact reason the last save didn't happen.
    @State private var saveError: String?
    @State private var savedOK = false

    var body: some View {
        Form {
            if let draft {
                limitsSection(draft)
                saveSection
            } else {
                pendingSection
            }

            Section {
                if let response = model.policyResponse {
                    LabeledContent("Auto-pay rate limit", value: "\(Format.money(response.policy.autoPayMaxRatePerHour))/hr")
                    LabeledContent(
                        "Auto-extend",
                        value: response.policy.autoExtend.enabled
                            ? "Up to \(response.policy.autoExtend.maxCount)× \(Format.minutes(response.policy.autoExtend.maxMinutesEach))"
                            : "Off"
                    )
                    LabeledContent("Dry run", value: response.dryRun ? "On — no money moves" : "Off")
                }
            } header: {
                Text("Rules")
            } footer: {
                Text("Every automated decision is checked against these first.")
            }
        }
        .navigationTitle("Spending limits")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.loadLimits()
            if model.policyResponse == nil { await model.loadPolicy() }
        }
        // Seed when the limits arrive (or come back saved).
        .task(id: model.limitsResponse) {
            if let response = model.limitsResponse { draft = LimitsDraft(response) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("limits.view")
    }

    @ViewBuilder
    private var pendingSection: some View {
        Section {
            if model.limitsLoadFailed {
                Text(LimitsCopy.loadFailed)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("limits.unavailable")
                Button("Try again") { Task { await model.loadLimits() } }
                    .foregroundStyle(Color.actionCoralLink)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        } header: {
            Text("Your limits")
        }
    }

    private func limitsSection(_ draft: LimitsDraft) -> some View {
        Section {
            stepperRow("Per stop", value: Format.money(draft.sessionCapUsd), identifier: "limits.sessionCap", field: .sessionCap)
            stepperRow("Per day", value: Format.money(draft.dailyCapUsd), identifier: "limits.dailyCap", field: .dailyCap)
            stepperRow("Default stay", value: Format.minutes(draft.defaultStayMinutes), identifier: "limits.defaultStay", field: .defaultStay)
        } header: {
            Text("Your limits")
        } footer: {
            VStack(alignment: .leading, spacing: Spacing.half) {
                Text(LimitsCopy.preview(draft))
                    .accessibilityIdentifier("limits.preview")
                Text(LimitsCopy.ceilings(draft))
                    .accessibilityIdentifier("limits.ceilings")
            }
        }
    }

    private var saveSection: some View {
        Section {
            Button(isSaving ? "Saving…" : "Save limits") {
                Task { await save() }
            }
            .disabled(isSaving)
            .foregroundStyle(Color.actionCoralLink)
            .accessibilityIdentifier("limits.saveButton")
            if let saveError {
                Text(saveError)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.warningGold)
                    .accessibilityIdentifier("limits.saveFailed")
            }
            if savedOK {
                Text("Saved.")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.success)
                    .accessibilityIdentifier("limits.savedOK")
            }
        }
    }

    private func save() async {
        guard let draft else { return }
        isSaving = true
        saveError = nil
        savedOK = false
        saveError = await model.saveLimits(draft.limits)
        isSaving = false
        savedOK = saveError == nil
    }

    private func stepperRow(
        _ label: String,
        value: String,
        identifier: String,
        field: LimitsDraft.Field
    ) -> some View {
        HStack {
            Text(label)
                .font(.bodyText)
                .foregroundStyle(Color.textPrimary)
            Spacer()
            Button { draft?.step(field, up: false); savedOK = false } label: {
                Image(systemName: "minus.circle")
                    .foregroundStyle(Color.textSecondary)
                    // 44pt targets: the glyph alone is well under HIG size.
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(!(draft?.canStep(field, up: false) ?? false))
            .accessibilityIdentifier("\(identifier).minus")
            .accessibilityLabel("Decrease \(label)")
            Text(value)
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
                .frame(minWidth: 90)
                .accessibilityIdentifier(identifier)
                // VoiceOver reads the field with its value ("Per stop, $45").
                .accessibilityLabel("\(label), \(value)")
            Button { draft?.step(field, up: true); savedOK = false } label: {
                Image(systemName: "plus.circle")
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(!(draft?.canStep(field, up: true) ?? false))
            .accessibilityIdentifier("\(identifier).plus")
            .accessibilityLabel("Increase \(label)")
        }
    }
}

/// Plain-words help — what the app does, and what it never does.
struct HelpView: View {
    var body: some View {
        Form {
            Section("How it works") {
                helpRow("1", "You park", "Your phone notices the car stopped and you walked away.")
                helpRow("2", "We quote", "We look up the block's meter rate and what the stay costs.")
                helpRow("3", "We pay", "Through your own parking account, inside your limits.")
                helpRow("4", "We extend", "If a ticket would cost more than more time, we buy more time.")
            }
            Section {
                Text("We never see your parking provider's password — you sign in on their own page, and only the signed-in session is stored, encrypted.")
                Text("Nothing is charged while dry run is on.")
            } header: {
                Text("What we never do")
            }
        }
        .navigationTitle("How it works")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("help.view")
    }

    private func helpRow(_ number: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: Spacing.unit) {
            Text(number)
                .font(.bodyTextSemibold)
                .foregroundStyle(Color.actionCoral)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: Spacing.quarter) {
                Text(title)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                Text(detail)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack { SpendingLimitsView() }
        .environment(AppModel())
}
#endif
