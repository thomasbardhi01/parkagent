import Foundation

/// Build-time configuration, injected via Config.xcconfig -> Info.plist.
/// Lets the app point at localhost, Fly, or a teammate's machine without code changes.
enum AppConfig {
    static var apiBaseURL: URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String,
              !raw.isEmpty
        else { return nil }
        return URL(string: raw)
    }
}
