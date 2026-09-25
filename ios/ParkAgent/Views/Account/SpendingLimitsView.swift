import SwiftUI

/// The caps. PUT /policy is admin-only on the server (the policy is the
/// shared spending contract), so only the operator gets steppers and Save;
/// everyone else sees the same values, read-only, and why.
struct SpendingLimitsView: View {
    @Environment(AppModel.self) private var model

    private var editable: Bool { model.policyResponse?.canEdit ?? true }

    @State private var sessionCap: Double = 45
    @State private var dailyCap: Double = 60
    @State private var defaultMinutes: Int = 90
    @State private var seeded = false
    @State private var isSaving = false
    @State private var saveFailed = false
    @State private var savedOK = false

    var body: some View {
        Form {
            Section {
                stepperRow(
                    "Per stop",
                    value: Format.money(sessionCap),
                    identifier: "limits.sessionCap",
                    decrement: { sessionCap = max(5, sessionCap - 5) },
                    increment: { sessionCap = min(200, sessionCap + 5) }
                )
                stepperRow(
                    "Per day",
                    value: Format.money(dailyCap),
                    identifier: "limits.dailyCap",
                    decrement: { dailyCap = max(5, dailyCap - 5) },
                    increment: { dailyCap = min(400, dailyCap + 5) }
                )
                stepperRow(
                    "Default stay",
                    value: Format.minutes(defaultMinutes),
                    identifier: "limits.defaultStay",
                    decrement: { defaultMinutes = max(15, defaultMinutes - 15) },
                    increment: { defaultMinutes = min(240, defaultMinutes + 15) }
                )
            } header: {
                Text("Limits")
            } footer: {
                VStack(alignment: .leading, spacing: Spacing.half) {
                    Text("We'll pay up to \(Format.money(sessionCap)) per stop and \(Format.money(dailyCap)) per day without asking.")
                        .accessibilityIdentifier("limits.preview")
                    if !editable {
                        Text(SharedLimitsCopy.note)
                            .accessibilityIdentifier("limits.shared")
                    }
                }
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

            if editable {
                saveSection
            }
        }
        .navigationTitle("Spending limits")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard !seeded, let policy = model.policyResponse?.policy else { return }
            seeded = true
            sessionCap = policy.sessionCapUsd
            dailyCap = policy.dailyCapUsd
            defaultMinutes = policy.defaultStayMinutes
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("limits.view")
    }

    private var saveSection: some View {
        Section {
            Button(isSaving ? "Saving…" : "Save limits") {
                Task { await save() }
            }
            .disabled(isSaving)
            .foregroundStyle(Color.actionCoralLink)
            .accessibilityIdentifier("limits.saveButton")
            if saveFailed {
                Text("Couldn't save. Check the connection and try again.")
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
        isSaving = true
        saveFailed = false
        savedOK = false
        let ok = await model.saveBudget(
            sessionCapUsd: sessionCap,
            dailyCapUsd: dailyCap,
            defaultStayMinutes: defaultMinutes
        )
        isSaving = false
        saveFailed = !ok
        savedOK = ok
    }

    private func stepperRow(
        _ label: String,
        value: String,
        identifier: String,
        decrement: @escaping () -> Void,
        increment: @escaping () -> Void
    ) -> some View {
        HStack {
            Text(label)
                .font(.bodyText)
                .foregroundStyle(Color.textPrimary)
            Spacer()
            if editable {
                Button(action: decrement) {
                    Image(systemName: "minus.circle")
                        .foregroundStyle(Color.textSecondary)
                        // 44pt targets: the glyph alone is well under HIG size.
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("\(identifier).minus")
                .accessibilityLabel("Decrease \(label)")
            }
            Text(value)
                .font(.bodyTextSemibold)
                .monospacedDigit()
                .foregroundStyle(Color.textPrimary)
                .frame(minWidth: 90)
                .accessibilityIdentifier(identifier)
                // VoiceOver reads the field with its value ("Per stop, $45").
                .accessibilityLabel("\(label), \(value)")
            if editable {
                Button(action: increment) {
                    Image(systemName: "plus.circle")
                        .foregroundStyle(Color.textSecondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("\(identifier).plus")
                .accessibilityLabel("Increase \(label)")
            }
        }
    }
}

/// Said wherever a non-operator sees the limits (onboarding's budget step,
/// this screen), so the two never disagree.
enum SharedLimitsCopy {
    static let note = "These limits are the same for everyone while ParkAgent is in beta. They cap what ParkAgent can spend for you."
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
