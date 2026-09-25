import Foundation

enum FeatureFlags {
    /// Apple Pay push provisioning ("Add to Apple Wallet" for the ParkAgent
    /// card). Requires the com.apple.developer.payment-pass-provisioning
    /// entitlement, which Apple grants after an application through Stripe
    /// — off until that lands, and the Wallet shows "coming soon" instead.
    /// A constant on purpose: nothing can turn it on at run time, so
    /// turning it on is a code change made together with the entitlement
    /// (see AddToWalletButton.swift and CLAUDE.md).
    static let applePayProvisioning = false

    #if DEBUG
    /// Whether this BUILD can do Google sign-in — never, until the
    /// GoogleSignIn-iOS SDK is added to project.yml to mint the id token.
    /// Until then the Google path is test-only (`-googleSignIn YES` against
    /// the mock), and a Release build has none of it. The button also needs
    /// the server reporting Google on (GET /auth/methods,
    /// GOOGLE_SIGNIN_ENABLED). The App Store requires Sign in with Apple
    /// wherever Google is offered; Apple always leads.
    static var googleSignIn: Bool {
        UserDefaults.standard.bool(forKey: googleSignInKey)
    }

    static let googleSignInKey = "googleSignInEnabled"

    /// Diagnostics' "ParkAgent card sandbox" toggle (off by default): lets a
    /// Debug build choose the ParkAgent card before it's live
    /// (ISSUING_LIVE), and only when the server says its Stripe key is
    /// test-mode (the option's `sandbox` flag) — so no real money can move.
    static var parkAgentSandbox: Bool {
        UserDefaults.standard.bool(forKey: parkAgentSandboxKey)
    }

    static let parkAgentSandboxKey = "parkAgentSandbox"
    #else
    static let googleSignIn = false
    /// A Release build always shows "Coming soon — pending approval" until
    /// the ParkAgent card is live.
    static let parkAgentSandbox = false
    #endif
}
