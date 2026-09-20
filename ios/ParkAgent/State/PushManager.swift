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

    private func handle(type: String) {
        switch type {
        case "session_started": lastNotice = "Meter paid"
        case "session_extended": lastNotice = "Session extended"
        case "session_expiring": lastNotice = "Session expiring soon"
        case "payment_failed": lastNotice = "Payment failed — the meter is unpaid"
        default: break
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let type = notification.request.content.userInfo["type"] as? String
        if let type {
            await MainActor.run { self.handle(type: type) }
        }
        return [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let type = response.notification.request.content.userInfo["type"] as? String
        if let type {
            await MainActor.run { self.handle(type: type) }
        }
    }
}
