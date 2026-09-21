import Foundation

/// On-device log of raw detector signals, one timestamped line per event,
/// for reading back what fired (or didn't) during a field test. Enabled by
/// the Debug-menu switch; exported from there with a share sheet. Plain
/// text, capped small, never leaves the device unless the user exports it.
@MainActor
final class SignalLog {
    static let shared = SignalLog()
    static let enabledKey = "detectorSignalLogEnabled"
    private static let maxBytes = 512 * 1024

    let fileURL: URL

    private let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    init(directory: URL? = nil) {
        let dir = directory
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        fileURL = dir.appendingPathComponent("detector-signals.log")
    }

    func append(_ signal: RawDetectorSignal, at: Date, detail: String?) {
        guard isEnabled else { return }
        var line = "\(formatter.string(from: at)) \(signal.rawValue)"
        if let detail { line += " \(detail)" }
        line += "\n"
        guard let data = line.data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: fileURL) {
            defer { try? handle.close() }
            if (try? handle.seekToEnd()) ?? 0 > UInt64(Self.maxBytes) { return }
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: fileURL)
        }
    }

    var lineCount: Int {
        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { return 0 }
        return text.split(separator: "\n").count
    }

    /// The last few lines, for the Debug menu's live peek.
    func tail(_ n: Int = 8) -> [String] {
        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").suffix(n).map(String.init)
    }

    func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
