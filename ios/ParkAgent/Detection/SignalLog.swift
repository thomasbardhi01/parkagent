import Foundation

/// On-device log of raw detector signals, one timestamped line per event,
/// for reading back what fired (or didn't) during a field test, and for
/// replaying a real drive through the engine in unit tests (SignalTrace).
/// Enabled by the Diagnostics switch; exported from there with a share
/// sheet. Plain text, never leaves the device unless the user exports it.
///
/// Line format (v2): `<ISO-8601 time> <event> [detail]`, where the time is
/// when the detector handled the event. Fixes carry
/// `lat,lng ±acc [speed m/s] [age=Ns]`. Motion samples carry their kinds
/// and confidence. v1 logs (no coordinates) still parse; their fixes just
/// can't be replayed.
@MainActor
final class SignalLog {
    static let shared = SignalLog()
    nonisolated static let enabledKey = "detectorSignalLogEnabled"
    /// Past this the file rolls over to `.1` (one generation kept), so a
    /// long field test keeps its latest drives instead of going silent.
    static let maxBytes = 1024 * 1024
    static let header = "# parkagent signal log v2"

    let fileURL: URL
    var previousURL: URL { fileURL.appendingPathExtension("1") }

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
        if let detail, !detail.isEmpty { line += " \(detail)" }
        write(line + "\n")
    }

    private func write(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        let manager = FileManager.default
        if let size = (try? manager.attributesOfItem(atPath: fileURL.path))?[.size] as? Int,
           size > Self.maxBytes {
            try? manager.removeItem(at: previousURL)
            try? manager.moveItem(at: fileURL, to: previousURL)
        }
        if let handle = try? FileHandle(forWritingTo: fileURL) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            // Readable after first unlock: the detector writes from the
            // background, often with the phone locked in a pocket.
            let header = Data((Self.header + "\n").utf8)
            try? (header + data).write(to: fileURL, options: .completeFileProtectionUntilFirstUserAuthentication)
        }
    }

    var lineCount: Int {
        guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { return 0 }
        return text.split(separator: "\n").filter { !$0.hasPrefix("#") }.count
    }

    func clear() {
        try? FileManager.default.removeItem(at: fileURL)
        try? FileManager.default.removeItem(at: previousURL)
    }
}
