import XCTest

final class SettingsUITests: ParkAgentUITestCase {
    /// No developer clutter in the user UI, and Diagnostics only after five
    /// taps on the version number.
    func testDiagnosticsIsHiddenBehindFiveVersionTaps() {
        let app = launchApp()
        app.tabBars.buttons["Settings"].tap()

        // Nothing developer-ish on the screen itself.
        XCTAssertFalse(app.staticTexts["Developer"].exists, "Developer section still in Settings")
        XCTAssertFalse(element(app, "settings.mockToggle").exists, "Mock toggle still in Settings")
        XCTAssertFalse(element(app, "settings.scenarioPicker").exists, "Scenario picker still in Settings")

        let version = scrollTo(app, "settings.versionRow")
        XCTAssertTrue(version.waitForExistence(timeout: 5), "Version row missing")

        // Four taps is not enough — it must be deliberate.
        for _ in 0..<4 { version.tap() }
        XCTAssertFalse(
            element(app, "settings.diagnosticsLink").exists,
            "Diagnostics revealed before the fifth tap"
        )
        version.tap()

        let link = element(app, "settings.diagnosticsLink")
        XCTAssertTrue(link.waitForExistence(timeout: 5), "Fifth tap did not reveal Diagnostics")
        link.tap()

        XCTAssertTrue(element(app, "diagnostics.view").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "diagnostics.detectorStatus").exists, "Detector status missing")
        // The rest of the Form is lazy: scroll each one into existence.
        for identifier in [
            "diagnostics.simulateParkButton",
            "diagnostics.signalLogToggle",
            "diagnostics.apiBase",
            // The commit comes from /health; the mock answers "mock".
            "diagnostics.commit",
            "diagnostics.resetOnboardingButton",
        ] {
            XCTAssertTrue(scrollTo(app, identifier).exists, "\(identifier) missing from Diagnostics")
        }
    }

    /// A Boston user must never be told their card is on ParkNYC. The
    /// payment row used to fall back to the registry's own order (NYC
    /// first) whenever the city picker sat on "Detect automatically".
    func testPaymentRowNamesTheDetectedCitysProvider() {
        let app = launchApp(cityScenario: "bos")
        // Home detects the city first; the chip is the signal that it did.
        let chip = element(app, "home.statusChip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        waitForLabelContaining(chip, "Boston")

        app.tabBars.buttons["Settings"].tap()
        let providerRow = element(app, "settings.payment.provider_card")
        XCTAssertTrue(providerRow.waitForExistence(timeout: 5), "Provider-card row missing")
        XCTAssertEqual(
            providerRow.label, "My card on ParkBoston",
            "The payment row should name the detected city's provider"
        )
    }

    /// Reset onboarding clears the completion flag and lands back on the flow.
    func testResetOnboardingReturnsToTheFlow() {
        let app = launchApp()
        openDiagnostics(app)
        // Reset is the last section: scroll it into the hierarchy first.
        scrollTo(app, "diagnostics.resetOnboardingButton").tap()
        app.buttons["Reset"].tap()
        XCTAssertTrue(
            element(app, "onboarding.welcome").waitForExistence(timeout: 10),
            "Reset did not return to onboarding"
        )
    }

    /// Switching Appearance to Dark flips the applied color scheme, read back
    /// through the hidden probe label MainTabView exposes under -uiTesting.
    func testAppearanceSwitchAppliesDarkScheme() {
        // No -appearance argument: the setting must start on System.
        let app = launchApp()

        let probe = element(app, "root.colorSchemeProbe")
        XCTAssertTrue(probe.waitForExistence(timeout: 5), "Color-scheme probe missing")
        XCTAssertTrue(["light", "dark"].contains(probe.label))

        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(element(app, "settings.appearancePicker").waitForExistence(timeout: 5))

        app.buttons["Dark"].tap()
        waitForLabel(of: probe, toBe: "dark")

        app.buttons["Light"].tap()
        waitForLabel(of: probe, toBe: "light")
    }

    /// Payment section: provider card selected by default, ParkAgent card
    /// reads coming soon and taps only raise the alert (issuing off).
    func testPaymentSourceComingSoonWhileIssuingOff() {
        let app = launchApp()
        app.tabBars.buttons["Settings"].tap()

        let providerRow = element(app, "settings.payment.provider_card")
        XCTAssertTrue(providerRow.waitForExistence(timeout: 5), "Provider-card row missing")
        XCTAssertEqual(providerRow.value as? String, "selected")

        let comingSoon = element(app, "settings.payment.comingSoon")
        XCTAssertTrue(comingSoon.exists, "Coming-soon row missing while issuing is off")
        comingSoon.tap()
        XCTAssertTrue(app.alerts["Coming soon"].waitForExistence(timeout: 5))
        app.alerts["Coming soon"].buttons["OK"].tap()

        // Still on the provider card.
        XCTAssertEqual(providerRow.value as? String, "selected")
    }

    /// With issuing live, the ParkAgent card is a real row and switching
    /// sticks (mock persists like the server row).
    func testPaymentSourceSwitchWhenIssuingLive() {
        let app = launchApp(issuingLive: true)
        app.tabBars.buttons["Settings"].tap()

        let issuingRow = element(app, "settings.payment.issuing_card")
        XCTAssertTrue(issuingRow.waitForExistence(timeout: 5), "ParkAgent-card row missing when live")
        XCTAssertEqual(issuingRow.value as? String, "not selected")
        issuingRow.tap()

        let predicate = NSPredicate(format: "value == %@", "selected")
        let switched = XCTNSPredicateExpectation(predicate: predicate, object: issuingRow)
        XCTAssertEqual(XCTWaiter().wait(for: [switched], timeout: 5), .completed, "Switch did not stick")
        XCTAssertEqual(element(app, "settings.payment.provider_card").value as? String, "not selected")
    }

    /// The city override pins the Home chip's city, no detection needed.
    func testCityOverrideUpdatesHomeChip() {
        let app = launchApp()

        let chip = element(app, "home.statusChip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertFalse(chip.label.contains("Boston"), "No city should show before the override")

        app.tabBars.buttons["Settings"].tap()
        let picker = element(app, "settings.cityPicker")
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "City picker missing")
        picker.tap()
        app.buttons["Boston"].firstMatch.tap()

        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertTrue(chip.label.contains("Boston"), "Chip should show the override: \(chip.label)")
    }
}
