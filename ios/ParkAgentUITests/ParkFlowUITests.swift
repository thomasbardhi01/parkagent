import XCTest

final class ParkFlowUITests: ParkAgentUITestCase {
    /// Debug-menu park → sheet with zone, rate, max stay, and a dollar total;
    /// "Not parked here" dismisses.
    func testSimulatedParkShowsQuoteSheet() {
        let app = launchApp(scenario: "singleQuote")
        simulateParkViaDebugMenu(app)

        XCTAssertTrue(app.staticTexts["Zone 110436"].exists, "Zone number missing")
        XCTAssertTrue(app.staticTexts["$5.00 first hr, $8.25 after"].exists, "Rate ladder missing")
        XCTAssertTrue(app.staticTexts["2 hr max"].exists, "Max stay missing")

        let total = element(app, "parkedSheet.total")
        XCTAssertTrue(total.exists, "Quote total missing")
        XCTAssertTrue(total.label.hasPrefix("$"), "Total \"\(total.label)\" is not a dollar amount")

        element(app, "parkedSheet.dismissButton").tap()
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForNonExistence(timeout: 5),
            "Sheet did not dismiss"
        )
    }

    /// Two-candidate fixture: side selection appears, and paying is disabled
    /// until one side is chosen.
    func testTwoCandidatesRequireSelectionBeforePay() {
        let app = launchApp(scenario: "twoCandidates")
        simulateParkViaDebugMenu(app)

        let nearest = element(app, "parkedSheet.candidate.110436")
        let other = element(app, "parkedSheet.candidate.110437")
        XCTAssertTrue(nearest.waitForExistence(timeout: 5), "First candidate missing")
        XCTAssertTrue(other.exists, "Second candidate missing")

        let pay = element(app, "parkedSheet.payButton")
        XCTAssertTrue(pay.exists, "Pay button missing")
        XCTAssertFalse(pay.isEnabled, "Pay must be disabled before a side is chosen")

        nearest.tap()
        let enabled = NSPredicate(format: "isEnabled == true")
        let expectation = XCTNSPredicateExpectation(predicate: enabled, object: pay)
        XCTAssertEqual(
            XCTWaiter().wait(for: [expectation], timeout: 5), .completed,
            "Pay did not enable after choosing a candidate"
        )
    }

    /// Unknown-zone fixture: the manual zone-number input appears and
    /// resubmits for a quote.
    func testUnknownZoneManualEntryResubmits() {
        let app = launchApp(scenario: "unknownZone")
        simulateParkViaDebugMenu(app)

        let field = element(app, "parkedSheet.zoneField")
        XCTAssertTrue(field.waitForExistence(timeout: 5), "Zone-number field missing")

        let quote = element(app, "parkedSheet.getQuoteButton")
        XCTAssertFalse(quote.isEnabled, "Get quote should be disabled while the field is empty")

        field.tap()
        field.typeText("110436")
        XCTAssertTrue(quote.isEnabled)
        quote.tap()

        // The sheet swaps in a single quote for the entered zone.
        XCTAssertTrue(app.staticTexts["Zone 110436"].waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "parkedSheet.total").waitForExistence(timeout: 5))
    }
}
