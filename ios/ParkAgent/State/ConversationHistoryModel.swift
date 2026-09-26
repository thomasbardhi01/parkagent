import Foundation
import Observation

/// The assistant's saved conversations (server/API.md "Saved
/// conversations"): newest first, deleted one at a time or all at once.
@MainActor
@Observable
final class ConversationHistoryModel {
    private(set) var conversations: [ConversationSummary] = []
    private(set) var nextCursor: String?
    /// How long the server keeps a conversation after it was last used.
    private(set) var retentionDays = 90
    private(set) var loaded = false
    var errorText: String?

    func load(api: any APIClient) async {
        do {
            let page = try await api.conversations(cursor: nil)
            conversations = page.conversations
            nextCursor = page.nextCursor
            retentionDays = page.retentionDays
            errorText = nil
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? "Couldn't load your conversations."
        }
        loaded = true
    }

    func loadMore(api: any APIClient) async {
        guard let cursor = nextCursor else { return }
        guard let page = try? await api.conversations(cursor: cursor) else { return }
        conversations += page.conversations
        nextCursor = page.nextCursor
    }

    /// Optimistic: the row goes at once and comes back if the server says no.
    func delete(_ id: String, api: any APIClient) async {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        let removed = conversations.remove(at: index)
        do {
            try await api.deleteConversation(id: id)
        } catch {
            conversations.insert(removed, at: min(index, conversations.count))
            errorText = "Couldn't delete that conversation."
        }
    }

    func deleteAll(api: any APIClient) async {
        let before = conversations
        conversations = []
        nextCursor = nil
        do {
            _ = try await api.deleteAllConversations()
        } catch {
            conversations = before
            errorText = "Couldn't delete your conversations."
        }
    }
}
