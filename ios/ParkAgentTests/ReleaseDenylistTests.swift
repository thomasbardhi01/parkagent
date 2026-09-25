import XCTest

/// The Release build's type check (ParkAgentReleaseTests) asserts each
/// denylisted type is ABSENT — which proves nothing if the name or kind in
/// the list is wrong, because a wrong mangled name is absent everywhere.
/// This runs in the Debug build, where every one of them exists, and fails
/// on any entry that doesn't resolve.
final class ReleaseDenylistTests: XCTestCase {
    func testEveryDenylistedTypeResolvesInDebug() throws {
        let list = try ReleaseDenylist.bundled(for: Self.self)
        XCTAssertGreaterThan(list.forbiddenTypes.count, 10)
        for entry in list.forbiddenTypes + list.requiredTypes {
            XCTAssertTrue(entry.resolves(), "\(entry) doesn't resolve as \(entry.mangled) — wrong name or kind")
        }
    }

    /// The lookup really discriminates: a type that exists nowhere is nil.
    func testAnUnknownTypeDoesNotResolve() {
        let bogus = ReleaseDenylist.TypeEntry(name: "NoSuchTypeAnywhere", kind: "V")
        XCTAssertFalse(bogus.resolves())
        // Same name, wrong kind: the MockAPI struct looked up as an enum.
        XCTAssertFalse(ReleaseDenylist.TypeEntry(name: "MockAPI", kind: "O").resolves())
    }
}
