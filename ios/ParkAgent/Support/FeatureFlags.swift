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
}
