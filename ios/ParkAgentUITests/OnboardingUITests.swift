import XCTest

/// The rebuilt onboarding: welcome → permissions → vehicle → city →
/// payment → link provider → (add money, ParkAgent card only) → budget →
/// done. Step raw values used by -onboardingStep: welcome 0,
/// permissions 1, vehicle 2, city 3, elsewhere 4, payment 5,
/// linkProvider 6, addMoney 7, budget 8, done 9.
final class OnboardingUITests: ParkAgentUITestCase {
    /// The whole flow on the ParkAgent-card path (issuing live): payment
    /// step offers the card, link chains the mocked card setup
    /// (adding_card → done), add money runs, ending on Home with the
    /// detected city in the status chip.
    func testFullOnboardingWithLinkSuccess() {
        let app = launchApp(providerScenario: "notLinked", skipOnboarding: false, issuingLive: true)

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

        // 5 — How to pay: issuing is live, so the ParkAgent card is a real
        // option; pick it (provider card is the pre-selected default).
        XCTAssertTrue(element(app, "onboarding.payment").waitForExistence(timeout: 5))
        let providerOption = element(app, "onboarding.payment.provider_card")
        XCTAssertTrue(providerOption.exists, "Provider-card option missing")
        let issuingOption = element(app, "onboarding.payment.issuing_card")
        XCTAssertTrue(issuingOption.waitForExistence(timeout: 5), "ParkAgent card should be offered when live")
        issuingOption.tap()
        element(app, "onboarding.continueButton").tap()

        // 6 — Link ParkNYC: consent defaults to checked on the
        // ParkAgent-card path; the mock sign-in stands in for the
        // provider's login page.
        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5))
        XCTAssertEqual(element(app, "link.consentToggle").value as? String, "checked")
        element(app, "link.continueButton").tap()
        let signIn = element(app, "link.mockSignInButton")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5), "Mock sign-in missing")
        signIn.tap()
        // linking → adding_card → done, then through to add money.
        XCTAssertTrue(element(app, "link.done").waitForExistence(timeout: 10), "Link did not finish")
        element(app, "link.doneButton").tap()

        // 7 — Add money: dry run shows the banner; Apple Pay completes
        // without charging.
        XCTAssertTrue(element(app, "addMoney.view").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "addMoney.dryRunBanner").exists, "Dry-run banner missing")
        element(app, "addMoney.quick.50").tap()
        element(app, "addMoney.applePayButton").tap()
        XCTAssertTrue(element(app, "addMoney.doneNotice").waitForExistence(timeout: 5))
        element(app, "addMoney.doneButton").tap()

        // 8 — Budget: preview sentence tracks the caps; save through the mock.
        XCTAssertTrue(element(app, "onboarding.budget").waitForExistence(timeout: 5))
        let preview = element(app, "onboarding.budgetPreview")
        XCTAssertTrue(preview.exists)
        XCTAssertTrue(preview.label.contains("$45.00"), "Preview should show the session cap")
        element(app, "onboarding.continueButton").tap()

        // 9 — Done → Home, with the city in the status chip.
        XCTAssertTrue(element(app, "onboarding.done").waitForExistence(timeout: 5))
        element(app, "onboarding.goHomeButton").tap()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 5))
        let chip = element(app, "home.statusChip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertTrue(chip.label.contains("New York City"), "Chip should show the city: \(chip.label)")
    }

    /// The default path: provider_card pre-selected, ParkAgent card shown
    /// as coming soon, link intro explains the account's card keeps
    /// paying (no consent toggle), and Add money is skipped entirely.
    func testProviderCardDefaultSkipsCardAndFunding() {
        let app = launchApp(
            providerScenario: "notLinked",
            onboardingStep: 5,
            selectedCity: "nyc",
            skipOnboarding: false
        )

        XCTAssertTrue(element(app, "onboarding.payment").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "onboarding.payment.provider_card").exists)
        XCTAssertTrue(
            element(app, "onboarding.payment.comingSoon").exists,
            "ParkAgent card should read coming soon while issuing is off"
        )
        element(app, "onboarding.continueButton").tap()

        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5))
        XCTAssertFalse(
            element(app, "link.consentToggle").exists,
            "provider_card users must not be asked for card-replacement consent"
        )
        XCTAssertTrue(element(app, "link.providerCardNote").exists, "Provider-card note missing")
        element(app, "link.continueButton").tap()
        let signIn = element(app, "link.mockSignInButton")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        signIn.tap()
        XCTAssertTrue(element(app, "link.done").waitForExistence(timeout: 10), "Link did not finish")
        element(app, "link.doneButton").tap()

        // Straight to budget — no Add money for provider_card users.
        XCTAssertTrue(element(app, "onboarding.budget").waitForExistence(timeout: 5))
    }

    /// Chained card setup fails once (typed reason in plain words), retry
    /// succeeds. ParkAgent-card path — only issuing_card users chain the
    /// card setup at all.
    func testFailedLinkRetrySucceeds() {
        let app = launchApp(
            providerScenario: "linkFails",
            onboardingStep: 6,
            selectedCity: "nyc",
            skipOnboarding: false,
            paymentSource: "issuing_card",
            issuingLive: true
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

        // Payment step names the Boston provider on its default option.
        XCTAssertTrue(element(app, "onboarding.payment").waitForExistence(timeout: 5))
        XCTAssertTrue(
            element(app, "onboarding.payment.provider_card").label.contains("ParkBoston"),
            "Default option should name ParkBoston"
        )
        element(app, "onboarding.continueButton").tap()

        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Sign in to ParkBoston"].exists, "Wrong provider on link step")
        element(app, "onboarding.linkSkipButton").tap()
        // provider_card default: skipping the link lands on budget — there
        // is no Add money step to fund.
        XCTAssertTrue(element(app, "onboarding.budget").waitForExistence(timeout: 5))
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

    /// A returning user the gate sends back into onboarding (a lapsed
    /// provider link, a revoked permission) already has hasOnboarded set.
    /// Finishing must land on Home. It used to leave them on Done: the flow
    /// signalled completion by setting a flag that was already true, so
    /// RootView saw no change.
    func testReturningUserFinishingOnboardingLandsOnHome() {
        // The default -skipOnboarding sets the flag; -onboardingStep 9
        // (done) is the gate having found something missing.
        let app = launchApp(onboardingStep: 9)

        XCTAssertTrue(element(app, "onboarding.done").waitForExistence(timeout: 5))
        element(app, "onboarding.goHomeButton").tap()
        XCTAssertTrue(
            element(app, "home.statusChip").waitForExistence(timeout: 5),
            "Finishing onboarding left a returning user on the Done screen"
        )
    }
}
