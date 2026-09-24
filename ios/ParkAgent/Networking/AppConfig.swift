import Foundation

/// Build-time configuration, injected via Config.xcconfig -> Info.plist.
/// Lets the app point at localhost, Fly, or a teammate's machine without
/// code changes.
///
/// There is no API key here any more: the app authenticates as the signed-in
/// user with a JWT from the Keychain (see AuthStore). API keys are the
/// server's admin/script credential now.
enum AppConfig {
    static var apiBaseURL: URL? {
        guard let raw = infoString("API_BASE_URL") else { return nil }
        return URL(string: raw)
    }

    /// Stripe publishable key (pk_test_…), needed only for the live Apple
    /// Pay / card top-up confirmation. The mock and dry-run paths never
    /// reach the Stripe SDK.
    static var stripePublishableKey: String? {
        infoString("STRIPE_PUBLISHABLE_KEY")
    }

    private static func infoString(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !raw.isEmpty
        else { return nil }
        return raw
    }
}
