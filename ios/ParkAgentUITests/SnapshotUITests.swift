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

    /// The acceptance shots for the real-build PR: Home on Boston with curb
    /// lines, the city-neutral copy that follows from it, and Diagnostics.
    /// Named `pr-*` so they're easy to pick out of the result bundle.
    func testAcceptanceScreenshots() {
        let app = launchApp(cityScenario: "bos")

        // Home: the map centers on Boston (the mock puts the phone where the
        // city scenario says), the chip names it, and the curb layer draws.
        let chip = element(app, "home.statusChip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        waitForLabelContaining(chip, "Boston")
        attachScreenshot(of: app, named: "pr-home-boston-curb-lines")

        // Neutral copy: Settings names Boston and ParkBoston, never NYC.
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(element(app, "settings.view").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "pr-settings-neutral-copy")

        openDiagnostics(app)
        attachScreenshot(of: app, named: "pr-diagnostics")
        scrollTo(app, "diagnostics.apiBase")
        attachScreenshot(of: app, named: "pr-diagnostics-server")
    }

    /// The chip's label is composed ("Boston · No active session"), so an
    /// equality wait would be brittle.
    private func waitForLabelContaining(
        _ element: XCUIElement,
        _ substring: String,
        timeout: TimeInterval = 10
    ) {
        let predicate = NSPredicate(format: "label CONTAINS %@", substring)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(
            XCTWaiter().wait(for: [expectation], timeout: timeout), .completed,
            "Expected a label containing \"\(substring)\", got \"\(element.label)\""
        )
    }
}
