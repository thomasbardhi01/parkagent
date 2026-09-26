import Foundation

/// The app's long-lived objects, owned outside any SwiftUI scene.
///
/// When iOS relaunches ParkAgent in the background for a location event
/// (a significant move, a visit), no window and no RootView are created,
/// so nothing a view owns can re-arm park detection. The app delegate
/// reaches the same instances through here that RootView shows, so a
/// background launch and a normal one share one detector, one session
/// store, and one permissions reader.
@MainActor
final class AppServices {
    static let shared = AppServices()

    let authStore: AuthStore
    let permissions: PermissionsManager
    let model: AppModel

    private var sessionRestored = false

    private init() {
        // One store, shared: AppModel reads tokens through it and AuthModel
        // writes them. A second instance would mint a second device id.
        authStore = AuthStore()
        permissions = PermissionsManager()
        model = AppModel(authStore: authStore, permissions: permissions)
    }

    /// Read the Keychain and wire the refresh transport, once per process,
    /// before anything makes a protected request.
    func restoreSessionOnce() {
        guard !sessionRestored else { return }
        sessionRestored = true
        model.restoreSession()
    }

    /// Every launch, from the app delegate. `locationLaunch` is iOS
    /// relaunching us for a location event: re-arm detection (the event
    /// itself is delivered to the detector's fresh location manager).
    func applicationDidFinishLaunching(locationLaunch: Bool) {
        restoreSessionOnce()
        model.resumeDetectionIfArmed(reason: locationLaunch ? .locationLaunch : .arm)
    }
}
