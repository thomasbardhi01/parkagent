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

    /// Boston block with no reported ParkBoston number: the sheet collects
    /// it from the meter, saves it, pays in the same tap — and the next
    /// park at the block is automatic.
    func testBostonZoneNumberCaptureThenAutomatic() {
        let app = launchApp(scenario: "bostonNeedsZone")
        simulateParkFromHome(app)

        // Unknown number: capture field instead of a plain Pay.
        let field = element(app, "parkedSheet.zoneNumberField")
        XCTAssertTrue(field.waitForExistence(timeout: 5), "Zone-number capture missing")
        XCTAssertTrue(element(app, "parkedSheet.zoneNumberHint").exists, "First-park hint missing")
        let saveAndPay = element(app, "parkedSheet.saveAndPayButton")
        XCTAssertTrue(saveAndPay.exists, "Save-and-pay missing")
        XCTAssertFalse(saveAndPay.isEnabled, "Must wait for a plausible number")

        field.tap()
        field.typeText("81234")
        XCTAssertTrue(saveAndPay.isEnabled, "Five digits should be enough")
        saveAndPay.tap()

        // Saved notice shows while the payment goes through, then the
        // sheet closes onto an active session.
        XCTAssertTrue(
            element(app, "parkedSheet.zoneSavedNotice").waitForExistence(timeout: 5),
            "Saved-for-this-block notice missing"
        )
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForNonExistence(timeout: 10),
            "Sheet did not close after paying"
        )
        XCTAssertTrue(
            element(app, "home.activeSessionRow").waitForExistence(timeout: 5),
            "No active session after save-and-pay"
        )
        XCTAssertTrue(app.staticTexts["Zone 81234"].exists, "Session should carry the saved number")

        // Second park at the block: the stored number makes it automatic.
        simulateParkViaDebugMenu(app)
        XCTAssertTrue(
            element(app, "parkedSheet.payButton").waitForExistence(timeout: 5),
            "Second park should offer plain Pay"
        )
        XCTAssertFalse(element(app, "parkedSheet.zoneNumberField").exists, "No capture the second time")
        XCTAssertTrue(app.staticTexts["Zone 81234"].exists, "Stored number should show on the card")
    }

    /// The provider said the zone isn't charging at start time (200
    /// free_period): "No payment needed" instead of a payment error, no
    /// session, and Done closes the sheet.
    func testFreePeriodAtStartShowsNoPaymentNeeded() {
        let app = launchApp(scenario: "freePeriodAtStart")
        simulateParkFromHome(app)

        element(app, "parkedSheet.payButton").tap()
        // Leaf identifiers: the result view's container flattens inside
        // parkedSheet.view (the nested-.contain pitfall).
        XCTAssertTrue(
            element(app, "parkedSheet.freePeriodDoneButton").waitForExistence(timeout: 10),
            "Free-period result missing"
        )
        XCTAssertTrue(
            app.staticTexts["No payment needed"].exists,
            "Free parking must not read as a failure"
        )
        element(app, "parkedSheet.freePeriodDoneButton").tap()
        XCTAssertTrue(element(app, "parkedSheet.view").waitForNonExistence(timeout: 5))
        XCTAssertFalse(
            element(app, "home.activeSessionRow").exists,
            "No session exists for a free period"
        )
    }

    /// Import precedence on save-and-pay: the server keeps the import's
    /// number, and the app pays and displays THAT number, with a notice —
    /// never showing one number while the executor types another.
    func testSaveAndPayHonorsImportPrecedence() {
        let app = launchApp(scenario: "bostonImportConflict")
        simulateParkFromHome(app)

        let field = element(app, "parkedSheet.zoneNumberField")
        XCTAssertTrue(field.waitForExistence(timeout: 5), "Zone-number capture missing")
        field.tap()
        field.typeText("81234")
        element(app, "parkedSheet.saveAndPayButton").tap()

        let notice = element(app, "parkedSheet.appliedNumberNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "Applied-number notice missing")
        XCTAssertTrue(notice.label.contains("55555"), "Notice must name the applied number")

        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForNonExistence(timeout: 10),
            "Sheet did not close after paying"
        )
        XCTAssertTrue(element(app, "home.activeSessionRow").waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts["Zone 55555"].exists,
            "The session must carry the number the executor actually types"
        )
        XCTAssertFalse(app.staticTexts["Zone 81234"].exists, "The outranked typed number must not show")
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
