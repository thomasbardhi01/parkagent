import AppIntents

/// "Ask ParkAgent" from Siri and Shortcuts: opens the app straight into
/// the assistant sheet, optionally carrying the spoken question. The
/// assistant itself runs server-side; the intent only routes.
struct AskParkAgentIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask ParkAgent"
    static let description = IntentDescription(
        "Ask the parking assistant to find a spot or plan your day of stops."
    )
    static let openAppWhenRun = true

    @Parameter(title: "Question", requestValueDialog: "What should I ask about parking?")
    var question: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        AssistantIntentRouter.shared.pendingQuery = question ?? ""
        return .result()
    }
}

struct ParkAgentShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskParkAgentIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) about parking",
                "Plan my parking with \(.applicationName)",
            ],
            shortTitle: "Ask ParkAgent",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
    }
}

/// The intent runs before the SwiftUI scene has the AppModel in hand, so
/// the query parks here; RootView drains it on foreground.
@MainActor
final class AssistantIntentRouter {
    static let shared = AssistantIntentRouter()
    var pendingQuery: String?
}
