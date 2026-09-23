import XCTest

final class SettingsUITests: ParkAgentUITestCase {
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
