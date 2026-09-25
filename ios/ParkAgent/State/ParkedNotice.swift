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
        let zone = "Parked in zone \(candidate.providerZoneNumber)"
        // Parks the sheet can't pay as-is: say what's in the way instead of
        // inviting a payment the server will refuse.
        if response.provider?.linked == false {
            let name = response.provider?.displayName ?? "your parking account"
            return Content(title: zone, body: "Connect \(name) in ParkAgent to pay here, or pay at the meter.\(dryRun)")
        }
        if response.rule == "session_cap_exceeded" || response.rule == "daily_cap_exceeded" {
            let limit = response.rule == "daily_cap_exceeded" ? "today's limit" : "your per-stop limit"
            return Content(
                title: zone,
                body: "\(Format.money(quote.totalUsd)) is over \(limit), so ParkAgent won't pay it. Pay at the meter or in your parking app.\(dryRun)"
            )
        }
        let choice = response.candidates.count > 1 ? " Pick the side of the street you're on." : ""
        return Content(
            title: "Parked in zone \(candidate.providerZoneNumber)",
            body: "Pay \(Format.money(quote.totalUsd)) for \(Format.minutes(quote.stayMinutes)) — open ParkAgent to confirm.\(choice)\(dryRun)"
        )
    }

    /// The push/notification `type` a tap routes on (PushManager → Park tab).
    static let type = "parked"

    /// Paid, dismissed, or signed out: the notification is stale.
    static func withdraw() {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [type])
    }

    // MARK: - Surviving the process

    /// The pending park, kept on disk for a while: iOS may end a
    /// backgrounded app after the notification is posted, and a tap must
    /// still land on the sheet it promised.
    private static let storeKey = "pendingParked"
    static let freshFor: TimeInterval = 30 * 60

    private struct Stored: Codable {
        let savedAt: Date
        let response: ParkedResponse
    }

    static func store(_ response: ParkedResponse?) {
        let defaults = UserDefaults.standard
        guard let response else {
            defaults.removeObject(forKey: storeKey)
            return
        }
        // The same park again (restored at launch): keep its original time,
        // or every relaunch would make a stale park fresh.
        if let data = defaults.data(forKey: storeKey),
           let stored = try? JSONDecoder().decode(Stored.self, from: data),
           stored.response.parkedEventId == response.parkedEventId {
            return
        }
        guard let data = try? JSONEncoder().encode(Stored(savedAt: AppClock.now, response: response)) else { return }
        defaults.set(data, forKey: storeKey)
    }

    /// The stored park if it's still fresh; a stale one is dropped.
    static func restore() -> ParkedResponse? {
        let defaults = UserDefaults.standard
        guard let data = defaults.data(forKey: storeKey),
              let stored = try? JSONDecoder().decode(Stored.self, from: data)
        else { return nil }
        guard AppClock.now.timeIntervalSince(stored.savedAt) < freshFor else {
            defaults.removeObject(forKey: storeKey)
            return nil
        }
        return stored.response
    }

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
