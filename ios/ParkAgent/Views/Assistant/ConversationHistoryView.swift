import SwiftUI

/// Saved conversations, newest first: each titled by its first request,
/// dated, and showing what it came to (a booking or plan). Tap to open —
/// read it, or keep going; swipe to delete; "Delete all" clears them.
struct ConversationHistoryView: View {
    @Environment(AppModel.self) private var appModel
    let history: ConversationHistoryModel
    /// The conversation on screen in the sheet, marked in the list.
    let currentId: String?
    let onOpen: (String) -> Void
    /// A conversation was deleted (nil: all of them).
    var onDeleted: (String?) -> Void = { _ in }

    @State private var confirmingDeleteAll = false

    var body: some View {
        Group {
            if history.conversations.isEmpty && history.loaded {
                EmptyStateView(
                    icon: "bubble.left.and.bubble.right",
                    title: "No saved conversations",
                    message: "Your conversations with ParkAgent are kept here for \(history.retentionDays) days."
                )
                .accessibilityIdentifier("assistant.history.empty")
            } else if !history.loaded {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list
            }
        }
        .navigationTitle("Conversations")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !history.conversations.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Delete all", role: .destructive) { confirmingDeleteAll = true }
                        .accessibilityIdentifier("assistant.history.deleteAll")
                }
            }
        }
        .confirmationDialog(
            "Delete all conversations?",
            isPresented: $confirmingDeleteAll,
            titleVisibility: .visible
        ) {
            Button("Delete all", role: .destructive) {
                Task {
                    await history.deleteAll(api: appModel.api)
                    onDeleted(nil)
                }
            }
            .accessibilityIdentifier("assistant.history.confirmDeleteAll")
        } message: {
            Text("Bookings and plans stay in Activity.")
        }
        .task { await history.load(api: appModel.api) }
        .refreshable { await history.load(api: appModel.api) }
    }

    private var list: some View {
        List {
            Section {
                ForEach(history.conversations) { conversation in
                    Button { onOpen(conversation.id) } label: {
                        row(conversation)
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("assistant.history.row.\(conversation.id)")
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                await history.delete(conversation.id, api: appModel.api)
                                onDeleted(conversation.id)
                            }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
                if history.nextCursor != nil {
                    Button("Load more") { Task { await history.loadMore(api: appModel.api) } }
                }
            } footer: {
                Text("Conversations are kept for \(history.retentionDays) days after you last use them.")
                    .accessibilityIdentifier("assistant.history.retention")
            }
            if let error = history.errorText {
                Text(error)
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .listStyle(.insetGrouped)
    }

    private func row(_ conversation: ConversationSummary) -> some View {
        VStack(alignment: .leading, spacing: Spacing.quarter) {
            HStack(alignment: .firstTextBaseline) {
                Text(conversation.title)
                    .font(.bodyText)
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: Spacing.half)
                Text(Format.dayAndTime(conversation.updatedAt))
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
            if let outcome = conversation.outcome {
                Label(outcomeText(outcome), systemImage: outcomeIcon(outcome))
                    .font(.captionText)
                    .foregroundStyle(outcome.kind == "proposed" ? Color.textSecondary : Color.success)
            }
            if conversation.id == currentId {
                Text("Open now")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.actionCoralLink)
            }
        }
        .padding(.vertical, Spacing.quarter)
        .contentShape(Rectangle())
    }

    private func outcomeText(_ outcome: ConversationOutcome) -> String {
        guard let amount = outcome.amountUsd else { return outcome.label }
        return "\(outcome.label) · \(Format.money(amount))"
    }

    private func outcomeIcon(_ outcome: ConversationOutcome) -> String {
        switch outcome.kind {
        case "garage": "building.2"
        case "street": "parkingsign"
        case "itinerary": "calendar"
        default: "list.bullet"
        }
    }
}

/// A plan from earlier in an opened conversation: what was offered and
/// what the user chose — read-only. Its prices were for then; asking
/// again gets today's.
struct StoredPlanCard: View {
    let stored: StoredPlan

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            switch stored.plan {
            case .singleSpot(let plan):
                ForEach(plan.options) { option in
                    HStack(spacing: Spacing.half) {
                        Image(systemName: option.type == "garage" ? "building.2.fill" : "parkingsign")
                            .font(.captionText)
                            .foregroundStyle(Color.textSecondary)
                        Text(option.label)
                            .font(.secondaryText)
                            .foregroundStyle(Color.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: Spacing.half)
                        if option.id == stored.confirmedOptionId {
                            Label("Chosen", systemImage: "checkmark.circle.fill")
                                .font(.captionTextSemibold)
                                .foregroundStyle(Color.success)
                        }
                        Text(Format.money(option.priceUsd))
                            .font(.secondaryText)
                            .monospacedDigit()
                            .foregroundStyle(Color.textPrimary)
                    }
                }
            case .itinerary(let day):
                HStack {
                    Label("Day plan — \(day.stops.count) stops", systemImage: "calendar")
                        .font(.secondaryText)
                    Spacer()
                    if stored.confirmedAt != nil {
                        Label("Signed off", systemImage: "checkmark.circle.fill")
                            .font(.captionTextSemibold)
                            .foregroundStyle(Color.success)
                    }
                    Text(Format.money(day.totalUsd)).font(.secondaryText).monospacedDigit()
                }
            }
            Text("Prices were for then — ask again for today's.")
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .opacity(0.9)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistant.storedPlan.\(stored.planId)")
    }
}
