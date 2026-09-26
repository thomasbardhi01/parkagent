import XCTest
@testable import ParkAgent

/// The background-park notification: said only when there's something to
/// pay, with the zone and the price the sheet will show.
final class ParkedNoticeTests: XCTestCase {
    func testAPayableParkNamesTheZoneAndThePrice() throws {
        var parked = MockFixtures.singleQuote()
        parked.dryRun = false
        let content = try XCTUnwrap(ParkedNotice.content(for: parked))
        let quote = try XCTUnwrap(parked.quote)
        XCTAssertEqual(content.title, "Parked in zone 110436")
        XCTAssertEqual(
            content.body,
            "Pay \(Format.money(quote.totalUsd)) for \(Format.minutes(quote.stayMinutes)) — open ParkAgent to confirm."
        )
    }

    func testDryRunSaysNothingWillBeCharged() throws {
        let parked = MockFixtures.singleQuote()
        XCTAssertTrue(parked.dryRun, "Fixture should be dry run")
        let content = try XCTUnwrap(ParkedNotice.content(for: parked))
        XCTAssertTrue(content.body.hasSuffix("Dry run — nothing will be charged."), content.body)
    }

    func testTwoSidesAskToPickOne() throws {
        let content = try XCTUnwrap(ParkedNotice.content(for: MockFixtures.twoCandidates()))
        XCTAssertTrue(content.body.contains("Pick the side of the street you're on."), content.body)
    }

    func testAnUnnumberedBlockAsksForTheMetersNumber() throws {
        let parked = MockFixtures.bostonQuote(
            provider: MockFixtures.parkedProvider(id: "passport", status: "linked"),
            zoneNumber: nil
        )
        XCTAssertTrue(parked.needsZoneNumber, "Fixture should need a zone number")
        let content = try XCTUnwrap(ParkedNotice.content(for: parked))
        XCTAssertEqual(content.title, "Parked — zone number needed")
    }

    /// Parking at home (no meter) or after hours (free) must stay quiet —
    /// otherwise every drive home ends in a notification.
    func testNothingToPayStaysSilent() {
        XCTAssertNil(ParkedNotice.content(for: MockFixtures.unknownZone()))
        XCTAssertNil(ParkedNotice.content(for: MockFixtures.freePeriod()))
    }
}

/// The pending park survives the process for a while, and no longer.
final class ParkedNoticeStoreTests: XCTestCase {
    override func tearDown() {
        ParkedNotice.store(nil)
        super.tearDown()
    }

    func testAFreshParkIsRestored() {
        let parked = MockFixtures.singleQuote()
        ParkedNotice.store(parked)
        XCTAssertEqual(ParkedNotice.restore()?.parkedEventId, parked.parkedEventId)
    }

    func testClearingRemovesIt() {
        ParkedNotice.store(MockFixtures.singleQuote())
        ParkedNotice.store(nil)
        XCTAssertNil(ParkedNotice.restore())
    }

    /// Storing the same park again (the launch-time restore) must not
    /// refresh its age.
    func testRestoringTheSameParkKeepsItsAge() throws {
        let parked = MockFixtures.singleQuote()
        ParkedNotice.store(parked)
        let first = try XCTUnwrap(UserDefaults.standard.data(forKey: "pendingParked"))
        ParkedNotice.store(parked)
        XCTAssertEqual(UserDefaults.standard.data(forKey: "pendingParked"), first)
        // A different park replaces it.
        ParkedNotice.store(MockFixtures.twoCandidates())
        XCTAssertNotEqual(UserDefaults.standard.data(forKey: "pendingParked"), first)
    }
}

extension ParkedNoticeTests {
    /// A park the sheet can't pay as-is says what's in the way, never "Pay".
    func testRefusedParksDontInviteAPayment() throws {
        var overCap = MockFixtures.singleQuote()
        overCap.action = .confirm
        overCap.rule = "session_cap_exceeded"
        let capped = try XCTUnwrap(ParkedNotice.content(for: overCap))
        XCTAssertTrue(capped.body.contains("won't pay it"), capped.body)
        XCTAssertFalse(capped.body.hasPrefix("Pay "), capped.body)

        let unlinked = MockFixtures.singleQuote(provider: MockFixtures.parkedProvider(id: "parknyc", status: "unlinked"))
        XCTAssertEqual(unlinked.provider?.linked, false, "Fixture should be unlinked")
        let content = try XCTUnwrap(ParkedNotice.content(for: unlinked))
        XCTAssertTrue(content.body.hasPrefix("Connect ParkNYC in ParkAgent"), content.body)
    }

    /// A park with nowhere to point says why, instead of staying silent.
    func testAnUnlocatedParkSaysWhyAndWhatToDo() {
        let precise = ParkedNotice.unlocatedContent(preciseOff: true)
        XCTAssertTrue(precise.body.contains("Precise Location is off"), precise.body)
        XCTAssertTrue(precise.body.contains("Settings"), precise.body)
        let gps = ParkedNotice.unlocatedContent(preciseOff: false)
        XCTAssertFalse(gps.body.contains("Precise"), gps.body)
        XCTAssertTrue(gps.body.contains("Pay at the meter"), gps.body)
    }
}
