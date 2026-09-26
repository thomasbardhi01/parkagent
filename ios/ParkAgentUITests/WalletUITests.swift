import XCTest

/// The Wallet tab in each state it can be in, against the mock server
/// (`-walletScenario`), plus choosing a different way to pay and the
/// Activity tab. Each state test attaches a `pr-wallet-*` screenshot.
///
/// Assertions bind to text only the state under test produces: the hero's
/// own line ("Link · Visa ••1234", "Visa ••4242 · Apple Pay"), a row's
/// state tag, a before/after pair for reveal and freeze.
final class WalletUITests: ParkAgentUITestCase {
    // MARK: - States

    /// Default: the card on the parking account pays. The hero names the
    /// user's city's provider and its masked card; Link offers Connect;
    /// the ParkAgent card is coming soon (a live Stripe key, no sandbox).
    func testProviderCardActive() {
        let app = launchApp(walletScenario: "providerCard")
        waitForLabelContaining(element(app, "home.statusChip"), "New York City")
        openWallet(app)

        let hero = element(app, "wallet.hero.providerCard")
        XCTAssertTrue(hero.waitForExistence(timeout: 5), "Provider-card hero missing")
        waitForLabelContaining(hero, "Your card on ParkNYC")
        waitForLabelContaining(hero, "Visa ••4242")
        attachScreenshot(of: app, named: "pr-wallet-provider-card")

        XCTAssertEqual(stateTag(app, "provider_card"), "Active")
        XCTAssertEqual(stateTag(app, "link_wallet"), "Connect")
        XCTAssertEqual(stateTag(app, "parkagent_card"), "Coming soon")
        waitForLabelContaining(scrollTo(app, "wallet.sourceRow.parkagent_card"), "Coming soon — pending approval")
        attachScreenshot(of: app, named: "pr-wallet-provider-card-choices")

        // Parking accounts say what pays there.
        let nyc = scrollTo(app, "wallet.provider.parknyc")
        waitForLabelContaining(nyc, "Paid by your Visa ••4242")
        // Spending against the caps, and the city split.
        waitForLabel(of: scrollTo(app, "wallet.spendToday"), toBe: "$4.10 of $60.00")
        XCTAssertTrue(scrollTo(app, "wallet.cityspend.bos").exists, "Per-city split missing")
        attachScreenshot(of: app, named: "pr-wallet-provider-card-spending")
    }

    /// Link connected and active: its mark and payment method, the one
    /// approval rule, the approval waiting, and Manage in Link. Street
    /// meters stay on the parking account's card — said on the hero.
    func testLinkConnectedAndActive() {
        let app = launchApp(walletScenario: "linkActive", linkScenario: "connected")
        openWallet(app)

        let hero = element(app, "wallet.hero.link")
        XCTAssertTrue(hero.waitForExistence(timeout: 5), "Link hero missing")
        waitForLabelContaining(hero, "Link · Visa ••1234")
        waitForLabelContaining(hero, "Every Link payment needs your approval in Link")
        XCTAssertTrue(
            element(app, "wallet.hero.linkScope").label.hasPrefix("Street meters stay on your card on"),
            "The hero must say Link doesn't pay street meters"
        )
        waitForLabelContaining(element(app, "wallet.pendingApproval.lsrq_mock_1"), "Approve $18.00 in Link")
        XCTAssertTrue(element(app, "wallet.manageInLink").exists, "Manage in Link missing")
        attachScreenshot(of: app, named: "pr-wallet-link-active")
        XCTAssertEqual(stateTag(app, "link_wallet"), "Active")

        // A garage approved in Link is spend: its own line under the month,
        // which still adds up ($16.53 + $7.28 + $18.00).
        waitForLabelContaining(scrollTo(app, "wallet.linkspend"), "Garages with Link")
        waitForLabelContaining(element(app, "wallet.linkspend"), "$18.00")
        waitForLabel(of: element(app, "wallet.spendMonth"), toBe: "$41.81")
    }

    /// No Link credentials on the server: "Link — coming soon", and the row
    /// can't be chosen (no sheet opens).
    func testLinkNotConfigured() {
        let app = launchApp(walletScenario: "linkNotConfigured")
        openWallet(app)
        XCTAssertTrue(element(app, "wallet.hero.providerCard").waitForExistence(timeout: 5))
        // The choices, top of the list in view.
        app.swipeUp()

        let row = scrollTo(app, "wallet.sourceRow.link_wallet")
        waitForLabelContaining(row, "Link — coming soon")
        XCTAssertEqual(stateTag(app, "link_wallet"), "Coming soon")
        row.tap()
        XCTAssertFalse(
            element(app, "changePayment.view").waitForExistence(timeout: 2),
            "A coming-soon row must not open the switch sheet"
        )
        attachScreenshot(of: app, named: "pr-wallet-link-not-configured")
    }

