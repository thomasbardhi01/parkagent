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
