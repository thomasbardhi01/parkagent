import Foundation
import UserNotifications

/// A park detected while the app is in the background. The detector posts
/// /parked and the Parked sheet is waiting on the Park tab, but nothing
/// told the driver — they walked away from an unpaid meter unless they
/// happened to open the app. This local notification does (time-sensitive:
/// the meter is running), and tapping it lands on the waiting sheet.
///
/// Only when there is something to pay: a park at an unmetered spot or in
/// a free period stays silent, so parking at home doesn't nag every time.
enum ParkedNotice {
    struct Content: Equatable {
        let title: String
        let body: String
    }

    /// nil → nothing worth interrupting for.
    static func content(for response: ParkedResponse) -> Content? {
        guard response.action == .pay || response.action == .confirm,
              let candidate = response.candidates.first
        else { return nil }
        let dryRun = response.dryRun ? " Dry run — nothing will be charged." : ""
        if response.needsZoneNumber {
            return Content(
                title: "Parked — zone number needed",
                body: "Open ParkAgent and type the zone number from the meter to pay.\(dryRun)"
            )
        }
        let quote = response.quote ?? candidate.quote
        let choice = response.candidates.count > 1 ? " Pick the side of the street you're on." : ""
        return Content(
            title: "Parked in zone \(candidate.providerZoneNumber)",
            body: "Pay \(Format.money(quote.totalUsd)) for \(Format.minutes(quote.stayMinutes)) — open ParkAgent to confirm.\(choice)\(dryRun)"
        )
    }

    /// The push/notification `type` a tap routes on (PushManager → Park tab).
    static let type = "parked"

    static func post(for response: ParkedResponse) async {
        guard let content = content(for: response) else { return }
        let notification = UNMutableNotificationContent()
        notification.title = content.title
        notification.body = content.body
        notification.sound = .default
        notification.interruptionLevel = .timeSensitive
        notification.userInfo = ["type": type]
        // One identifier: a newer park replaces an older, unanswered one.
        let request = UNNotificationRequest(identifier: type, content: notification, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
