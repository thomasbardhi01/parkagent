import Foundation

enum FeatureFlags {
    /// Apple Pay push provisioning. Requires the
    /// com.apple.developer.payment-pass-provisioning entitlement, which
    /// Apple grants after an application through Stripe — off until that
    /// lands, and the Wallet shows a "coming soon" state instead. Backed
    /// by UserDefaults so the debug menu and UI tests can flip it without
    /// a rebuild.
    static var applePayProvisioning: Bool {
        UserDefaults.standard.bool(forKey: applePayProvisioningKey)
    }

    static let applePayProvisioningKey = "applePayProvisioningEnabled"

    /// Whether this BUILD can do Google sign-in — off until the
    /// GoogleSignIn-iOS SDK is added to project.yml to mint the id token.
    /// The button needs this AND the server reporting Google on
    /// (GET /auth/methods, GOOGLE_SIGNIN_ENABLED). The App Store requires
    /// Sign in with Apple wherever Google is offered; Apple always leads.
    static var googleSignIn: Bool {
        UserDefaults.standard.bool(forKey: googleSignInKey)
    }

    static let googleSignInKey = "googleSignInEnabled"

    /// Whether this build may choose the ParkAgent card in SANDBOX before
    /// it's live (ISSUING_LIVE): Debug builds only, and only when the server
    /// says its Stripe key is test-mode (the option's `sandbox` flag) — so
    /// no real money can move. A Release build always shows "Coming soon —
    /// pending approval" until the card is live.
    static var parkAgentSandbox: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }
}
