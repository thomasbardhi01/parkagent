import XCTest

final class ParkFlowUITests: ParkAgentUITestCase {
    /// A park → sheet with zone, rate, max stay, and a dollar total;
    /// "Not parked here" dismisses.
    func testSimulatedParkShowsQuoteSheet() {
        let app = launchApp(scenario: "singleQuote")
        simulateParkFromHome(app)

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

    // MARK: - Place outcomes (FR-54)

    /// A garage: the sheet names it, says ParkAgent can't pay it and where
    /// to pay, credits the outline's source, and never offers to pay or to
    /// scan a ticket. Confirming it is all there is to do.
    func testAGarageParkSaysItCantPayItAndTakesTheAnswer() {
        let app = launchApp(scenario: "garage")
        simulateParkFromHome(app)

        XCTAssertTrue(app.staticTexts["Looks like the Fixture Deck"].waitForExistence(timeout: 5), "Garage name missing")
        let notice = element(app, "parkedSheet.placeNotice")
        XCTAssertTrue(notice.exists, "Garage notice missing")
        XCTAssertTrue(notice.label.contains("can't pay drive-up garages yet"), notice.label)
        XCTAssertTrue(notice.label.contains("Pay at the station"), notice.label)
        let attribution = element(app, "parkedSheet.placeAttribution")
        XCTAssertTrue(attribution.exists, "Outline attribution missing")
        XCTAssertTrue(attribution.label.contains("OpenStreetMap"), attribution.label)
        XCTAssertFalse(element(app, "parkedSheet.payButton").exists, "A garage must not offer Pay")
        XCTAssertFalse(element(app, "parkedSheet.total").exists, "A garage has no quote")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'scan'")).count, 0, "V1 has no ticket flow")
        attachScreenshot(of: app, named: "parked-garage")

        element(app, "parkedSheet.placeConfirmButton").tap()
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForNonExistence(timeout: 5),
            "Sheet did not dismiss after the answer"
        )
    }

    /// "Not a garage" asks what the place is, without offering "Garage"
    /// again; "Street" then shows what the street lookup found (here, no
    /// zone at all).
    func testNotAGarageAsksWhatThePlaceIs() {
        let app = launchApp(scenario: "garage")
        simulateParkFromHome(app)

        let wrong = element(app, "parkedSheet.placeWrongButton")
        XCTAssertTrue(wrong.waitForExistence(timeout: 5), "\"Not a garage\" missing")
        wrong.tap()
        XCTAssertTrue(element(app, "parkedSheet.placeAsk").waitForExistence(timeout: 5), "The ask did not appear")
        XCTAssertFalse(element(app, "parkedSheet.placeChoice.garage").exists, "It just said it isn't a garage")
        XCTAssertTrue(element(app, "parkedSheet.placeChoice.lot").exists, "Lot choice missing")
        XCTAssertTrue(element(app, "parkedSheet.placeChoice.nopay").exists, "No-payment choice missing")
        attachScreenshot(of: app, named: "parked-not-a-garage")

        element(app, "parkedSheet.placeChoice.street").tap()
        XCTAssertTrue(
            element(app, "parkedSheet.unknownZoneLive").waitForExistence(timeout: 5),
            "A street answer with no zone in reach should say so"
        )
        XCTAssertFalse(element(app, "parkedSheet.placeAsk").exists, "Still asking after the answer")
    }

    func testAPaidLotSaysItCharges() {
        let app = launchApp(scenario: "paidLot")
        simulateParkFromHome(app)

        XCTAssertTrue(app.staticTexts["Parked at Fixture Lot"].waitForExistence(timeout: 5), "Lot name missing")
        let notice = element(app, "parkedSheet.placeNotice")
        XCTAssertTrue(notice.label.contains("This lot charges"), notice.label)
        XCTAssertFalse(element(app, "parkedSheet.payButton").exists, "A lot must not offer Pay")
        attachScreenshot(of: app, named: "parked-paid-lot")

        // "Not parked here" is an answer too, and always closes the sheet.
        element(app, "parkedSheet.dismissButton").tap()
        XCTAssertTrue(element(app, "parkedSheet.view").waitForNonExistence(timeout: 5), "Sheet did not dismiss")
    }

    /// The place is unclear and nothing is metered: the sheet asks, with
    /// every choice; "No payment" closes it.
    func testAnUnclearPlaceAsksWithEveryChoice() {
        let app = launchApp(scenario: "placeUnknown")
        simulateParkFromHome(app)

        XCTAssertTrue(app.staticTexts["What is this place?"].waitForExistence(timeout: 5), "The ask is missing")
        for choice in ["street", "garage", "lot", "nopay"] {
            XCTAssertTrue(element(app, "parkedSheet.placeChoice.\(choice)").exists, "\(choice) choice missing")
        }
        XCTAssertFalse(element(app, "parkedSheet.payButton").exists, "Nothing to pay yet")
        attachScreenshot(of: app, named: "parked-place-ask")

        element(app, "parkedSheet.placeChoice.nopay").tap()
        XCTAssertTrue(element(app, "parkedSheet.view").waitForNonExistence(timeout: 5), "Sheet did not dismiss")
    }

