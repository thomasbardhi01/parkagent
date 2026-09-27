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
        walletScenario: String? = nil,
        linkScenario: String? = nil,
        providerScenario: String? = nil,
        cityScenario: String? = nil,
        authScenario: String? = nil,
        onboardingStep: Int? = nil,
        selectedCity: String? = nil,
        skipOnboarding: Bool = true,
        /// Most tests want to land inside the app: `-signedIn YES` seeds a
        /// mock session so the welcome screen doesn't gate them. The auth
        /// tests pass false and drive the real sign-in.
        signedIn: Bool = true,
        appearance: String? = nil,
        paymentSource: String? = nil,
        issuingLive: Bool = false,
        /// Diagnostics' ParkAgent-card sandbox toggle. On for tests, as a
        /// Debug build always behaved before the toggle existed; the
        /// toggle's own test turns it off.
        parkAgentSandbox: Bool = true,
        /// Sign in as someone who isn't the operator: GET /policy says the
        /// shared limits aren't theirs to edit.
        policyReadOnly: Bool = false,
        googleSignIn: Bool = false,
        /// The mock server's switched-on sign-in methods; nil = its
        /// default, Apple only (as a real deployment ships).
        authMethods: String? = nil,
        /// The phone's permission state (CapabilityOverride spec). Default:
        /// everything granted, so flows that aren't about permissions pass
        /// the permissions step; nil = the simulator's real grants.
        capabilities: String? = "granted",
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var args = [
            "-resetState", "YES",
            "-useMockAPI", "YES",
            "-uiTesting", "YES",
            "-mockScenario", scenario,
            "-fixedNow", Self.fixedNow,
        ]
        if signedIn { args += ["-signedIn", "YES"] }
        if let authScenario { args += ["-authScenario", authScenario] }
        if googleSignIn { args += ["-googleSignIn", "YES"] }
        if let authMethods { args += ["-authMethods", authMethods] }
        if skipOnboarding { args += ["-skipOnboarding", "YES"] }
        if let appearance { args += ["-appearance", appearance] }
        if let walletScenario { args += ["-walletScenario", walletScenario] }
        if let linkScenario { args += ["-linkScenario", linkScenario] }
        if let providerScenario { args += ["-providerScenario", providerScenario] }
        if let cityScenario { args += ["-cityScenario", cityScenario] }
        if let onboardingStep { args += ["-onboardingStep", String(onboardingStep)] }
        if let selectedCity { args += ["-selectedCity", selectedCity] }
        if let paymentSource { args += ["-paymentSource", paymentSource] }
        if issuingLive { args += ["-issuingLive", "YES"] }
        args += ["-parkAgentSandbox", parkAgentSandbox ? "YES" : "NO"]
        if policyReadOnly { args += ["-policyReadOnly", "YES"] }
        if let capabilities { args += ["-capabilities", capabilities] }
        app.launchArguments = args + extraArguments
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

    /// Open the Account sheet from the Park tab's avatar button (the
    /// Settings tab is gone; everything it held lives here now).
    @discardableResult
    func openAccountSheet(_ app: XCUIApplication) -> XCUIElement {
        selectTab(app, "Park")
        let avatar = element(app, "home.accountButton")
        XCTAssertTrue(avatar.waitForExistence(timeout: 5), "Account button missing on Home")
        avatar.tap()
        let sheet = element(app, "account.view")
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "Account sheet did not open")
        return sheet
    }

    /// The Wallet tab, loaded (its hero is on screen).
    func openWallet(_ app: XCUIApplication) {
        selectTab(app, "Wallet")
        XCTAssertTrue(
            app.navigationBars["Wallet"].waitForExistence(timeout: 5),
            "Wallet tab missing"
        )
    }

    /// Taps a tab, and makes sure the tap took. On iOS 26 the tab bar can
    /// drop a tap outright: CI run 36325468638's recording shows the
    /// selection lens start from Park toward Wallet, stop halfway, and
    /// slide back while the map's first tiles were rendering — Park stayed
    /// selected, the Wallet screen never showed, and the test failed
    /// "Wallet tab missing". So a tap the tab bar dropped is tapped once
    /// more, and the retry is recorded in the result bundle. (A tap on the
    /// tab already selected still goes through: it returns that tab to its
    /// root, which callers rely on.)
    @discardableResult
    func selectTab(_ app: XCUIApplication, _ name: String) -> Bool {
        let tab = app.tabBars.buttons[name]
        guard tab.waitForExistence(timeout: 5) else { return false }
        let wasSelected = tab.isSelected
        tab.tap()
        if wasSelected || waitForSelection(of: tab, timeout: 3) { return true }
        XCTContext.runActivity(named: "The \(name) tab dropped the tap; tapping it once more") { _ in }
        tab.tap()
        return waitForSelection(of: tab, timeout: 3)
    }

    private func waitForSelection(of element: XCUIElement, timeout: TimeInterval) -> Bool {
        let selected = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "selected == true"),
            object: element
        )
        return XCTWaiter().wait(for: [selected], timeout: timeout) == .completed
    }

    /// Swipes up until the identifier is in the hierarchy AND tappable —
    /// hittable and clear of the floating tab bar. SwiftUI Form is a lazy
    /// List, so rows below the fold don't exist until scrolled near; but
    /// "exists" alone isn't enough either. CI run 36014956437 stopped with
    /// the version row at y 872–924 under a tab bar starting at y 873, and
    /// all five "taps on the version" landed on the tab bar instead.
    ///
    /// Each attempt polls for a beat before deciding to swipe: a row still
    /// animating in — or waiting on an async state flip, like Link wallet's
    /// Connect turning into Connected + Disconnect — reports neither
    /// existing nor hittable for a moment, and scrolling past it would
    /// trade one flake for another. Scroll for a post-interaction target
    /// too: content that grows can push it past the fold with no scroll.
    @discardableResult
    func scrollTo(_ app: XCUIApplication, _ identifier: String, swipes: Int = 8) -> XCUIElement {
        let target = element(app, identifier)
        for attempt in 0...swipes {
            if target.waitForExistence(timeout: 1), isTappable(app, target) { return target }
            if attempt < swipes { app.swipeUp() }
        }
        return target
    }

    private func isTappable(_ app: XCUIApplication, _ element: XCUIElement) -> Bool {
        guard element.exists, element.isHittable else { return false }
        // Only a tab bar that can take the tap is in the way: under the
        // Account sheet it is still in the tree but covered.
        let tabBar = app.tabBars.firstMatch
        guard tabBar.exists, tabBar.isHittable else { return true }
        return element.frame.maxY <= tabBar.frame.minY
    }

    /// Unlocks and opens the hidden Diagnostics screen: the Account sheet,
    /// scroll to the version row, tap it five times, follow the revealed
    /// link.
    func openDiagnostics(_ app: XCUIApplication) {
        openAccountSheet(app)
        let version = scrollTo(app, "account.versionRow")
        XCTAssertTrue(version.waitForExistence(timeout: 5), "Version row missing")
        for _ in 0..<5 {
            version.tap()
        }
        // The link appears in the row below the version — possibly below
        // the fold, so scroll it clear before tapping.
        let link = scrollTo(app, "account.diagnosticsLink", swipes: 4)
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

    /// The Park tab's test-only Simulate park (DEBUG + -uiTesting + mock).
    /// It is the only way a test parks: nothing a person can reach
    /// simulates one, Diagnostics included.
    func simulateParkFromHome(_ app: XCUIApplication) {
        selectTab(app, "Park")
        let simulate = element(app, "home.simulateParkButton")
        XCTAssertTrue(simulate.waitForExistence(timeout: 5), "Simulate park button missing")
        simulate.tap()
        XCTAssertTrue(
            element(app, "parkedSheet.view").waitForExistence(timeout: 5),
            "Parking Detected sheet did not appear"
        )
    }

    /// Waits until the element's label CONTAINS `substring` — for composed
    /// labels like the Home chip's "Boston · No active session", where an
    /// equality wait would be brittle.
    func waitForLabelContaining(
        _ element: XCUIElement,
        _ substring: String,
        timeout: TimeInterval = 10
    ) {
        let predicate = NSPredicate(format: "label CONTAINS %@", substring)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(
            XCTWaiter().wait(for: [expectation], timeout: timeout), .completed,
            "Expected a label containing \"\(substring)\", got \"\(element.label)\""
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
