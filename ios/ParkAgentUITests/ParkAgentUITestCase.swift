import XCTest

/// Base for all ParkAgent UI tests. Every test launches the app fresh with
/// the mock API, a wiped UserDefaults, and a frozen clock, so nothing depends
/// on the network, real sensors, or wall-clock time.
class ParkAgentUITestCase: XCTestCase {
    /// 2026-09-15 10:30 ET, a Tuesday inside enforcement hours.
    static let fixedNow = "1789482600"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func launchApp(
        scenario: String = "singleQuote",
        cardScenario: String? = nil,
        providerScenario: String? = nil,
        cityScenario: String? = nil,
        onboardingStep: Int? = nil,
        selectedCity: String? = nil,
        skipOnboarding: Bool = true,
        appearance: String? = nil,
        paymentSource: String? = nil,
        issuingLive: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var args = [
            "-resetState", "YES",
            "-useMockAPI", "YES",
            "-uiTesting", "YES",
            "-mockScenario", scenario,
            "-fixedNow", Self.fixedNow,
        ]
        if skipOnboarding { args += ["-skipOnboarding", "YES"] }
        if let appearance { args += ["-appearance", appearance] }
        if let cardScenario { args += ["-cardScenario", cardScenario] }
        if let providerScenario { args += ["-providerScenario", providerScenario] }
        if let cityScenario { args += ["-cityScenario", cityScenario] }
        if let onboardingStep { args += ["-onboardingStep", String(onboardingStep)] }
        if let selectedCity { args += ["-selectedCity", selectedCity] }
        if let paymentSource { args += ["-paymentSource", paymentSource] }
        if issuingLive { args += ["-issuingLive", "YES"] }
        app.launchArguments = args
        app.launch()
        return app
    }

    /// Identifier lookup across element types — SwiftUI containers surface as
    /// otherElements, rows as buttons or cells, so pinning a type is fragile.
    func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Settings > (five taps on the version) > Diagnostics > Simulate park,
    /// then wait for the sheet. Mirrors how a human reaches the hidden
    /// screen — there is no Developer section any more.
    func simulateParkViaDiagnostics(_ app: XCUIApplication) {
        openDiagnostics(app)
        let simulate = element(app, "diagnostics.simulateParkButton")
        XCTAssertTrue(simulate.waitForExistence(timeout: 5), "Simulate park button missing")
        simulate.tap()
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForExistence(timeout: 5),
            "Parking Detected sheet did not appear"
        )
    }

    /// Swipes up until the identifier is in the hierarchy. SwiftUI Form is a
    /// lazy List: rows below the fold do not exist until scrolled into view,
    /// so `.exists` on them is false rather than merely off-screen.
    @discardableResult
    func scrollTo(_ app: XCUIApplication, _ identifier: String, swipes: Int = 8) -> XCUIElement {
        let target = element(app, identifier)
        var attempts = 0
        while !target.exists && attempts < swipes {
            app.swipeUp()
            attempts += 1
        }
        return target
    }

    /// Unlocks and opens the hidden Diagnostics screen: Settings, scroll to
    /// the version row, tap it five times, follow the revealed link.
    func openDiagnostics(_ app: XCUIApplication) {
        app.tabBars.buttons["Settings"].tap()
        let version = scrollTo(app, "settings.versionRow")
        XCTAssertTrue(version.waitForExistence(timeout: 5), "Version row missing")
        for _ in 0..<5 {
            version.tap()
        }
        let link = element(app, "settings.diagnosticsLink")
        XCTAssertTrue(
            link.waitForExistence(timeout: 5),
            "Five taps on the version number did not reveal Diagnostics"
        )
        link.tap()
        XCTAssertTrue(
            element(app, "diagnostics.view").waitForExistence(timeout: 5),
            "Diagnostics screen did not open"
        )
    }

    /// Home sheet's Simulate park (mock + no active session only).
    func simulateParkFromHome(_ app: XCUIApplication) {
        app.tabBars.buttons["Home"].tap()
        let simulate = element(app, "home.simulateParkButton")
        XCTAssertTrue(simulate.waitForExistence(timeout: 5), "Simulate park button missing")
        simulate.tap()
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForExistence(timeout: 5),
            "Parking Detected sheet did not appear"
        )
    }

    /// Waits until the element's label equals `expected`; XCUIElement has no
    /// built-in "label became X" wait.
    func waitForLabel(of element: XCUIElement, toBe expected: String, timeout: TimeInterval = 5) {
        let predicate = NSPredicate(format: "label == %@", expected)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(
            XCTWaiter().wait(for: [expectation], timeout: timeout), .completed,
            "Expected label \"\(expected)\", got \"\(element.label)\""
        )
    }
}