    /// The place is unclear but a meter in reach would charge: the street
    /// choice carries the price, and choosing it lands on the quote with
    /// its Pay button. Nothing was lost by asking.
    func testAnUnclearPlaceWithAMeterInReachLeadsToTheQuote() {
        let app = launchApp(scenario: "placeUnknownStreet")
        simulateParkFromHome(app)

        let street = element(app, "parkedSheet.placeChoice.street")
        XCTAssertTrue(street.waitForExistence(timeout: 5), "Street choice missing")
        XCTAssertTrue(street.label.contains("$"), "The street choice should say what it costs: \(street.label)")
        XCTAssertFalse(element(app, "parkedSheet.payButton").exists, "No Pay before the driver says it's the street")
        attachScreenshot(of: app, named: "parked-place-ask-street")

        street.tap()
        let pay = element(app, "parkedSheet.payButton")
        XCTAssertTrue(pay.waitForExistence(timeout: 5), "The quote did not appear after \"Street\"")
        XCTAssertTrue(pay.isEnabled)
        XCTAssertTrue(app.staticTexts["Zone 110436"].exists, "Zone number missing")
        XCTAssertTrue(element(app, "parkedSheet.total").label.hasPrefix("$"))
    }

    /// Nothing to pay: no sheet at all.
    func testANoPayParkIsSilent() {
        let app = launchApp(scenario: "noPayment")
        selectTab(app, "Park")
        let simulate = element(app, "home.simulateParkButton")
        XCTAssertTrue(simulate.waitForExistence(timeout: 5), "Simulate park button missing")
        simulate.tap()
        XCTAssertFalse(
            element(app, "parkedSheet.view").waitForExistence(timeout: 4),
            "A no-pay park must not put up a sheet"
        )
        // The app is still on Home, and can still park.
        XCTAssertTrue(simulate.exists)
    }

    /// Two-candidate fixture: side selection appears, and paying is disabled
    /// until one side is chosen.
    func testTwoCandidatesRequireSelectionBeforePay() {
        let app = launchApp(scenario: "twoCandidates")
        simulateParkFromHome(app)

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
        simulateParkFromHome(app)
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

        // The applied-number notice is transient: it shows only for the pay
        // round-trip (2 s in this mock scenario; seconds in prod) and then the
        // sheet dismisses. Match identifier AND label in ONE predicate wait so
        // there is no gap between confirming it exists and reading its label —
        // reading `.label` after the sheet had already dismissed was the flake
        // (CI run 35913760288 attempt 1: waitForExistence passed at :135, the
        // separate `.label` read at :136 then found no element).
        let appliedNotice = app.descendants(matching: .any).matching(
            NSPredicate(
                format: "identifier == %@ AND label CONTAINS %@",
                "parkedSheet.appliedNumberNotice", "55555"
            )
        ).firstMatch
        XCTAssertTrue(
            appliedNotice.waitForExistence(timeout: 8),
            "Applied-number notice naming 55555 missing"
        )

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

    /// No zone near the fix: the sheet says plainly that ParkAgent can't
    /// quote or pay here and names the city's own app — no zone-number
    /// field (there is no quote-by-number endpoint to feed it), no Pay.
    func testUnknownZoneSaysWhatIsTrue() {
        let app = launchApp(scenario: "unknownZone")
        simulateParkFromHome(app)

        let copy = element(app, "parkedSheet.unknownZoneLive")
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "Unknown-zone explanation missing")
        XCTAssertTrue(
            copy.label.contains("can't quote or pay here"),
            "Unexpected unknown-zone copy: \(copy.label)"
        )
        XCTAssertFalse(element(app, "parkedSheet.zoneField").exists, "No manual zone entry any more")
        XCTAssertFalse(element(app, "parkedSheet.payButton").exists, "Nothing to pay at an unknown zone")
    }

    /// /parked priced the stay at $0 (outside posted hours): the sheet says
    /// it's free and offers nothing to pay.
    func testFreePeriodParkOffersNothingToPay() {
        let app = launchApp(scenario: "freePeriod")
        simulateParkFromHome(app)

        XCTAssertTrue(
            app.staticTexts["Meters here are free right now"].waitForExistence(timeout: 5),
            "Free-period header missing"
        )
        XCTAssertFalse(element(app, "parkedSheet.payButton").exists, "A free period must not offer Pay")
    }

    /// The provider step failed AFTER the pay click (executor_failed,
    /// ui_changed): nobody knows whether it paid. The sheet must say so and
    /// warn against paying twice — never "the meter isn't paid", and never
    /// the raw code.
    func testUnconfirmedPaymentWarnsBeforeRetrying() {
        let app = launchApp(scenario: "paymentFailed")
        simulateParkFromHome(app)

        let pay = element(app, "parkedSheet.payButton")
        XCTAssertTrue(pay.waitForExistence(timeout: 5), "Pay button missing")
        pay.tap()
        XCTAssertTrue(
            app.staticTexts["Payment not confirmed"].waitForExistence(timeout: 5),
            "An unconfirmed payment must not read as a plain failure"
        )
        let warning = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "so you don't pay twice")
        ).firstMatch
        XCTAssertTrue(warning.exists, "No warning against paying twice")
        for raw in ["executor_failed", "ui_changed", "isn't paid"] {
            XCTAssertFalse(
                app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", raw)).firstMatch.exists,
                "\(raw) leaked into the sheet"
            )
        }
    }
}
