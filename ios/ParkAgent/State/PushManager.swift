import CoreLocation
import Foundation
import Observation
import UIKit
import UserNotifications

/// APNs registration and notification handling. The server's pushes (see
/// server/API.md "Pushes") all describe state the server already changed,
/// so handling is: show the banner in the foreground, and on a tap bring
/// the app up where the push is about — Home and Active Session render
/// from refreshed state.
@MainActor
@Observable
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    /// Set by AppModel: a provider_relink push routes into the link flow.
    var onProviderRelink: ((String) -> Void)?
    /// A card_declined push opens the Wallet.
    var onOpenWallet: (() -> Void)?
    /// Every other push about the car opens the Park tab.
    var onOpenPark: (() -> Void)?
    /// A button on a place prompt (ParkedNotice.Action): which park it
    /// answers about, and where that park was. Wired when detection arms,
    /// so it is there for a background launch too.
    var onPlaceAction: ((ParkedNotice.Action, String, CLLocationCoordinate2D?) async -> Void)? {
        didSet { replayPendingPlaceAction() }
    }

    private var api: (any APIClient)?
    private var pendingToken: String?
    /// A tap that arrived before AppModel wired the handlers above (a cold
    /// launch from the notification); replayed once they are.
    private var pendingOpen: (type: String, provider: String?, deepLink: String?)?
    private var pendingPlaceAction: (action: ParkedNotice.Action, parkedEventId: String, coordinate: CLLocationCoordinate2D?)?

    private override init() {
        super.init()
    }

    /// Every launch, before it finishes (AppServices): iOS hands a
    /// notification's tapped button only to a delegate that is already
    /// set, and may have launched the app in the background just for it.
    /// Asks for nothing: permission is `activate`'s to request.
    func attach() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(ParkedNotice.notificationCategories)
    }

    func activate(api: any APIClient) {
        self.api = api
        attach()
        Task {
            let granted = try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            if granted == true {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
        if let pendingToken {
            sendToken(pendingToken)
        }
    }

    /// Called by the AppDelegate with the raw APNs token.
    func deviceTokenReceived(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        if api == nil {
            pendingToken = token
        } else {
            sendToken(token)
        }
    }

    private func sendToken(_ token: String) {
        guard let api else { return }
        pendingToken = nil
        Task {
            do {
                try await api.registerDevice(DeviceRegistration(
                    token: token,
                    platform: "ios",
                    environment: apsEnvironment
                ))
            } catch {
                // Registration is re-sent on every launch; a transient
                // failure costs nothing but a missed push until then.
            }
        }
    }

    /// From the build's own signing, not its configuration (see
    /// APNsEnvironment): the server picks the APNs host per token from it.
    private var apsEnvironment: String { APNsEnvironment.current }

    /// A TAPPED push: take the driver where the push is about. Never on
    /// arrival — a banner that yanked the app into the link flow or the
    /// Wallet mid-payment was worse than the problem it announced.
    private func open(type: String, provider: String?, deepLink: String?) {
        guard onOpenPark != nil else {
            pendingOpen = (type, provider, deepLink)
            return
        }
        switch type {
        case "provider_relink", "provider_link_failed":
            // Sign in again, or retry a link the provider let time out.
            if let provider { onProviderRelink?(provider) }
        case "card_declined":
            // The fix is in the Wallet (update the card), not a retry.
            onOpenWallet?()
        case "itinerary_garage_link":
            // The garage's own checkout or pass, for the entrance.
            if let deepLink, let url = URL(string: deepLink), url.scheme == "https" {
                UIApplication.shared.open(url)
            }
        default:
            // Paid, extended, expiring, failed, free: all about the car on
            // the Park tab (the active session, or the zone number to pay
            // in the provider's app).
            onOpenPark?()
        }
    }

    func replayPendingOpen() {
        guard let pending = pendingOpen else { return }
        pendingOpen = nil
        open(type: pending.type, provider: pending.provider, deepLink: pending.deepLink)
    }

    /// A place prompt's button. The answer is recorded whether or not the
    /// app is on screen; "Not a garage" also brings the Park tab up.
    private func placeAction(_ action: ParkedNotice.Action, parkedEventId: String, coordinate: CLLocationCoordinate2D?) async {
        guard let onPlaceAction else {
            pendingPlaceAction = (action, parkedEventId, coordinate)
            return
        }
        await onPlaceAction(action, parkedEventId, coordinate)
    }

    /// Which place button a notification response is, and the park it is
    /// about (ParkedNotice.post puts the park's id and spot in userInfo).
    /// nil for a tap on the notification itself, and for a button with no
    /// park to answer about.
    nonisolated static func placeAction(
        identifier: String,
        userInfo: [AnyHashable: Any]
    ) -> (action: ParkedNotice.Action, parkedEventId: String, coordinate: CLLocationCoordinate2D?)? {
        guard let action = ParkedNotice.Action(rawValue: identifier),
              let parkedEventId = userInfo["parkedEventId"] as? String, !parkedEventId.isEmpty
        else { return nil }
        var coordinate: CLLocationCoordinate2D?
        if let lat = userInfo["lat"] as? Double, let lng = userInfo["lng"] as? Double {
            coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
        }
        return (action, parkedEventId, coordinate)
    }

    private func replayPendingPlaceAction() {
        guard let onPlaceAction, let pending = pendingPlaceAction else { return }
        pendingPlaceAction = nil
        Task { await onPlaceAction(pending.action, pending.parkedEventId, pending.coordinate) }
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // In the foreground the banner is enough; the driver taps it (or
        // doesn't) — see `open`.
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        // Pull the (Sendable) strings out before hopping actors — the raw
        // userInfo dictionary can't cross.
        let userInfo = response.notification.request.content.userInfo
        let type = userInfo["type"] as? String
        let provider = userInfo["provider"] as? String
        let deepLink = userInfo["deepLink"] as? String
        // A button on a place prompt, rather than the notification itself.
        if let tapped = Self.placeAction(identifier: response.actionIdentifier, userInfo: userInfo) {
            // iOS keeps a background launch alive until this returns.
            await placeAction(tapped.action, parkedEventId: tapped.parkedEventId, coordinate: tapped.coordinate)
            return
        }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        if let type {
            await MainActor.run { self.open(type: type, provider: provider, deepLink: deepLink) }
        }
    }
}
