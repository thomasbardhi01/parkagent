import SwiftUI
import UIKit
import UserNotifications

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

/// Only exists because APNs token delivery and the notification delegate
/// have no SwiftUI surface.
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// Apple's rule: set the notification delegate before launch finishes,
    /// or a tap that launched the app is never delivered.
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = PushManager.shared
        // iOS relaunched us for a location event (a significant move, a
        // visit), often with no screen at all: re-arm park detection here,
        // because no view will. Any other launch re-arms it too.
        let locationLaunch = launchOptions?[.location] != nil
        MainActor.assumeIsolated {
            AppServices.shared.applicationDidFinishLaunching(locationLaunch: locationLaunch)
        }
        return true
    }

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
