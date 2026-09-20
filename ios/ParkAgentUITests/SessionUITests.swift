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

    /// The session just created shows in history; detail has a map and receipt.
    func testHistoryShowsStoppedSessionWithMapAndReceipt() {
        let app = launchApp(scenario: "singleQuote")
        payForSession(app)
        stopSession(app)
        XCTAssertTrue(element(app, "home.simulateParkButton").waitForExistence(timeout: 10))

        app.tabBars.buttons["Sessions"].tap()
        let row = element(app, "sessions.row.110436")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Stopped session missing from history")
        row.tap()

        XCTAssertTrue(element(app, "sessionDetail.view").waitForExistence(timeout: 5))
        XCTAssertTrue(
            element(app, "sessionDetail.map").waitForExistence(timeout: 10),
            "Detail map missing"
        )
        XCTAssertTrue(element(app, "sessionDetail.receipt").exists, "Receipt missing")
    }
}
