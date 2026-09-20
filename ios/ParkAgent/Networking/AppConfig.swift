import Foundation

/// Build-time configuration, injected via Config.xcconfig -> Info.plist.
/// Lets the app point at localhost, Fly, or a teammate's machine without code changes.
enum AppConfig {
    static var apiBaseURL: URL? {
        guard let raw = infoString("API_BASE_URL") else { return nil }
        return URL(string: raw)
    }

    static var apiKey: String? {
        infoString("API_KEY")
    }

    private static func infoString(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !raw.isEmpty
        else { return nil }
        return raw
    }
}
