import XCTest

final class CardUITests: ParkAgentUITestCase {
    private func openCardTab(_ app: XCUIApplication) {
        app.tabBars.buttons["Card"].tap()
        XCTAssertTrue(element(app, "card.view").waitForExistence(timeout: 5), "Card tab missing")
    }

    /// Hero art with the mocked last4, the spend meter, and transactions.
    func testCardScreenRenders() {
        let app = launchApp(cardScenario: "ready")
        openCardTab(app)

        XCTAssertTrue(element(app, "card.art").waitForExistence(timeout: 5), "Card art missing")
        let number = element(app, "card.number")
        XCTAssertTrue(number.exists, "Card number line missing")
        XCTAssertTrue(number.label.hasSuffix("4444"), "Masked number should end in the API's last4")
        XCTAssertTrue(element(app, "card.spendMeter").exists, "Spend meter missing")
        XCTAssertTrue(element(app, "card.balance").exists, "Balance missing on funded scenario")
        XCTAssertTrue(
            element(app, "card.txnRow.mock-txn-1").waitForExistence(timeout: 5),
            "Transactions did not render"
        )
        attachScreenshot(of: app, named: "card-ready")
    }

    /// The network mark comes from GET /card (issuing_cards.brand) — the
    /// mock serves Mastercard like the real cards, and nothing in the view
    /// may assume a brand (a hardcoded "Visa" once slipped through here).
    func testCardBrandReflectsAPI() {
        let app = launchApp(cardScenario: "ready")
        openCardTab(app)

        let brand = element(app, "card.brand")
        XCTAssertTrue(brand.waitForExistence(timeout: 5), "Brand mark missing from card art")
        XCTAssertEqual(brand.label, "Mastercard", "Brand must be what the API served")
        XCTAssertFalse(
            app.staticTexts["Visa"].exists,
            "No Visa anywhere — the API says these cards are Mastercard"
        )
    }

    /// Freeze via the confirmation, frozen pill appears; unfreeze clears it.
    func testFreezeToggles() {
        let app = launchApp(cardScenario: "ready")
        openCardTab(app)
        XCTAssertTrue(element(app, "card.freezeButton").waitForExistence(timeout: 5))

        element(app, "card.freezeButton").tap()
        let confirm = app.buttons["Freeze card"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 3), "Freeze confirmation missing")
        confirm.tap()
        XCTAssertTrue(
            element(app, "card.frozenPill").waitForExistence(timeout: 5),
            "Frozen pill missing after freeze"
        )
        attachScreenshot(of: app, named: "card-frozen")

        // The same button now unfreezes, without a confirmation.
        element(app, "card.freezeButton").tap()
        XCTAssertTrue(
            element(app, "card.frozenPill").waitForNonExistence(timeout: 5),
            "Frozen pill did not clear after unfreeze"
        )
    }

    /// Add money is the Apple Pay sheet now: quick amounts, the Apple Pay
    /// button, and in dry run an explicit banner plus a no-charge finish.
    func testAddMoneyApplePaySheetDryRun() {
        let app = launchApp(cardScenario: "ready")
        openCardTab(app)
        XCTAssertTrue(element(app, "card.addMoneyButton").waitForExistence(timeout: 5))
        element(app, "card.addMoneyButton").tap()

        XCTAssertTrue(element(app, "addMoney.view").waitForExistence(timeout: 5), "Add money sheet missing")
        XCTAssertTrue(element(app, "addMoney.dryRunBanner").exists, "Dry-run banner missing")
        XCTAssertTrue(element(app, "addMoney.applePayButton").exists, "Apple Pay button missing")
        XCTAssertTrue(element(app, "addMoney.cardButton").exists, "Card fallback missing")

        // $50, not $100: a single top-up above the $60 daily cap is refused
        // by policy (amount_over_daily_cap), mirroring the server.
        element(app, "addMoney.quick.50").tap()
        element(app, "addMoney.applePayButton").tap()
        let notice = element(app, "addMoney.doneNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "Dry-run completion missing")
        XCTAssertTrue(notice.label.contains("Dry run"), "Completion should say nothing was charged")
        element(app, "addMoney.doneButton").tap()
        XCTAssertTrue(element(app, "addMoney.view").waitForNonExistence(timeout: 5))
    }

    /// Withdraw still uses the balance form: confirm stays disabled until a
    /// valid amount, quick amounts fill the field, resulting balance shown.
    func testWithdrawSheetValidatesInput() {
        let app = launchApp(cardScenario: "ready")
        openCardTab(app)
        XCTAssertTrue(element(app, "card.withdrawButton").waitForExistence(timeout: 5))
        element(app, "card.withdrawButton").tap()

        XCTAssertTrue(element(app, "funding.view").waitForExistence(timeout: 5), "Funding sheet missing")
        let confirm = element(app, "funding.confirmButton")
        XCTAssertTrue(confirm.exists)
        XCTAssertFalse(confirm.isEnabled, "Confirm should be disabled with no amount")

        // Quick amounts replace the field and make the move valid.
        element(app, "funding.quick.20").tap()
        XCTAssertTrue(confirm.isEnabled, "Confirm should enable after a quick amount")
        // Mock balance is $42.50, so withdrawing $20 leaves $22.50.
        XCTAssertEqual(element(app, "funding.resultingBalance").label, "$22.50")
    }

    /// Flag defaults off: the Apple Pay action explains "coming soon".
    func testApplePayShowsComingSoonWhenFlagOff() {
        let app = launchApp(cardScenario: "ready")
        openCardTab(app)
        XCTAssertTrue(element(app, "card.applePayButton").waitForExistence(timeout: 5))
        element(app, "card.applePayButton").tap()

        let alert = app.alerts["Coming soon"]
        XCTAssertTrue(alert.waitForExistence(timeout: 3), "Coming-soon alert missing")
        XCTAssertTrue(
            alert.staticTexts.element(
                matching: NSPredicate(format: "label CONTAINS %@", "pending Apple approval")
            ).exists,
            "Coming-soon message missing"
        )
        alert.buttons["OK"].tap()
    }

    /// No card yet → the set-up empty state instead of the hero.
    func testNoCardEmptyState() {
        let app = launchApp(cardScenario: "noCard")
        openCardTab(app)
        XCTAssertTrue(
            element(app, "card.emptyNoCard").waitForExistence(timeout: 5),
            "No-card empty state missing"
        )
        XCTAssertFalse(element(app, "card.art").exists, "Card art should not render without a card")
    }

    /// Funding not ready: the meter says so, and the withdraw sheet (which
    /// moves money off the financial account) explains it.
    func testFundingNotReadyState() {
        let app = launchApp(cardScenario: "fundingNotReady")
        openCardTab(app)
        XCTAssertTrue(
            element(app, "card.balanceNotReady").waitForExistence(timeout: 5),
            "Balance not-ready label missing"
        )
        element(app, "card.withdrawButton").tap()
        XCTAssertTrue(
            element(app, "funding.notReady").waitForExistence(timeout: 5),
            "Funding sheet should show the not-ready state"
        )
    }
}
