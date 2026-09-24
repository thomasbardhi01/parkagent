import Foundation

enum FeatureFlags {
    /// Apple Pay push provisioning. Requires the
    /// com.apple.developer.payment-pass-provisioning entitlement, which
    /// Apple grants after an application through Stripe — off until that
    /// lands, and the Card tab shows a "coming soon" state instead. Backed
    /// by UserDefaults so the debug menu and UI tests can flip it without
    /// a rebuild.
    static var applePayProvisioning: Bool {
        UserDefaults.standard.bool(forKey: applePayProvisioningKey)
    }

    static let applePayProvisioningKey = "applePayProvisioningEnabled"

    /// "Continue with Google" on the welcome screen. Off by default: the
    /// server gates it too (GOOGLE_SIGNIN_ENABLED), and the App Store
    /// requires Sign in with Apple wherever Google is offered — which we
    /// satisfy, since Apple is the primary button either way. Turning this
    /// on for real also means adding the GoogleSignIn-iOS SDK to
    /// project.yml to mint the id token.
    static var googleSignIn: Bool {
        UserDefaults.standard.bool(forKey: googleSignInKey)
    }

    static let googleSignInKey = "googleSignInEnabled"
}
