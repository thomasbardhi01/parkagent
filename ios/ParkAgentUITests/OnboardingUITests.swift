import XCTest

final class OnboardingUITests: ParkAgentUITestCase {
    /// Three steps advance, the permissions step is skippable, and the app
    /// lands on Home.
    func testOnboardingWalkthroughLandsOnHome() {
        let app = launchApp(skipOnboarding: false)

        XCTAssertTrue(element(app, "onboarding.view").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "onboarding.welcome").waitForExistence(timeout: 5))

        let advance = element(app, "onboarding.continueButton")
        advance.tap()
        XCTAssertTrue(element(app, "onboarding.howItWorks").waitForExistence(timeout: 5))

        advance.tap()
        XCTAssertTrue(element(app, "onboarding.permissions").waitForExistence(timeout: 5))
        waitForLabel(of: advance, toBe: "Get started")

        // Skip both permission grants; "Get started" must work regardless.
        advance.tap()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "home.statusChip").waitForExistence(timeout: 5))
    }
}
