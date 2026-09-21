import XCTest

/// The rebuilt onboarding: welcome → permissions → vehicle → city → link
/// provider → add money → budget → done. Step raw values used by
/// -onboardingStep: welcome 0, permissions 1, vehicle 2, city 3,
/// elsewhere 4, linkProvider 5, addMoney 6, budget 7, done 8.
final class OnboardingUITests: ParkAgentUITestCase {
    /// The whole flow with a mocked link success and the mocked
    /// link-status progression (adding_card → done), ending on Home with
    /// the detected city in the status chip.
    func testFullOnboardingWithLinkSuccess() {
        let app = launchApp(providerScenario: "notLinked", skipOnboarding: false)

        // 1 — Welcome.
        XCTAssertTrue(element(app, "onboarding.welcome").waitForExistence(timeout: 5))
        element(app, "onboarding.continueButton").tap()

        // 2 — Permissions: each has its own enable button; skipping is fine.
        XCTAssertTrue(element(app, "onboarding.permissions").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "onboarding.permission.location").exists)
        XCTAssertTrue(element(app, "onboarding.permission.motion").exists)
        XCTAssertTrue(element(app, "onboarding.permission.notifications").exists)
        XCTAssertTrue(element(app, "onboarding.permissionsNote").exists, "Skip note missing")
        element(app, "onboarding.continueButton").tap()

        // 3 — Vehicle: loose plate validation gates Continue.
        XCTAssertTrue(element(app, "onboarding.vehicle").waitForExistence(timeout: 5))
        let advance = element(app, "onboarding.continueButton")
        XCTAssertFalse(advance.isEnabled, "Continue must wait for a plate")
        let plate = element(app, "onboarding.plateField")
        plate.tap()
        plate.typeText("ABC1234")
        let state = element(app, "onboarding.stateField")
        state.tap()
        state.typeText("NY")
        XCTAssertTrue(advance.isEnabled, "Plate + state should be enough")
        advance.tap()

        // 4 — City: the mock server detects NYC and pre-selects it.
        XCTAssertTrue(element(app, "onboarding.city").waitForExistence(timeout: 5))
        let detected = element(app, "onboarding.cityDetected")
        XCTAssertTrue(detected.waitForExistence(timeout: 5), "Detected-city line missing")
        XCTAssertTrue(detected.label.contains("New York City"), "Wrong detected city: \(detected.label)")
        XCTAssertTrue(element(app, "onboarding.continueButton").isEnabled, "Detection should pre-select")
        element(app, "onboarding.continueButton").tap()

        // 5 — Link ParkNYC: consent defaults to checked; the mock sign-in
        // stands in for the provider's login page.
        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "link.consentToggle").value as? String, "checked")
        element(app, "link.continueButton").tap()
        let signIn = element(app, "link.mockSignInButton")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5), "Mock sign-in missing")
        signIn.tap()
        // linking → adding_card → done, then through to add money.
        XCTAssertTrue(element(app, "link.done").waitForExistence(timeout: 10), "Link did not finish")
        element(app, "link.doneButton").tap()

        // 6 — Add money: dry run shows the banner; Apple Pay completes
        // without charging.
        XCTAssertTrue(element(app, "addMoney.view").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "addMoney.dryRunBanner").exists, "Dry-run banner missing")
        element(app, "addMoney.quick.50").tap()
        element(app, "addMoney.applePayButton").tap()
        XCTAssertTrue(element(app, "addMoney.doneNotice").waitForExistence(timeout: 5))
        element(app, "addMoney.doneButton").tap()

        // 7 — Budget: preview sentence tracks the caps; save through the mock.
        XCTAssertTrue(element(app, "onboarding.budget").waitForExistence(timeout: 5))
        let preview = element(app, "onboarding.budgetPreview")
        XCTAssertTrue(preview.exists)
        XCTAssertTrue(preview.label.contains("$45.00"), "Preview should show the session cap")
        element(app, "onboarding.continueButton").tap()

        // 8 — Done → Home, with the city in the status chip.
        XCTAssertTrue(element(app, "onboarding.done").waitForExistence(timeout: 5))
        element(app, "onboarding.goHomeButton").tap()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 5))
        let chip = element(app, "home.statusChip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertTrue(chip.label.contains("New York City"), "Chip should show the city: \(chip.label)")
    }

    /// Chained card setup fails once (typed reason in plain words), retry
    /// succeeds.
    func testFailedLinkRetrySucceeds() {
        let app = launchApp(
            providerScenario: "linkFails",
            onboardingStep: 5,
            selectedCity: "nyc",
            skipOnboarding: false
        )

        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5))
        element(app, "link.continueButton").tap()
        let signIn = element(app, "link.mockSignInButton")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        signIn.tap()

        XCTAssertTrue(element(app, "link.failed").waitForExistence(timeout: 10), "Failure state missing")
        let reason = element(app, "link.reasonLabel")
        XCTAssertTrue(reason.exists)
        XCTAssertTrue(reason.label.contains("connection"), "Reason should be plain words: \(reason.label)")

        element(app, "link.retryButton").tap()
        XCTAssertTrue(element(app, "link.done").waitForExistence(timeout: 10), "Retry did not finish")
        element(app, "link.doneButton").tap()
        XCTAssertTrue(element(app, "addMoney.view").waitForExistence(timeout: 5))
    }

    /// Boston fixtures: detection names Boston and Passport, and the link
    /// step targets the Passport account. Skipping the link still lands on
    /// add money.
    func testBostonCityDetection() {
        let app = launchApp(
            providerScenario: "notLinked",
            cityScenario: "bos",
            onboardingStep: 3,
            skipOnboarding: false
        )

        XCTAssertTrue(element(app, "onboarding.city").waitForExistence(timeout: 5))
        let detected = element(app, "onboarding.cityDetected")
        XCTAssertTrue(detected.waitForExistence(timeout: 5))
        XCTAssertTrue(detected.label.contains("Boston"), "Wrong city: \(detected.label)")
        XCTAssertTrue(detected.label.contains("ParkBoston"), "Provider missing: \(detected.label)")
        element(app, "onboarding.continueButton").tap()

        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Sign in to ParkBoston"].exists, "Wrong provider on link step")
        element(app, "onboarding.linkSkipButton").tap()
        XCTAssertTrue(element(app, "addMoney.view").waitForExistence(timeout: 5))
    }

    /// "Somewhere else" explains we're not there yet and finishes without
    /// a provider.
    func testSomewhereElseFinishesOnboarding() {
        let app = launchApp(cityScenario: "none", onboardingStep: 3, skipOnboarding: false)

        XCTAssertTrue(element(app, "onboarding.city").waitForExistence(timeout: 5))
        // Wait for detection to settle first — the options shift up when
        // the "checking" row is replaced, and a tap mid-shift misses.
        XCTAssertTrue(element(app, "onboarding.cityUnknown").waitForExistence(timeout: 5))
        let other = element(app, "onboarding.city.other")
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.tap()
        element(app, "onboarding.continueButton").tap()

        XCTAssertTrue(element(app, "onboarding.elsewhere").waitForExistence(timeout: 5))
        element(app, "onboarding.finishButton").tap()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 5))
    }
}
