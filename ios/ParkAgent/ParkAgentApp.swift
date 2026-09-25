import SwiftUI
import UIKit

@main
struct ParkAgentApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @AppStorage(AppearanceSetting.defaultsKey) private var appearanceRaw = AppearanceSetting.system.rawValue

    init() {
        LaunchOverrides.applyToDefaults()
        StripeWallet.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(
                    (AppearanceSetting(rawValue: appearanceRaw) ?? .system).colorScheme
                )
        }
    }
}

/// Only exists because APNs token delivery has no SwiftUI surface.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushManager.shared.deviceTokenReceived(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        // Expected on the simulator; a phone retries on next launch.
    }
}
