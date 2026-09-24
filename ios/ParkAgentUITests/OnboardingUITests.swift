import XCTest

/// Onboarding after sign-in: permissions → vehicle → city → payment →
/// connect provider → (add money, ParkAgent card only) → budget → done.
/// Signing in is the welcome screen's job now (see AuthUITests). Step raw
/// values used by -onboardingStep: permissions 1, vehicle 2, city 3,
/// elsewhere 4, payment 5, linkProvider 6, addMoney 7, budget 8, done 9.
final class OnboardingUITests: ParkAgentUITestCase {
    /// The whole flow on the ParkAgent-card path (issuing live): payment
    /// step offers the card, link chains the mocked card setup
    /// (adding_card → done), add money runs, ending on Home with the
    /// detected city in the status chip.
    func testFullOnboardingWithLinkSuccess() {
        let app = launchApp(providerScenario: "notLinked", skipOnboarding: false, issuingLive: true)

        // 1 — Permissions: each has its own enable button; skipping is fine.
        XCTAssertTrue(element(app, "onboarding.permissions").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "onboarding.permission.location").exists)
        XCTAssertTrue(element(app, "onboarding.permission.motion").exists)
        XCTAssertTrue(element(app, "onboarding.permission.notifications").exists)
        XCTAssertTrue(element(app, "onboarding.permissionsNote").exists, "Skip note missing")
        element(app, "onboarding.continueButton").tap()

        // 2 — Vehicle: prefilled from the account's saved car, so there
        // is nothing to retype.
        XCTAssertTrue(element(app, "onboarding.vehicle").waitForExistence(timeout: 5))
        let plate = element(app, "onboarding.plateField")
        XCTAssertTrue(plate.waitForExistence(timeout: 5))
        waitForLabel(of: element(app, "onboarding.vehicleSubtitle"),
                     toBe: "We already have this one — change it if it's wrong.")
        let advance = element(app, "onboarding.continueButton")
        XCTAssertTrue(advance.isEnabled, "A known plate should be ready to continue")
        advance.tap()

        // 3 — City: the mock server detects NYC and pre-selects it.
        XCTAssertTrue(element(app, "onboarding.city").waitForExistence(timeout: 5))
        let detected = element(app, "onboarding.cityDetected")
        XCTAssertTrue(detected.waitForExistence(timeout: 5), "Detected-city line missing")
        XCTAssertTrue(detected.label.contains("New York City"), "Wrong detected city: \(detected.label)")
        XCTAssertTrue(element(app, "onboarding.continueButton").isEnabled, "Detection should pre-select")
        element(app, "onboarding.continueButton").tap()

        // 4 — How to pay: issuing is live, so the ParkAgent card is a real
        // option; pick it (provider card is the pre-selected default).
        XCTAssertTrue(element(app, "onboarding.payment").waitForExistence(timeout: 5))
        let providerOption = element(app, "onboarding.payment.provider_card")
        XCTAssertTrue(providerOption.exists, "Provider-card option missing")
        let issuingOption = element(app, "onboarding.payment.issuing_card")
        XCTAssertTrue(issuingOption.waitForExistence(timeout: 5), "ParkAgent card should be offered when live")
        issuingOption.tap()
        element(app, "onboarding.continueButton").tap()

        // 5 — Connect ParkNYC: consent defaults to checked on the
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
        XCTAssertTrue(app.staticTexts["Connect ParkBoston"].exists, "Wrong provider on connect step")
        // Passport is passwordless: one door, so no separate sign-up button.
        XCTAssertFalse(
            element(app, "link.createAccountButton").exists,
            "ParkBoston's sign-in and sign-up are the same screen"
        )
        element(app, "onboarding.linkSkipButton").tap()
        // provider_card default: skipping the link lands on budget — there
        // is no Add money step to fund.
        XCTAssertTrue(element(app, "onboarding.budget").waitForExistence(timeout: 5))
    }

    /// Every step is resumable: a relaunch at a stored step lands there,
    /// not back at the beginning.
    func testOnboardingResumesAtTheStoredStep() {
        // Budget is step 8 — deep enough that starting over would be
        // obvious if resume didn't work.
        let app = launchApp(onboardingStep: 8, selectedCity: "nyc", skipOnboarding: false)

        XCTAssertTrue(
            element(app, "onboarding.budget").waitForExistence(timeout: 5),
            "Onboarding should resume at the budget step"
        )
        XCTAssertFalse(element(app, "onboarding.permissions").exists, "Should not restart")
    }

    /// A returning user — already onboarded — skips straight to Home.
    func testReturningUserSkipsOnboarding() {
        let app = launchApp(skipOnboarding: true)

        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "onboarding.permissions").exists, "Should not re-onboard")
    }

    /// Link-or-create: ParkNYC's connect step offers both doors, and the
    /// prefill note promises we fill what we know.
    func testConnectStepOffersSignUpForParkNYC() {
        let app = launchApp(
            providerScenario: "notLinked",
            onboardingStep: 6,
            selectedCity: "nyc",
            skipOnboarding: false
        )

        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Connect ParkNYC"].exists, "Connect heading missing")
        // The one-sentence promise from the server registry.
        let note = element(app, "link.introNote")
        XCTAssertTrue(note.exists, "Sign-up note missing")
        XCTAssertTrue(
            note.label.contains("never see your password"),
            "Note should promise we never see the password: \(note.label)"
        )
        XCTAssertTrue(
            element(app, "link.prefillNote").exists,
            "Prefill promise missing"
        )

        let createAccount = element(app, "link.createAccountButton")
        XCTAssertTrue(createAccount.exists, "ParkNYC needs a sign-up door")
        createAccount.tap()

        // The mock stands in for the provider's own sign-up page.
        let title = element(app, "link.mockTitle")
        XCTAssertTrue(title.waitForExistence(timeout: 5), "Sign-up page missing")
        XCTAssertTrue(title.label.contains("sign-up"), "Should open sign-up, got: \(title.label)")
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
