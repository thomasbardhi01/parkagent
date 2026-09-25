import XCTest

/// The Account sheet behind Home's avatar button — what used to be the
/// Settings tab, plus the account itself. Every action the sheet offers
/// has a test here.
final class AccountUITests: ParkAgentUITestCase {
    /// The tab bar is Park · Activity · Wallet; Settings lives in the
    /// sheet, and the old Card and Sessions tabs are gone.
    func testSettingsTabIsGoneAndAccountSheetOpens() {
        let app = launchApp()

        XCTAssertTrue(app.tabBars.buttons["Park"].waitForExistence(timeout: 5))
        XCTAssertEqual(
            app.tabBars.buttons.allElementsBoundByIndex.map { $0.label },
            ["Park", "Activity", "Wallet"]
        )
        XCTAssertFalse(app.tabBars.buttons["Settings"].exists, "Settings tab should be gone")

        openAccountSheet(app)
        XCTAssertTrue(element(app, "account.profileRow").exists, "Profile row missing")
    }

    /// Name and phone round-trip through PATCH /me.
    func testEditProfileNameAndPhone() {
        let app = launchApp()
        openAccountSheet(app)

        element(app, "account.profileLink").tap()
        let nameField = element(app, "profile.nameField")
        XCTAssertTrue(nameField.waitForExistence(timeout: 5), "Name field missing")

        nameField.tap()
        // Clear whatever the mock profile starts with.
        nameField.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) {
            app.menuItems["Select All"].tap()
        }
        nameField.typeText("Tom Bardhi")

        let phoneField = element(app, "profile.phoneField")
        phoneField.tap()
        phoneField.typeText("6175550100")

        element(app, "profile.saveButton").tap()

