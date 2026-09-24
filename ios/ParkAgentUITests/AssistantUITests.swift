import XCTest

/// The assistant sheet against the mock API: the single-spot flow, a
/// six-stop itinerary sign-off, reordering, the SpotHero deep-link tap,
/// the Link-connected confirm path, and the parking-only refusal.
final class AssistantUITests: ParkAgentUITestCase {
    private func openAssistant(
        _ assistantScenario: String,
        linkScenario: String? = nil
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var args = [
            "-resetState", "YES",
            "-useMockAPI", "YES",
            "-uiTesting", "YES",
            "-skipOnboarding", "YES",
            // Auth gates the app now: start past the welcome screen.
            "-signedIn", "YES",
            "-fixedNow", Self.fixedNow,
            "-assistantScenario", assistantScenario,
        ]
        if let linkScenario { args += ["-linkScenario", linkScenario] }
        app.launchArguments = args
        app.launch()
        element(app, "home.askAssistantButton").tap()
        XCTAssertTrue(element(app, "assistant.inputField").waitForExistence(timeout: 5))
        return app
    }

    private func ask(_ app: XCUIApplication, _ text: String) {
        let field = element(app, "assistant.inputField")
        field.tap()
        field.typeText(text)
        element(app, "assistant.sendButton").tap()
    }

    func testSingleSpotFlowStreetConfirm() {
        let app = openAssistant("singleSpot")
        XCTAssertTrue(element(app, "assistant.emptyState").exists)
        ask(app, "Park me near the MFA for 90 minutes")

        // The plan streams in: three option cards, one recommended badge.
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(identifier: "Recommended").count, 1)

        element(app, "assistant.confirm.opt-street").tap()
        // Street confirm hands the zone to the existing paid flow.
        let note = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'session starts when you park'")
        ).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "assistant-street-confirmed")
    }

    func testGarageConfirmOpensDeepLink() {
        let app = openAssistant("singleSpot")
        ask(app, "garage near fenway")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))

        element(app, "assistant.confirm.opt-garage").tap()
        // The deep link "opened" (probe in uiTesting mode) as SpotHero…
        let probe = element(app, "assistant.externalLinkProbe")
        XCTAssertTrue(probe.waitForExistence(timeout: 5))
        XCTAssertEqual(probe.label, "spothero")
        // …and the hand-off note says where the pass lives.
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'SpotHero'"))
                .firstMatch.exists
        )
    }

    func testSixStopItinerarySignOffAndReorder() {
        let app = openAssistant("itinerary")
        ask(app, "plan my boston day")
        XCTAssertTrue(element(app, "assistant.itineraryPlan").waitForExistence(timeout: 10))

        // Six stops, day total against the cap.
        for i in 1...6 {
            XCTAssertTrue(element(app, "assistant.stopRow.stop-\(i)").exists, "stop \(i) missing")
        }
        XCTAssertTrue(element(app, "assistant.dayTotal").label.contains("$40.40"))

        // Reorder stop 2 above stop 1 through its menu.
        element(app, "assistant.stopMenu.stop-2").tap()
        app.buttons["Move up"].tap()
        let firstRow = element(app, "assistant.stopRow.stop-2")
        XCTAssertTrue(firstRow.exists)

        element(app, "assistant.signOffButton").tap()
        let done = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Signed off'")
        ).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5))

        // The day landed on Home with live status rows (leaf identifiers:
        // the section container flattens inside home.view).
        app.buttons["Done"].tap()
        XCTAssertTrue(element(app, "home.dayHeader").waitForExistence(timeout: 5))
        // View-mode rows reuse the assistant stop-row identifiers; the
        // home.dayStop.* ids belong to the edit list.
        XCTAssertTrue(element(app, "assistant.stopRow.stop-1").exists)
        attachScreenshot(of: app, named: "assistant-day-on-home")
    }

    func testLinkConnectedConfirmShowsWalletPath() {
        let app = openAssistant("singleSpot", linkScenario: "connected")
        ask(app, "spot near the museum")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))
        // The cards announce the wallet before the tap.
        XCTAssertTrue(element(app, "assistant.linkPayBadge").exists)

        element(app, "assistant.confirm.opt-street").tap()
        // Confirm routes through the Link approval deep link…
        let probe = element(app, "assistant.externalLinkProbe")
        XCTAssertTrue(probe.waitForExistence(timeout: 5))
        XCTAssertEqual(probe.label, "linkApproval")
        probe.tap() // "return" from the approval
        // …and the post-approval sync lands in the transcript.
        let approved = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Link approved'")
        ).firstMatch
        XCTAssertTrue(approved.waitForExistence(timeout: 5))
        // The payment banner told the user which source pays.
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Link wallet'"))
                .firstMatch.exists
        )
    }

    func testRefusesNonParkingTopics() {
        let app = openAssistant("refuse")
        ask(app, "what's a good pasta recipe?")
        let refusal = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'only help with parking'")
        ).firstMatch
        XCTAssertTrue(refusal.waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "assistant.singleSpotPlan").exists)
    }

    func testErrorStateSurfaces() {
        let app = openAssistant("error")
        ask(app, "find me parking")
        XCTAssertTrue(element(app, "assistant.errorRow").waitForExistence(timeout: 10))
    }

    /// The Link-wallet row now lives in the Account sheet (the Settings
    /// tab is gone); the flow it drives is unchanged.
    func testAccountSheetConnectsLinkWallet() {
        let app = openAssistant("singleSpot", linkScenario: "disconnected")
        app.buttons["Done"].tap()
        openAccountSheet(app)
        let connect = scrollTo(app, "account.linkConnectButton")
        XCTAssertTrue(connect.waitForExistence(timeout: 5), "Connect row never came into reach")
        connect.tap()
        // The mock connects instantly and the row becomes two rows —
        // "Connected" plus Disconnect — so Disconnect lands lower than the
        // Connect row it replaced, and on a tall screen that can be past
        // the fold. Scroll for it rather than assuming it is on screen.
        let disconnect = scrollTo(app, "account.linkDisconnectButton")
        XCTAssertTrue(disconnect.waitForExistence(timeout: 5), "Row did not flip to Connected")
    }
}