    /// The ParkAgent card active in sandbox: the funding card, the virtual
    /// card art, Show details (reveals, then Hide), and Freeze (confirmed,
    /// then Unfreeze).
    func testParkAgentCardSandboxActiveRevealAndFreeze() {
        let app = launchApp(walletScenario: "parkagentSandbox")
        openWallet(app)

        let funding = element(app, "wallet.hero.funding")
        XCTAssertTrue(funding.waitForExistence(timeout: 5), "Funding line missing")
        waitForLabelContaining(funding, "Visa ••4242 · Apple Pay")
        waitForLabelContaining(funding, "Sandbox")
        let number = element(app, "card.number")
        XCTAssertTrue(number.waitForExistence(timeout: 5), "Card art missing")
        XCTAssertTrue(number.label.hasSuffix("4444"), "Masked number should end in the card's last4")
        XCTAssertEqual(element(app, "card.brand").label, "Mastercard")
        attachScreenshot(of: app, named: "pr-wallet-parkagent-sandbox")

        // Reveal: before masked, after the full number from "Stripe".
        XCTAssertFalse(number.label.contains("5555"), "Revealed before asking")
        scrollTo(app, "wallet.showDetailsButton").tap()
        waitForLabel(of: number, toBe: "5555  5555  5555  4444")
        XCTAssertTrue(element(app, "card.cvc").exists, "CVC missing while revealed")
        attachScreenshot(of: app, named: "pr-wallet-parkagent-revealed")
        element(app, "wallet.showDetailsButton").tap()
        XCTAssertTrue(element(app, "card.cvc").waitForNonExistence(timeout: 5), "Hide didn't hide")

        // Freeze asks first; the pill comes and goes.
        XCTAssertFalse(element(app, "card.frozenPill").exists)
        scrollTo(app, "wallet.freezeButton").tap()
        let confirm = app.buttons["Freeze card"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 3), "Freeze confirmation missing")
        confirm.tap()
        XCTAssertTrue(element(app, "card.frozenPill").waitForExistence(timeout: 5), "Frozen pill missing")
        attachScreenshot(of: app, named: "pr-wallet-parkagent-frozen")
        element(app, "wallet.freezeButton").tap()
        XCTAssertTrue(element(app, "card.frozenPill").waitForNonExistence(timeout: 5), "Unfreeze didn't clear")
    }

    /// Nothing linked, nothing spent: every account says Connect, spend is
    /// zero, and Activity has its own empty line — no invented rows.
    func testEmpty() {
        let app = launchApp(walletScenario: "empty")
        openWallet(app)

        let hero = element(app, "wallet.hero.providerCard")
        XCTAssertTrue(hero.waitForExistence(timeout: 5))
        // Nothing connected: the hero says so — not "Active" — and offers
        // Connect.
        waitForLabelContaining(hero, "Not connected yet")
        XCTAssertTrue(element(app, "wallet.hero.connect").exists, "Connect missing from the hero")
        XCTAssertEqual(stateTag(app, "provider_card"), "Connect")
        attachScreenshot(of: app, named: "pr-wallet-empty-top")
        waitForLabelContaining(scrollTo(app, "wallet.provider.parknyc"), "Not connected")
        XCTAssertEqual(scrollTo(app, "wallet.providerAction.parknyc").label, "Connect")
        waitForLabel(of: scrollTo(app, "wallet.spendToday"), toBe: "$0.00 of $60.00")
        XCTAssertTrue(scrollTo(app, "wallet.activityEmpty").exists, "Empty activity line missing")
        XCTAssertFalse(element(app, "wallet.seeAllActivity").exists, "Nothing to see all of")
        attachScreenshot(of: app, named: "pr-wallet-empty")
    }

    /// The device report: "Your card on ParkBoston — Active" while
    /// ParkBoston said "Not connected". In Boston with ParkBoston not
    /// linked (and ParkNYC not either), the hero says it isn't connected
    /// yet and Connect runs the link; once linked, the card read after
    /// linking is the hero's and the row is Active again.
    func testUnconnectedProviderSaysSoAndConnects() {
        let app = launchApp(walletScenario: "empty", providerScenario: "notLinked", cityScenario: "bos")
        waitForLabelContaining(element(app, "home.statusChip"), "Boston")
        openWallet(app)

        let hero = element(app, "wallet.hero.providerCard")
        XCTAssertTrue(hero.waitForExistence(timeout: 5), "Provider-card hero missing")
        waitForLabelContaining(hero, "Your card on ParkBoston")
        waitForLabelContaining(hero, "Not connected yet")
        XCTAssertFalse(hero.label.contains("••"), "No card pays until ParkBoston is connected: \(hero.label)")
        XCTAssertEqual(stateTag(app, "provider_card"), "Connect")
        attachScreenshot(of: app, named: "pr-wallet-not-connected")

        let connect = element(app, "wallet.hero.connect")
        XCTAssertEqual(connect.label, "Connect ParkBoston")
        connect.tap()
        XCTAssertTrue(element(app, "link.intro").waitForExistence(timeout: 5), "Connect did not open the link flow")
        element(app, "link.continueButton").tap()
        let signIn = element(app, "link.mockSignInButton")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        signIn.tap()
        XCTAssertTrue(element(app, "link.done").waitForExistence(timeout: 15), "Link did not finish")
        element(app, "link.doneButton").tap()

        waitForLabelContaining(hero, "Visa ••1234")
        XCTAssertFalse(element(app, "wallet.hero.connect").exists, "Connect should go once linked")
        XCTAssertEqual(stateTag(app, "provider_card"), "Active")
        attachScreenshot(of: app, named: "pr-wallet-connected")
    }

    // MARK: - Changing how you pay

    /// Choosing Link walks through connecting it, then confirms; the hero
    /// becomes Link's.
    func testSwitchToLinkConnectsThenConfirms() {
        let app = launchApp(walletScenario: "providerCard", linkScenario: "disconnected")
        openWallet(app)
        XCTAssertTrue(element(app, "wallet.hero.providerCard").waitForExistence(timeout: 5))

        scrollTo(app, "wallet.sourceRow.link_wallet").tap()
        XCTAssertTrue(element(app, "changePayment.view").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "changePayment.linkApprovalNote").exists, "The approval rule must be said here")
        let confirm = element(app, "changePayment.confirmButton")
        XCTAssertFalse(confirm.isEnabled, "Can't choose Link before connecting it")
        element(app, "changePayment.connectLinkButton").tap()
        XCTAssertTrue(element(app, "changePayment.linkConnected").waitForExistence(timeout: 5))
        XCTAssertTrue(confirm.isEnabled)
        attachScreenshot(of: app, named: "pr-wallet-switch-link")
        confirm.tap()

        let hero = element(app, "wallet.hero.link")
        XCTAssertTrue(hero.waitForExistence(timeout: 5), "Hero should switch to Link")
        XCTAssertFalse(element(app, "wallet.hero.providerCard").exists)
        XCTAssertEqual(stateTag(app, "link_wallet"), "Active")
    }

    /// Choosing the ParkAgent card (live): save a card first, agree to it
    /// going on the parking accounts, then confirm; the hero becomes the
    /// card.
    func testSwitchToParkAgentCardAddsCardAndAsksConsent() {
        let app = launchApp(walletScenario: "providerCard", issuingLive: true)
        openWallet(app)
        XCTAssertTrue(element(app, "wallet.hero.providerCard").waitForExistence(timeout: 5))
        XCTAssertEqual(stateTag(app, "parkagent_card"), "Add card")

        scrollTo(app, "wallet.sourceRow.parkagent_card").tap()
        XCTAssertTrue(element(app, "changePayment.view").waitForExistence(timeout: 5))
        let confirm = element(app, "changePayment.confirmButton")
        XCTAssertFalse(confirm.isEnabled, "Nothing to hold against yet")
        element(app, "changePayment.applePayButton").tap()
        XCTAssertTrue(element(app, "changePayment.cardSaved").waitForExistence(timeout: 5))
        XCTAssertFalse(confirm.isEnabled, "Consent comes before replacing the saved cards")
        let consent = element(app, "changePayment.consentToggle")
        XCTAssertEqual(consent.value as? String, "unchecked")
        consent.tap()
        XCTAssertTrue(confirm.isEnabled)
        attachScreenshot(of: app, named: "pr-wallet-switch-parkagent")
        confirm.tap()

        let funding = element(app, "wallet.hero.funding")
        XCTAssertTrue(funding.waitForExistence(timeout: 5), "Hero should switch to the ParkAgent card")
        waitForLabelContaining(funding, "Visa ••4242 · Apple Pay")
    }

    // MARK: - Activity

    /// The Wallet's recent activity, "See all" to the Activity tab, grouped
    /// by day, and a session's detail with its timeline and receipt.
    func testActivityFromTheWallet() {
        let app = launchApp(walletScenario: "parkagentSandbox")
        openWallet(app)
        XCTAssertTrue(element(app, "wallet.hero.funding").waitForExistence(timeout: 5))
        scrollTo(app, "wallet.seeAllActivity").tap()

        XCTAssertTrue(element(app, "activity.view").waitForExistence(timeout: 5), "Activity tab missing")
        let session = element(app, "activity.row.session:mock-s1")
        XCTAssertTrue(session.waitForExistence(timeout: 5))
        waitForLabelContaining(session, "Boylston St · Zone 456")
        waitForLabelContaining(session, "$4.10 taken from your card")
        attachScreenshot(of: app, named: "pr-activity")
        session.tap()

        XCTAssertTrue(element(app, "activityDetail.view").waitForExistence(timeout: 5))
        let timeline = element(app, "activityDetail.timeline")
        XCTAssertTrue(timeline.waitForExistence(timeout: 5), "Timeline missing")
        XCTAssertTrue(app.staticTexts["Held on your card"].exists, "The hold should be on the timeline")
        XCTAssertTrue(app.staticTexts["Taken from your card"].exists, "The capture should be on the timeline")
        XCTAssertTrue(scrollTo(app, "activityDetail.receipt").exists, "Receipt missing")
        attachScreenshot(of: app, named: "pr-activity-detail")
    }

    /// A declined ParkAgent-card hold at the curb: nothing was paid, and
    /// the sheet sends the user to the Wallet rather than offering a retry
    /// of the same card.
    func testDeclinedCardAtTheCurbOpensTheWallet() {
        let app = launchApp(scenario: "cardDeclined", walletScenario: "parkagentSandbox")
        simulateParkFromHome(app)
        let pay = element(app, "parkedSheet.payButton")
        XCTAssertTrue(pay.waitForExistence(timeout: 5), "Pay button missing")
        pay.tap()

        let message = element(app, "parkedSheet.walletFixMessage")
        XCTAssertTrue(message.waitForExistence(timeout: 5), "Declined card should route to the Wallet")
        XCTAssertEqual(message.label, "Your card was declined — update it in Wallet.")
        attachScreenshot(of: app, named: "pr-wallet-card-declined-at-curb")
        element(app, "parkedSheet.openWalletButton").tap()
        XCTAssertTrue(element(app, "wallet.hero.funding").waitForExistence(timeout: 5), "Should land on the Wallet")
    }

    /// Diagnostics' sandbox toggle is what lets a Debug build choose the
    /// ParkAgent card before it's live. Off, the server's sandbox option
    /// reads Coming soon; on, the same option is selectable. (A Release
    /// build has no toggle and always reads Coming soon.)
    func testSandboxToggleGatesTheParkAgentCard() {
        let app = launchApp(
            walletScenario: "parkagentSandbox",
            paymentSource: "provider_card",
            parkAgentSandbox: false
        )
        openWallet(app)
        XCTAssertEqual(stateTag(app, "provider_card"), "Active")
        XCTAssertEqual(stateTag(app, "parkagent_card"), "Coming soon", "Sandbox card offered with the toggle off")

        openDiagnostics(app)
        let toggle = scrollTo(app, "diagnostics.sandboxToggle")
        XCTAssertEqual(toggle.value as? String, "0", "Toggle should start off")
        // A Form toggle's centre isn't the switch; tap its trailing edge.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let on = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: toggle)
        XCTAssertEqual(XCTWaiter().wait(for: [on], timeout: 5), .completed, "Toggle didn't turn on")
        app.navigationBars.buttons.firstMatch.tap()
        element(app, "account.doneButton").tap()

        openWallet(app)
        let row = scrollTo(app, "wallet.sourceRow.parkagent_card")
        let available = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == 'Available'"), object: row)
        XCTAssertEqual(
            XCTWaiter().wait(for: [available], timeout: 5), .completed,
            "Toggle on should make the sandbox card selectable; the row reads \(String(describing: row.value))"
        )
    }

    // MARK: - Helpers

    /// A "Change how you pay" row's state tag (Active / Available /
    /// Connect / Add card / Coming soon) — the row's accessibility value.
    private func stateTag(_ app: XCUIApplication, _ source: String) -> String? {
        scrollTo(app, "wallet.sourceRow.\(source)").value as? String
    }
}