        // Back on the sheet, the row shows the new name.
        let profileRow = element(app, "account.profileRow")
        XCTAssertTrue(profileRow.waitForExistence(timeout: 5))
        // The whole new name, not a fragment: "Tom" alone passes or fails
        // on the coincidence that "Thomas" doesn't contain it, which is
        // spelling luck rather than a discriminator. Only a successful
        // save can produce "Tom Bardhi".
        XCTAssertTrue(
            profileRow.label.contains("Tom Bardhi"),
            "Profile row should show the saved name, got: \(profileRow.label)"
        )
        // The phone isn't on the row; reopen the editor, which loads from
        // the saved profile, and read it back.
        element(app, "account.profileLink").tap()
        let savedPhone = element(app, "profile.phoneField")
        XCTAssertTrue(savedPhone.waitForExistence(timeout: 5))
        XCTAssertEqual(savedPhone.value as? String, "6175550100", "The phone didn't round-trip")
    }

    /// Add a car, see it listed, then remove it.
    func testAddAndRemoveAVehicle() {
        let app = launchApp()
        openAccountSheet(app)

        element(app, "account.vehiclesLink").tap()
        XCTAssertTrue(element(app, "vehicles.view").waitForExistence(timeout: 5), "Vehicles screen missing")

        element(app, "vehicles.addButton").tap()
        let plateField = element(app, "vehicleEditor.plateField")
        XCTAssertTrue(plateField.waitForExistence(timeout: 5), "Plate field missing")
        plateField.tap()
        plateField.typeText("XYZ987")
        let stateField = element(app, "vehicleEditor.stateField")
        stateField.tap()
        stateField.typeText("MA")
        element(app, "vehicleEditor.saveButton").tap()

        let row = element(app, "vehicles.row.XYZ987")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "New car not listed")

        row.swipeLeft()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(
            waitForDisappearance(of: row, timeout: 5),
            "Car should be gone after deleting"
        )
    }

    /// A duplicate plate is refused in plain words rather than silently
    /// doing nothing (the server's plate uniqueness is global).
    func testDuplicatePlateIsRefused() {
        let app = launchApp()
        openAccountSheet(app)
        element(app, "account.vehiclesLink").tap()
        XCTAssertTrue(element(app, "vehicles.view").waitForExistence(timeout: 5))

        element(app, "vehicles.addButton").tap()
        let plateField = element(app, "vehicleEditor.plateField")
        XCTAssertTrue(plateField.waitForExistence(timeout: 5))
        plateField.tap()
        // The mock garage already holds ABC1234.
        plateField.typeText("ABC1234")
        let stateField = element(app, "vehicleEditor.stateField")
        stateField.tap()
        stateField.typeText("NY")
        element(app, "vehicleEditor.saveButton").tap()

        let error = element(app, "vehicleEditor.errorLabel")
        XCTAssertTrue(error.waitForExistence(timeout: 5), "No message for a duplicate plate")
        XCTAssertEqual(error.label, "That plate is already registered.")
    }

    /// A connected account shows which card it will actually charge.
    func testLinkedAccountShowsMaskedCard() {
        let app = launchApp(providerScenario: "linked")
        openAccountSheet(app)

        let row = scrollTo(app, "account.provider.parknyc")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "ParkNYC row missing")
        // The masked FORM, not just the digits: only the card display
        // emits "Visa ••4242" (WalletCopy.masked), whereas a bare "4242"
        // could come from anything the row ever grows (a zone number, a
        // balance).
        XCTAssertTrue(
            row.label.contains("Visa ••4242"),
            "Connected account should show the masked card, got: \(row.label)"
        )
    }

    /// An expiring session still pays, but the sheet asks for a reconnect.
    func testExpiringAccountOffersReconnect() {
        let app = launchApp(providerScenario: "expiring")
        openAccountSheet(app)

        let reconnect = scrollTo(app, "account.providerLink.parknyc")
        XCTAssertTrue(reconnect.waitForExistence(timeout: 5), "Reconnect button missing")
        XCTAssertEqual(reconnect.label, "Reconnect")
    }

    /// Disconnect asks first, then clears the row's connected state.
    func testDisconnectConfirmsFirst() {
        let app = launchApp(providerScenario: "linked")
        openAccountSheet(app)

        let menu = scrollTo(app, "account.providerMenu.parknyc")
        XCTAssertTrue(menu.waitForExistence(timeout: 5), "Account actions menu missing")
        menu.tap()
        app.buttons["Disconnect"].firstMatch.tap()

        // The confirmation dialog, not an immediate unlink.
        let confirm = app.buttons["Disconnect"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "No confirmation before disconnecting")
        confirm.tap()

        let connect = element(app, "account.providerLink.parknyc")
        XCTAssertTrue(connect.waitForExistence(timeout: 5), "Row should offer Connect after disconnecting")
    }

    /// Spending limits are editable and report the save.
    func testEditSpendingLimits() {
        let app = launchApp()
        openAccountSheet(app)

        scrollTo(app, "account.limitsLink").tap()
        XCTAssertTrue(element(app, "limits.view").waitForExistence(timeout: 5), "Limits screen missing")

        let sessionCap = element(app, "limits.sessionCap")
        XCTAssertTrue(sessionCap.waitForExistence(timeout: 5))
        let before = sessionCap.label
        element(app, "limits.sessionCap.plus").tap()
        XCTAssertNotEqual(sessionCap.label, before, "Stepper didn't move the cap")

        element(app, "limits.saveButton").tap()
        XCTAssertTrue(
            element(app, "limits.savedOK").waitForExistence(timeout: 5),
            "No confirmation after saving limits"
        )
    }

    /// Switching Appearance to Dark flips the applied color scheme, read
    /// back through the hidden probe label MainTabView exposes.
    func testAppearanceSwitchAppliesDarkScheme() {
        // No -appearance argument: the setting must start on System.
        let app = launchApp()

        let probe = element(app, "root.colorSchemeProbe")
        XCTAssertTrue(probe.waitForExistence(timeout: 5), "Color-scheme probe missing")
        XCTAssertTrue(["light", "dark"].contains(probe.label))

        openAccountSheet(app)
        let picker = scrollTo(app, "account.appearancePicker")
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "Appearance picker missing")

        app.buttons["Dark"].tap()
        element(app, "account.doneButton").tap()
        waitForLabel(of: probe, toBe: "dark")
    }

    /// Privacy shows permission status; denied permissions get a Fix button
    /// into iOS Settings. The simulator grants nothing, so the row reads
    /// "Not requested" and no Fix button is offered.
    func testPrivacySectionShowsPermissionStatus() {
        let app = launchApp()
        openAccountSheet(app)

        let location = scrollTo(app, "account.privacy.location")
        XCTAssertTrue(location.waitForExistence(timeout: 5), "Location status row missing")
        // A fresh simulator has asked for nothing: the rows say so, and
        // with nothing DENIED there is nothing to fix.
        XCTAssertEqual(location.label, "Location, Not requested")
        // The simulator has no motion coprocessor, so the row says so.
        XCTAssertEqual(element(app, "account.privacy.motion").label, "Motion, Unavailable")
        XCTAssertFalse(element(app, "account.privacyFixButton").exists, "Fix offered with nothing denied")
    }

    /// "How you pay" is the Wallet's own answer — same words, same card —
    /// and tapping it goes to the Wallet. Account and Wallet can't disagree.
    func testHowYouPayMatchesTheWalletAndOpensIt() {
        let app = launchApp()
        // The phone is in NYC (the mock's default detection).
        waitForLabelContaining(element(app, "home.statusChip"), "New York City")
        openAccountSheet(app)

        let row = scrollTo(app, "account.howYouPay")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "How-you-pay row missing")
        waitForLabelContaining(row, "Your card on ParkNYC Visa ••4242")
        scrollTo(app, "account.howYouPayRow").tap()

        // The sheet closes onto the Wallet, whose hero says the same.
        let hero = element(app, "wallet.hero.providerCard")
        XCTAssertTrue(hero.waitForExistence(timeout: 5), "Should land on the Wallet")
        waitForLabelContaining(hero, "Your card on ParkNYC")
        waitForLabelContaining(hero, "Visa ••4242")
    }

    /// The city override pins the Home chip's city, no detection needed.
    func testCityOverrideUpdatesHomeChip() {
        let app = launchApp()

        let chip = element(app, "home.statusChip")
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertFalse(chip.label.contains("Boston"), "No city should show before the override")

        openAccountSheet(app)
        let picker = scrollTo(app, "account.cityPicker")
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "City picker missing")
        picker.tap()
        app.buttons["Boston"].firstMatch.tap()

        element(app, "account.doneButton").tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        XCTAssertTrue(chip.label.contains("Boston"), "Chip should show the override: \(chip.label)")
    }

    /// No developer clutter in the sheet, and Diagnostics only after five
    /// taps on the version number (moved here from the Settings tab).
    func testDiagnosticsIsHiddenBehindFiveVersionTaps() {
        let app = launchApp()
        openAccountSheet(app)

        let version = scrollTo(app, "account.versionRow")
        XCTAssertTrue(version.waitForExistence(timeout: 5), "Version row missing")
        // Nothing developer-ish anywhere on the sheet — checked once the
        // sheet has rendered to its last section, so these can't pass on
        // an empty screen.
        XCTAssertFalse(app.staticTexts["Developer"].exists, "Developer section still in the sheet")
        XCTAssertFalse(element(app, "account.mockToggle").exists, "Mock toggle still in the sheet")
        XCTAssertFalse(element(app, "account.scenarioPicker").exists, "Scenario picker still in the sheet")
        XCTAssertFalse(element(app, "account.debugMenuLink").exists, "Debug menu link still in the sheet")

        // Four taps is not enough — it must be deliberate. The link would
        // sit below the version row; scroll to the end before checking, or
        // a lazy Form's .exists is false whether or not it was revealed.
        for _ in 0..<4 { version.tap() }
        XCTAssertFalse(
            scrollTo(app, "account.diagnosticsLink", swipes: 3).exists,
            "Diagnostics revealed before the fifth tap"
        )
        scrollTo(app, "account.versionRow").tap()

        let link = scrollTo(app, "account.diagnosticsLink", swipes: 4)
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
            "diagnostics.dryRun",
            "diagnostics.resetOnboardingButton",
        ] {
            XCTAssertTrue(scrollTo(app, identifier).exists, "\(identifier) missing from Diagnostics")
        }
        // The effective dry run (GET /policy), not just env DRY_RUN; the
        // mock policy runs dry.
        XCTAssertEqual(element(app, "diagnostics.dryRun").label, "Dry run, On — no money moves")

        // Signal-log export appears once logging is on.
        let export = element(app, "diagnostics.exportSignalLog")
        XCTAssertFalse(export.exists, "Export offered with logging off")
        let logToggle = scrollTo(app, "diagnostics.signalLogToggle")
        // A Form toggle's centre isn't the switch; tap its trailing edge.
        logToggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(
            scrollTo(app, "diagnostics.exportSignalLog", swipes: 3).exists,
            "Signal-log export missing once logging is on"
        )
    }

    /// Reset onboarding (in Diagnostics) clears the completion flag and
    /// lands back on the flow — at permissions, its first step now that
    /// signing in is the welcome.
    func testResetOnboardingReturnsToTheFlow() {
        let app = launchApp()
        openDiagnostics(app)
        XCTAssertFalse(element(app, "onboarding.permissions").exists)
        // Reset is the last section: scroll it into the hierarchy first.
        scrollTo(app, "diagnostics.resetOnboardingButton").tap()
        app.buttons["Reset"].tap()
        XCTAssertTrue(
            element(app, "onboarding.permissions").waitForExistence(timeout: 10),
            "Reset did not return to onboarding"
        )
        XCTAssertFalse(app.tabBars.buttons["Park"].exists, "Still on the tabs after reset")
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

        openAccountSheet(app)
        let row = scrollTo(app, "account.howYouPay")
        XCTAssertTrue(row.waitForExistence(timeout: 5), "How-you-pay row missing")
        // ParkNYC is the registry's (and the mock's) FIRST account: only
        // the detected city can make this ParkBoston's card.
        waitForLabelContaining(row, "Your card on ParkBoston Visa ••1234")
    }

    /// Help is reachable and says what the app never does.
    func testHelpScreenOpens() {
        let app = launchApp()
        openAccountSheet(app)

        scrollTo(app, "account.helpLink").tap()
        XCTAssertTrue(element(app, "help.view").waitForExistence(timeout: 5), "Help screen missing")
    }

    /// Deleting takes two steps: read the consequences, then type DELETE.
    func testDeleteAccountRequiresTypedConfirmation() {
        let app = launchApp()
        openAccountSheet(app)

        scrollTo(app, "account.deleteAccountLink").tap()
        XCTAssertTrue(
            element(app, "deleteAccount.view").waitForExistence(timeout: 5),
            "Delete screen missing"
        )

        let confirmButton = element(app, "deleteAccount.confirmButton")
        XCTAssertFalse(confirmButton.isEnabled, "Delete must be disabled before confirming")

        let field = element(app, "deleteAccount.confirmField")
        field.tap()
        field.typeText("NOPE")
        XCTAssertFalse(confirmButton.isEnabled, "Only the word DELETE should enable it")

        // Clear and type the real word.
        field.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) {
            app.menuItems["Select All"].tap()
        }
        field.typeText("DELETE")
        XCTAssertTrue(confirmButton.isEnabled, "DELETE should enable the button")

        confirmButton.tap()
        XCTAssertTrue(
            element(app, "welcome.view").waitForExistence(timeout: 10),
            "Deleting should land on the welcome screen"
        )
    }

    // MARK: - Helpers

    private func waitForDisappearance(of element: XCUIElement, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
