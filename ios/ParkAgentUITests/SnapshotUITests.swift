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

        app.tabBars.buttons["Activity"].tap()
        XCTAssertTrue(element(app, "activity.view").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "activity-\(appearance)")

        openWallet(app)
        XCTAssertTrue(element(app, "wallet.hero.providerCard").waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "wallet-\(appearance)")

        openAccountSheet(app)
        attachScreenshot(of: app, named: "account-\(appearance)")
        element(app, "account.doneButton").tap()

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

        // Neutral copy: the Account sheet names Boston and ParkBoston,
        // never NYC.
        openAccountSheet(app)
        attachScreenshot(of: app, named: "pr-account-neutral-copy")
        let howYouPay = scrollTo(app, "account.howYouPay")
        waitForLabelContaining(howYouPay, "Your card on ParkBoston")
        attachScreenshot(of: app, named: "pr-account-payment")
        element(app, "account.doneButton").tap()

        openDiagnostics(app)
        attachScreenshot(of: app, named: "pr-diagnostics")
        scrollTo(app, "diagnostics.resetOnboardingButton")
        attachScreenshot(of: app, named: "pr-diagnostics-bottom")
    }
}
