import XCTest

/// One screenshot per main screen in each scheme, attached to the test
/// results. Visual review only — no pixel diffing yet.
final class SnapshotUITests: ParkAgentUITestCase {
    func testSnapshotsLight() {
        snapshotMainScreens(appearance: "light")
    }

    func testSnapshotsDark() {
        snapshotMainScreens(appearance: "dark")
    }

    private func snapshotMainScreens(appearance: String) {
        let app = launchApp(appearance: appearance)
        XCTAssertTrue(element(app, "home.statusChip").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "home-\(appearance)")

        app.tabBars.buttons["Sessions"].tap()
        XCTAssertTrue(element(app, "sessions.view").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "sessions-\(appearance)")

        app.tabBars.buttons["Card"].tap()
        XCTAssertTrue(element(app, "card.view").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "card-\(appearance)")

        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(element(app, "settings.view").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "settings-\(appearance)")

        // The parked sheet is the money screen; capture it too.
        simulateParkFromHome(app)
        attachScreenshot(of: app, named: "parkedSheet-\(appearance)")
    }
}
