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

    private var api: (any APIClient)?
    private var pendingToken: String?

    private override init() {
        super.init()
    }

    func activate(api: any APIClient) {
        self.api = api
        UNUserNotificationCenter.current().delegate = self
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

    /// Matches the aps-environment entitlement: Debug builds from Xcode
    /// register with APNs' sandbox; Release (TestFlight, App Store) is
    /// signed for production. The server picks the host per token.
    private var apsEnvironment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    /// A TAPPED push: take the driver where the push is about. Never on
    /// arrival — a banner that yanked the app into the link flow or the
    /// Wallet mid-payment was worse than the problem it announced.
    private func open(type: String, provider: String?, deepLink: String?) {
        switch type {
        case "provider_relink":
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
        if let type {
            await MainActor.run { self.open(type: type, provider: provider, deepLink: deepLink) }
        }
    }
}
