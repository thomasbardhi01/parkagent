import Foundation

/// The detector's working state on disk, so a relaunch mid-park picks up
/// where the last process stopped. iOS ends a backgrounded app whenever
/// it likes, and a stop that was one walk away from firing must not start
/// over (or be forgotten) because of it. Written after every change;
/// readable after first unlock, because relaunches for location happen
/// with the phone locked.
@MainActor
final class DetectorStore {
    struct Snapshot: Codable, Equatable {
        var engine: ParkFusionEngine.State
        /// CoreMotion history is replayed from here on the next wake, so
        /// nothing that happened while the app was suspended is skipped
        /// or fed twice.
        var motionHistoryThrough: Date?
        var savedAt: Date
    }

    let fileURL: URL

    init(directory: URL? = nil) {
        let dir = directory ?? Self.defaultDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent(Self.fileName)
    }

    private nonisolated static let fileName = "detector-state.json"
    private nonisolated static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    /// For `-resetState` (UI tests), which runs before any actor is up.
    nonisolated static func clearDefault() {
        try? FileManager.default.removeItem(at: defaultDirectory.appendingPathComponent(fileName))
    }

    func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }

    func save(_ snapshot: Snapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
