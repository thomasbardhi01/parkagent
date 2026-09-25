import Foundation
import Observation
import UIKit
import UserNotifications

/// APNs registration and notification handling. The four server push types
/// (see server/API.md) all describe state the server already changed, so
/// handling is: show the banner in the foreground, and on tap just bring
/// the app up — Home and Active Session render from refreshed state.
@MainActor
@Observable
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    /// The most recent push, surfaced as an in-app notice.
    private(set) var lastNotice: String?

    /// Set by AppModel: a provider_relink push routes into the link flow.
    var onProviderRelink: ((String) -> Void)?
    /// A card_declined push opens the Wallet.
    var onOpenWallet: (() -> Void)?

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
            } catch APIError.notImplemented {
                // /device is a 501 stub until the server grows a devices
                // table; registration is re-sent on every launch anyway.
            } catch {
                // Same story for transient failures.
            }
        }
    }

    /// Matches the aps-environment entitlement (development until a
    /// distribution profile exists).
    private var apsEnvironment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    private func handle(type: String, provider: String?) {
        switch type {
        case "session_started": lastNotice = "Meter paid"
        case "session_extended": lastNotice = "Session extended"
        case "session_expiring": lastNotice = "Session expiring soon"
        case "payment_failed": lastNotice = "Payment failed — the meter is unpaid"
        case "provider_relink":
            lastNotice = "Your parking account needs a fresh sign-in"
            if let provider {
                onProviderRelink?(provider)
            }
        case "card_declined":
            // The fix is in the Wallet (update the card), not a retry.
            lastNotice = "Your card was declined — update it in Wallet"
            onOpenWallet?()
        default: break
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Pull the (Sendable) strings out before hopping actors — the raw
        // userInfo dictionary can't cross.
        let userInfo = notification.request.content.userInfo
        let type = userInfo["type"] as? String
        let provider = userInfo["provider"] as? String
        if let type {
            await MainActor.run { self.handle(type: type, provider: provider) }
        }
        return [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let type = userInfo["type"] as? String
        let provider = userInfo["provider"] as? String
        if let type {
            await MainActor.run { self.handle(type: type, provider: provider) }
        }
    }
}
