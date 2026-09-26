// UI tests and SwiftUI previews only — compiled out of Release builds with
// the rest of the mock server (ParkAgentReleaseTests proves it).
#if DEBUG
import Foundation

/// The mock's saved conversations: two seeded past ones (so the history
/// list has something to show from launch) plus whatever this run's chat
/// says, newest first — the server's order.
actor MockConversationStore {
    static let shared = MockConversationStore()

    private struct Saved {
        var id: String
        var title: String
        var createdAt: Date
        var updatedAt: Date
        var messages: [ConversationMessage]
        var plans: [StoredPlan]
        var outcome: ConversationOutcome?
    }

    private var saved: [Saved] = MockConversationStore.seed()
    private var nextId = 1

    func list() -> ConversationsResponse {
        ConversationsResponse(
            conversations: saved
                .sorted { $0.updatedAt > $1.updatedAt }
                .map {
                    ConversationSummary(
                        id: $0.id, title: $0.title, createdAt: $0.createdAt, updatedAt: $0.updatedAt,
                        messageCount: $0.messages.count, outcome: $0.outcome
                    )
                },
            nextCursor: nil,
            retentionDays: 90
        )
    }

    func detail(id: String) -> ConversationDetail? {
        guard let s = saved.first(where: { $0.id == id }) else { return nil }
        return ConversationDetail(id: s.id, title: s.title, messages: s.messages, plans: s.plans, outcome: s.outcome)
    }

    func delete(id: String) -> Bool {
        let before = saved.count
        saved.removeAll { $0.id == id }
        return saved.count < before
    }

    func deleteAll() -> Int {
        defer { saved.removeAll() }
        return saved.count
    }

    /// A new conversation's id, like the server's conv_… ids.
    func newId() -> String {
        defer { nextId += 1 }
        return "mock-conv-\(nextId)"
    }

    /// One turn, as the server's loop records it.
    func record(
        conversationId: String,
        userText: String,
        reply: String,
        plan: AssistantReply.ProposedPlan?,
        suggestions: [AssistantSuggestion]?
    ) {
        let now = AppClock.now
        let turn = [
            ConversationMessage(role: "user", text: userText, planId: nil, suggestions: nil),
            ConversationMessage(role: "assistant", text: reply, planId: plan?.planId, suggestions: suggestions),
        ]
        let stored = plan.map { [StoredPlan(planId: $0.planId, plan: $0.plan, confirmedAt: nil, confirmedOptionId: nil)] } ?? []
        if let index = saved.firstIndex(where: { $0.id == conversationId }) {
            saved[index].messages += turn
            saved[index].plans += stored
            saved[index].updatedAt = now
        } else {
            saved.append(Saved(
                id: conversationId, title: userText, createdAt: now, updatedAt: now,
                messages: turn, plans: stored, outcome: nil
            ))
        }
    }

    private static func seed() -> [Saved] {
        let now = AppClock.now
        let street = MockAssistantFixtures.singleSpotPlan
        let later = MockAssistantFixtures.futureStreetPlan
        return [
            Saved(
                id: "mock-history-mfa",
                title: "Park me near the MFA for 90 minutes",
                createdAt: now.addingTimeInterval(-2 * 86_400),
                updatedAt: now.addingTimeInterval(-2 * 86_400),
                messages: [
                    ConversationMessage(role: "user", text: "Park me near the MFA for 90 minutes", planId: nil, suggestions: nil),
                    ConversationMessage(
                        role: "assistant", text: "Two garages and a meter nearby. Street is cheapest.",
                        planId: street.planId, suggestions: nil
                    ),
                    ConversationMessage(
                        role: "assistant",
                        text: "Zone 81234 is set for 90 min — the session starts when you park there.",
                        planId: nil, suggestions: nil
                    ),
                ],
                plans: [StoredPlan(
                    planId: street.planId, plan: street.plan,
                    confirmedAt: now.addingTimeInterval(-2 * 86_400), confirmedOptionId: "opt-street"
                )],
                outcome: ConversationOutcome(kind: "street", label: "Street — Boylston St", amountUsd: 4.10, planId: street.planId)
            ),
            Saved(
                id: "mock-history-fenway",
                title: "Garage near Fenway Saturday at 7",
                createdAt: now.addingTimeInterval(-86_400),
                updatedAt: now.addingTimeInterval(-86_400),
                messages: [
                    ConversationMessage(role: "user", text: "Garage near Fenway Saturday at 7", planId: nil, suggestions: nil),
                    ConversationMessage(
                        role: "assistant", text: "Saturday at 7 near Fenway — the meter is cheapest.",
                        planId: later.planId, suggestions: nil
                    ),
                ],
                plans: [StoredPlan(planId: later.planId, plan: later.plan, confirmedAt: nil, confirmedOptionId: nil)],
                outcome: ConversationOutcome(
                    kind: "proposed", label: "2 options proposed, from $7.50", amountUsd: nil, planId: later.planId
                )
            ),
        ]
    }
}

extension MockAPI {
    func conversations(cursor: String?) async throws -> ConversationsResponse {
        await MockConversationStore.shared.list()
    }

    func conversation(id: String) async throws -> ConversationDetail {
        guard let detail = await MockConversationStore.shared.detail(id: id) else {
            throw APIError.server(status: 404)
        }
        return detail
    }

    func deleteConversation(id: String) async throws {
        guard await MockConversationStore.shared.delete(id: id) else { throw APIError.server(status: 404) }
    }

    func deleteAllConversations() async throws -> Int {
        await MockConversationStore.shared.deleteAll()
    }
}
#endif
