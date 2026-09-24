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
