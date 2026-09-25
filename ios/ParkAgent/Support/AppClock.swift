import Foundation

/// Source of "now" for everything the user can see. Normally the wall clock;
/// UI tests launch with `-fixedNow <epoch-seconds>` to freeze it so quotes,
/// countdowns, and history dates are deterministic. Release builds read the
/// wall clock only — no launch argument can move it.
enum AppClock {
    #if DEBUG
    static let fixedNow: Date? = {
        let args = ProcessInfo.processInfo.arguments
        guard
            let index = args.firstIndex(of: "-fixedNow"), index + 1 < args.count,
            let epoch = Double(args[index + 1])
        else { return nil }
        return Date(timeIntervalSince1970: epoch)
    }()

    static var now: Date { fixedNow ?? Date() }
    #else
    static var now: Date { Date() }
    #endif
}
