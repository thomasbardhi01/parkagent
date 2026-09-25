import XCTest

final class SessionUITests: ParkAgentUITestCase {
    /// Simulate → pay → session row on Home → Active Session screen, then
    /// waits for the sheet to close and the row to land.
    private func payForSession(_ app: XCUIApplication) {
        simulateParkFromHome(app)
        element(app, "parkedSheet.payButton").tap()
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForNonExistence(timeout: 10),
            "Sheet did not close after paying"
        )
        let row = element(app, "home.activeSessionRow")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Active session row missing on Home")
        row.tap()
        XCTAssertTrue(element(app, "session.view").waitForExistence(timeout: 5))
    }

    private func stopSession(_ app: XCUIApplication) {
        element(app, "session.stopButton").tap()
        // The confirmation dialog repeats the "Stop session" label; scope to
        // the presented sheet, falling back to the last matching button.
        let confirm = app.sheets.buttons["Stop session"]
        if confirm.waitForExistence(timeout: 3) {
            confirm.tap()
        } else {
            let all = app.buttons.matching(NSPredicate(format: "label == %@", "Stop session"))
            all.element(boundBy: all.count - 1).tap()
        }
    }

    /// Pay → countdown, auto-extend toggle, Extend and Stop; Stop returns Home.
    func testPayThenStopReturnsHome() {
        let app = launchApp(scenario: "singleQuote")
        payForSession(app)

        // Clock is frozen at pay time, so 90 minutes stays 1:30:00 exactly.
        let countdown = element(app, "session.countdown")
        XCTAssertTrue(countdown.waitForExistence(timeout: 5))
        XCTAssertEqual(countdown.label, "1:30:00")

        XCTAssertTrue(element(app, "session.autoExtendToggle").exists, "Auto-extend toggle missing")
        XCTAssertTrue(element(app, "session.extendButton").exists, "Extend button missing")
        XCTAssertTrue(element(app, "session.stopButton").exists, "Stop button missing")

        stopSession(app)
        XCTAssertTrue(
            element(app, "home.simulateParkButton").waitForExistence(timeout: 10),
            "Did not land back on Home with no active session"
        )
    }

    /// The session just paid shows in Activity (the server's ledger);
    /// its detail has the map, the timeline, and the receipt.
    func testActivityShowsStoppedSessionWithMapTimelineAndReceipt() {
        let app = launchApp(scenario: "singleQuote")
        payForSession(app)
        stopSession(app)
        XCTAssertTrue(element(app, "home.simulateParkButton").waitForExistence(timeout: 10))

        app.tabBars.buttons["Activity"].tap()
        // Only this run's session is in zone 110436 (the fixtures aren't).
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'activity.row.session:mock-' AND label CONTAINS 'Zone 110436'"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Stopped session missing from Activity")
        row.tap()

        XCTAssertTrue(element(app, "activityDetail.view").waitForExistence(timeout: 5))
        XCTAssertTrue(
            element(app, "activityDetail.map").waitForExistence(timeout: 10),
            "Detail map missing"
        )
        XCTAssertTrue(element(app, "activityDetail.timeline").exists, "Timeline missing")
        XCTAssertTrue(scrollTo(app, "activityDetail.receipt").exists, "Receipt missing")
    }

    /// The server's ledger lists a running session too. Activity shows it
    /// once — the live row on top, not again among the past rows — and the
    /// row opens the ledger's detail.
    func testActivityShowsTheRunningSessionOnce() {
        let app = launchApp(scenario: "singleQuote")
        simulateParkFromHome(app)
        element(app, "parkedSheet.payButton").tap()
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForNonExistence(timeout: 10),
            "Sheet did not close after paying"
        )
        XCTAssertTrue(element(app, "home.activeSessionRow").waitForExistence(timeout: 5))

        app.tabBars.buttons["Activity"].tap()
        let running = element(app, "activity.activeSession")
        XCTAssertTrue(running.waitForExistence(timeout: 5), "Running session missing from Activity")
        waitForLabelContaining(running, "Zone 110436")
        // The ledger has loaded (a fixture row is in), so a second listing
        // of the running session would be on screen by now.
        XCTAssertTrue(
            element(app, "activity.row.session:mock-s1").waitForExistence(timeout: 5),
            "Ledger never loaded"
        )
        let listedAgain = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'activity.row.session:mock-' AND label CONTAINS 'Zone 110436'"))
        XCTAssertEqual(listedAgain.count, 0, "The running session is listed twice")

        running.tap()
        let detail = element(app, "activityDetail.view")
        XCTAssertTrue(detail.waitForExistence(timeout: 5), "The running session opens no detail")
        XCTAssertTrue(
            detail.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Zone 110436'")).firstMatch
                .waitForExistence(timeout: 5),
            "The detail isn't the running session's"
        )
    }
}
