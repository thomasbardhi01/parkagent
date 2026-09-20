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
}
