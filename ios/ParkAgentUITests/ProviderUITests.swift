import XCTest

/// Provider-account state outside onboarding: the parked sheet's routing
/// when the city's provider isn't linked, and the Settings surface.
final class ProviderUITests: ParkAgentUITestCase {
    /// Unlinked provider: the sheet's primary action becomes "Link ParkNYC",
    /// and finishing the link flow brings Pay back.
    func testParkedSheetNotLinkedRoutesToLinkFlow() {
        let app = launchApp(providerScenario: "notLinked")
        simulateParkFromHome(app)

        let link = element(app, "parkedSheet.linkProviderButton")
        XCTAssertTrue(link.waitForExistence(timeout: 5), "Link action missing")
        XCTAssertEqual(link.label, "Link ParkNYC")
        XCTAssertFalse(element(app, "parkedSheet.payButton").exists, "Pay should be replaced by Link")

        link.tap()
        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5), "Link flow did not open")
        element(app, "link.continueButton").tap()
        let signIn = element(app, "link.mockSignInButton")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        signIn.tap()
        XCTAssertTrue(element(app, "link.done").waitForExistence(timeout: 10))
        element(app, "link.doneButton").tap()

        // Back on the sheet, paying is offered again.
        XCTAssertTrue(
            element(app, "parkedSheet.payButton").waitForExistence(timeout: 5),
            "Pay did not come back after linking"
        )
    }

    /// The link answers at once and the screen shows the job's real step
    /// and the time so far. A slow provider keeps it on "Checking your
    /// ParkNYC sign-in…"; after 20 seconds the user may move on, and is
    /// told a notification will say how it went.
    func testSlowLinkShowsTheStepAndLetsTheUserMoveOn() {
        let app = launchApp(providerScenario: "linkSlow")
        simulateParkFromHome(app)
        let link = element(app, "parkedSheet.linkProviderButton")
        XCTAssertTrue(link.waitForExistence(timeout: 5), "Link action missing")
        link.tap()
        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5), "Link flow did not open")
        element(app, "link.continueButton").tap()
        let signIn = element(app, "link.mockSignInButton")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        signIn.tap()

        let step = element(app, "link.progress.step")
        XCTAssertTrue(step.waitForExistence(timeout: 5), "Progress step missing")
        waitForLabel(of: step, toBe: "Checking your ParkNYC sign-in…")
        let elapsed = element(app, "link.progress.elapsed")
        XCTAssertTrue(elapsed.waitForExistence(timeout: 2))
        let firstElapsed = elapsed.label
        // Not offered early: most links finish well inside 20 s.
        XCTAssertFalse(element(app, "link.continueInBackground").exists, "Continue offered too early")
        attachScreenshot(of: app, named: "pr-link-progress")

        let moveOn = element(app, "link.continueInBackground")
        XCTAssertTrue(moveOn.waitForExistence(timeout: 30), "Continue never appeared")
        XCTAssertNotEqual(elapsed.label, firstElapsed, "Elapsed time did not advance")
        attachScreenshot(of: app, named: "pr-link-continue")
        moveOn.tap()

        XCTAssertTrue(element(app, "link.continuing").waitForExistence(timeout: 5), "No 'we'll let you know' screen")
        element(app, "link.continuingDone").tap()
        // Back on the sheet; nothing is linked yet, so it still offers Link.
        XCTAssertTrue(
            element(app, "parkedSheet.linkProviderButton").waitForExistence(timeout: 5),
            "Should be back on the parked sheet"
        )
    }

    /// An expired link shows "Sign in again" in the Account sheet, with a
    /// reconnect action that opens the flow.
    func testAccountSheetShowsExpiredProvider() {
        let app = launchApp(providerScenario: "expired")
        openAccountSheet(app)

        let row = scrollTo(app, "account.provider.parknyc")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "ParkNYC row missing")
        XCTAssertTrue(app.staticTexts["Sign in again"].exists, "Expired pill missing")

        element(app, "account.providerLink.parknyc").tap()
        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5), "Re-link did not open")
        element(app, "link.cancelButton").tap()
    }
}
