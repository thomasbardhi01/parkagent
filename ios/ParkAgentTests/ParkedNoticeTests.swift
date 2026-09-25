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
