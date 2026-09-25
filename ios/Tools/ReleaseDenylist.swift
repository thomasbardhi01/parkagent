import Foundation

/// ios/Tools/release-denylist.txt, parsed. Compiled into BOTH test targets:
/// ParkAgentReleaseTests asserts the forbidden entries are absent from the
/// Release build; ParkAgentTests asserts every type entry resolves in the
/// Debug build, so a mistyped name or kind can't make the Release check
/// pass vacuously.
struct ReleaseDenylist {
    struct TypeEntry: CustomStringConvertible {
        let name: String
        /// V struct, O enum, C class or actor.
        let kind: Character

        /// `_typeByName` only resolves a dotted name ("ParkAgent.X") for
        /// classes; structs and enums need the mangled form.
        var mangled: String { "9ParkAgent\(name.utf8.count)\(name)\(kind)" }
        var description: String { "ParkAgent.\(name) (\(kind))" }

        func resolves() -> Bool { _typeByName(mangled) != nil }
    }

    var forbiddenStrings: [String] = []
    var requiredStrings: [String] = []
    var forbiddenTypes: [TypeEntry] = []
    var requiredTypes: [TypeEntry] = []

    init(contentsOf url: URL) throws {
        for raw in try String(contentsOf: url, encoding: .utf8).split(separator: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            let required = line.hasPrefix("+ ")
            if required { line = String(line.dropFirst(2)) }
            if line.hasPrefix("type ") {
                let parts = line.split(separator: " ")
                guard parts.count == 3, let kind = parts[2].first, "VOC".contains(kind) else {
                    throw CocoaError(.fileReadCorruptFile, userInfo: [NSDebugDescriptionErrorKey: "bad type line: \(line)"])
                }
                let entry = TypeEntry(name: String(parts[1]), kind: kind)
                if required { requiredTypes.append(entry) } else { forbiddenTypes.append(entry) }
            } else if required {
                requiredStrings.append(line)
            } else {
                forbiddenStrings.append(line)
            }
        }
    }

    /// The denylist bundled into the calling test target.
    static func bundled(for testClass: AnyClass) throws -> ReleaseDenylist {
        guard let url = Bundle(for: testClass).url(forResource: "release-denylist", withExtension: "txt") else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSDebugDescriptionErrorKey: "release-denylist.txt not bundled"])
        }
        return try ReleaseDenylist(contentsOf: url)
    }
}
