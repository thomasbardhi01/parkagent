import XCTest
@testable import ParkAgent

/// A park reported with no signal waits on disk and goes out, under the key
/// it was first sent with, once there's a connection. Before the outbox a
/// failed POST /parked was lost for good.
final class ParkOutboxTests: XCTestCase {
    private var file: URL!

    override func setUp() {
        super.setUp()
        file = FileManager.default.temporaryDirectory.appending(path: "outbox-\(UUID().uuidString).json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: file)
        super.tearDown()
    }

    private func park(_ minutesAgo: Double = 0) -> ParkedRequest {
        ParkedRequest(
            lat: 42.35,
            lng: -71.07,
            accuracy: 10,
            ts: Date().addingTimeInterval(-minutesAgo * 60),
            signals: ["motion_stop"]
        )
    }

    private static let answer = MockFixtures.bostonQuote(provider: nil, zoneNumber: "456")

    func testAQueuedParkSurvivesARelaunch() async {
        let first = ParkOutbox(fileURL: file)
        await first.enqueue(park(), key: "key-1")
        await first.enqueue(park(), key: "key-1") // the same park, once
        let relaunched = ParkOutbox(fileURL: file)
        let pending = await relaunched.pending
        XCTAssertEqual(pending.map(\.key), ["key-1"])
    }

    func testDeliveredInOrderUnderTheirOwnKeys() async {
        let outbox = ParkOutbox(fileURL: file)
        await outbox.enqueue(park(3), key: "key-1")
        await outbox.enqueue(park(1), key: "key-2")
        let sentKeys = LockedKeys()
        let delivered = await outbox.flush { _, key in
            sentKeys.append(key)
            return Self.answer
        }
        XCTAssertEqual(sentKeys.values, ["key-1", "key-2"])
        XCTAssertEqual(delivered.map(\.item.key), ["key-1", "key-2"])
        let pending = await outbox.pending
        XCTAssertTrue(pending.isEmpty)
    }

    func testStillOfflineKeepsEverythingAndStops() async {
        let outbox = ParkOutbox(fileURL: file)
        await outbox.enqueue(park(), key: "key-1")
        await outbox.enqueue(park(), key: "key-2")
        let calls = LockedKeys()
        let delivered = await outbox.flush { _, key in
            calls.append(key)
            throw APIError.transport(URLError(.notConnectedToInternet))
        }
        XCTAssertTrue(delivered.isEmpty)
        XCTAssertEqual(calls.values, ["key-1"], "no point hammering while offline")
        let pending = await outbox.pending
        XCTAssertEqual(pending.map(\.key), ["key-1", "key-2"])
        XCTAssertEqual(pending.first?.attempts, 1)
    }

    func testARefusalIsFinalAndStillRunningIsNot() async {
        XCTAssertTrue(ParkOutbox.isFinal(.invalidRequest("bad")))
        XCTAssertTrue(ParkOutbox.isFinal(.refused(code: "unknown_zone")))
        XCTAssertFalse(ParkOutbox.isFinal(.refused(code: "request_in_progress")))
        XCTAssertFalse(ParkOutbox.isFinal(.transport(URLError(.timedOut))))
        XCTAssertFalse(ParkOutbox.isFinal(.server(status: 503)))

        let outbox = ParkOutbox(fileURL: file)
        await outbox.enqueue(park(), key: "key-1")
        _ = await outbox.flush { _, _ in throw APIError.invalidRequest("bad") }
        let pending = await outbox.pending
        XCTAssertTrue(pending.isEmpty, "a refused report won't change on retry")
    }

    func testParksTooOldToMatterAreDropped() async {
        let outbox = ParkOutbox(fileURL: file)
        await outbox.enqueue(park(), key: "old", at: Date().addingTimeInterval(-(ParkOutbox.maxAge + 60)))
        let calls = LockedKeys()
        _ = await outbox.flush { _, key in
            calls.append(key)
            return Self.answer
        }
        XCTAssertTrue(calls.values.isEmpty)
    }
}

/// A thread-safe list for the @Sendable send closures above.
private final class LockedKeys: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func append(_ key: String) { lock.withLock { items.append(key) } }
    var values: [String] { lock.withLock { items } }
}
