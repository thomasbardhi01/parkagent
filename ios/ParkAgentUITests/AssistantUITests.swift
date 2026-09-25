import XCTest

/// The assistant sheet against the mock API: the single-spot flow, a
/// six-stop itinerary sign-off, reordering, the garage deep-link tap, the
/// Link-connected confirm path, and the parking-only refusal.
///
/// Taps on anything inside the transcript go through `scrollTo` (#123):
/// a card can exist in the tree while below the fold or under the tab
/// bar, where a synthesized tap reaches nothing. The account-navigation
/// helper (`openAccountSheet`) belongs to the accounts suite; this file
/// owns the rest.
final class AssistantUITests: ParkAgentUITestCase {
    private func openAssistant(
        _ assistantScenario: String,
        linkScenario: String? = nil,
        paymentSource: String? = nil
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var args = [
            "-resetState", "YES",
            "-useMockAPI", "YES",
            "-uiTesting", "YES",
            "-skipOnboarding", "YES",
            // Auth gates the app now: start past the welcome screen.
            "-signedIn", "YES",
            "-fixedNow", Self.fixedNow,
            "-assistantScenario", assistantScenario,
        ]
        if let linkScenario { args += ["-linkScenario", linkScenario] }
        if let paymentSource { args += ["-paymentSource", paymentSource] }
        app.launchArguments = args
        app.launch()
        element(app, "home.askAssistantButton").tap()
        XCTAssertTrue(element(app, "assistant.inputField").waitForExistence(timeout: 5))
        return app
    }

    private func ask(_ app: XCUIApplication, _ text: String) {
        let field = element(app, "assistant.inputField")
        field.tap()
        field.typeText(text)
        element(app, "assistant.sendButton").tap()
    }

    func testSingleSpotFlowStreetConfirm() {
        let app = openAssistant("singleSpot")
        XCTAssertTrue(element(app, "assistant.emptyState").exists)
        ask(app, "Park me near the MFA for 90 minutes")

        // The plan streams in: one hero, one recommended badge.
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts.matching(identifier: "Recommended").count, 1)

        scrollTo(app, "assistant.confirm.opt-street").tap()
        // Street confirm hands the zone to the existing paid flow.
        let note = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'session starts when you park'")
        ).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        attachScreenshot(of: app, named: "assistant-street-confirmed")
    }

    /// The results layout: ONE hero with the only coral action, the rest
    /// as compact rows that stay collapsed until tapped, a mini map, and
    /// the provenance note once under the list.
    func testHeroCardIsTheOnlyActionAndRowsExpandOnTap() {
        let app = openAssistant("singleSpot")
        ask(app, "Park me near the MFA for 90 minutes")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))

        // Exactly one Confirm on screen: the hero's. The alternatives
        // offer a neutral Choose, and only once expanded.
        XCTAssertTrue(element(app, "assistant.confirm.opt-street").exists)
        XCTAssertEqual(
            app.buttons.matching(
                NSPredicate(format: "identifier BEGINSWITH 'assistant.confirm.'")
            ).count,
            1,
            "Only the hero card may carry a coral action"
        )

        // The alternatives are compact rows, collapsed.
        let garageRow = element(app, "assistant.optionRow.opt-garage")
        XCTAssertTrue(garageRow.exists)
        XCTAssertTrue(element(app, "assistant.optionRow.opt-garage-2").exists)
        XCTAssertFalse(
            element(app, "assistant.choose.opt-garage").exists,
            "A collapsed row shows no button"
        )

        // Tap expands it and reveals the neutral Choose.
        scrollTo(app, "assistant.optionRow.opt-garage").tap()
        let choose = element(app, "assistant.choose.opt-garage")
        XCTAssertTrue(choose.waitForExistence(timeout: 3))

        // Provenance is stated once, crediting exactly the sources shown
        // (one SpotHero row, one ParkWhiz row) — the whole sentence, not
        // a provider name several lines on screen could contain.
        let note = scrollTo(app, "assistant.providerNote")
        XCTAssertTrue(note.exists)
        XCTAssertTrue(
            note.label.hasPrefix("Garage prices from ParkWhiz and SpotHero, checked "),
            "got: \(note.label)"
        )
        XCTAssertTrue(element(app, "assistant.planMap").exists)
        attachScreenshot(of: app, named: "assistant-hero-and-rows")

        // Tapping the row again collapses it — one row open at a time.
        scrollTo(app, "assistant.optionRow.opt-garage").tap()
        XCTAssertFalse(choose.waitForExistence(timeout: 2))
    }

    /// A street option for a FUTURE time is not confirmable: the detector
    /// pays at the curb, so the card says so and offers no button.
    func testFutureStreetOptionOffersNoButton() {
        let app = openAssistant("futureStreet")
        ask(app, "garage near Fenway at 7 Saturday")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))

        let autoPay = element(app, "assistant.autoPayNote.opt-street-later")
        XCTAssertTrue(autoPay.exists)
        XCTAssertTrue(
            autoPay.label.contains("Pays automatically when you park"),
            "got: \(autoPay.label)"
        )
        XCTAssertFalse(
            element(app, "assistant.confirm.opt-street-later").exists,
            "A future meter must not offer a Confirm"
        )
        // The garage alternative is still choosable.
        scrollTo(app, "assistant.optionRow.opt-garage-fenway").tap()
        XCTAssertTrue(
            element(app, "assistant.choose.opt-garage-fenway").waitForExistence(timeout: 3)
        )
        attachScreenshot(of: app, named: "assistant-future-street")
    }

    /// A ParkWhiz alternative hands off to ParkWhiz — the merged search
    /// means a garage isn't always SpotHero, and the note must name the
    /// site the pass will actually live in.
    func testGarageConfirmOpensDeepLink() {
        let app = openAssistant("singleSpot")
        ask(app, "garage near fenway")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))

        // The garage is an alternative now: expand its row, then Choose.
        // scrollTo waits for HITTABLE, not just exists: the row settles
        // with a spring, and the button it reveals can sit in the tree
        // below the fold, where a synthesized tap reaches nothing.
        scrollTo(app, "assistant.optionRow.opt-garage-2").tap()
        scrollTo(app, "assistant.choose.opt-garage-2").tap()
        // The deep link "opened" (probe in uiTesting mode) as a garage
        // checkout…
        let probe = element(app, "assistant.externalLinkProbe")
        XCTAssertTrue(probe.waitForExistence(timeout: 5))
        XCTAssertEqual(probe.label, "garageCheckout")
        // …and the hand-off note names ParkWhiz. The whole clause, not the
        // name: the provenance line under the list names ParkWhiz too.
        let handoffNote = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'will live in your ParkWhiz account'")
        ).firstMatch
        XCTAssertTrue(
            handoffNote.waitForExistence(timeout: 5),
            "The confirm should say where the pass lives"
        )
        XCTAssertFalse(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS 'will live in your SpotHero account'")
            ).firstMatch.exists,
            "A ParkWhiz garage must not be handed off as SpotHero"
        )
    }

    func testSixStopItinerarySignOffAndReorder() {
        let app = openAssistant("itinerary")
        ask(app, "plan my boston day")
        XCTAssertTrue(element(app, "assistant.itineraryPlan").waitForExistence(timeout: 10))

        // Six stops, day total against the cap.
        for i in 1...6 {
            XCTAssertTrue(element(app, "assistant.stopRow.stop-\(i)").exists, "stop \(i) missing")
        }
        XCTAssertTrue(element(app, "assistant.dayTotal").label.contains("$40.40"))

        // Reorder: stop 2 moves above stop 1. The rows drag in the list;
        // the menu drives it deterministically here (a synthesized drag on
        // a reorder handle is famously flaky in XCTest).
        let firstBefore = element(app, "assistant.stopRow.stop-1")
        let secondBefore = element(app, "assistant.stopRow.stop-2")
        XCTAssertLessThan(
            firstBefore.frame.minY, secondBefore.frame.minY,
            "Stop 1 starts above stop 2"
        )
        scrollTo(app, "assistant.stopMenu.stop-2").tap()
        app.buttons["Move up"].tap()
        let firstRow = element(app, "assistant.stopRow.stop-2")
        XCTAssertTrue(firstRow.exists)
        // The order actually changed on screen, not just in the model.
        XCTAssertLessThan(
            firstRow.frame.minY, element(app, "assistant.stopRow.stop-1").frame.minY,
            "Stop 2 is now above stop 1"
        )
        attachScreenshot(of: app, named: "assistant-itinerary-reordered")

        scrollTo(app, "assistant.signOffButton").tap()
        let done = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Signed off'")
        ).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5))

        // The day landed on Home with live status rows (leaf identifiers:
        // the section container flattens inside home.view).
        app.buttons["Done"].tap()
        XCTAssertTrue(element(app, "home.dayHeader").waitForExistence(timeout: 5))
        // View-mode rows reuse the assistant stop-row identifiers; the
        // home.dayStop.* ids belong to the edit list.
        let homeFirst = element(app, "assistant.stopRow.stop-2")
        let homeSecond = element(app, "assistant.stopRow.stop-1")
        XCTAssertTrue(homeFirst.waitForExistence(timeout: 5))
        XCTAssertTrue(homeSecond.exists)
        // The reorder survived sign-off: Home shows the day in the order
        // the user left it, not the order the model proposed.
        XCTAssertLessThan(
            homeFirst.frame.minY, homeSecond.frame.minY,
            "The signed-off day keeps stop 2 above stop 1"
        )
        attachScreenshot(of: app, named: "assistant-day-on-home")
    }

    /// Link as the Wallet's way to pay: a garage confirm goes through the
    /// Link approval, then the Link card (Face ID in real life) and on to
    /// the garage's own checkout — the checkout used to never open after
    /// an approval.
    func testLinkActiveGarageApprovesThenShowsCardAndCheckout() {
        let app = openAssistant("singleSpot", linkScenario: "connected", paymentSource: "link_wallet")
        ask(app, "garage near fenway")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))

        scrollTo(app, "assistant.optionRow.opt-garage-2").tap()
        // The garage announces Link before the tap.
        XCTAssertTrue(scrollTo(app, "assistant.linkPayBadge").exists, "Link badge missing on the garage")
        scrollTo(app, "assistant.choose.opt-garage-2").tap()

        let probe = element(app, "assistant.externalLinkProbe")
        XCTAssertTrue(probe.waitForExistence(timeout: 5))
        XCTAssertEqual(probe.label, "linkApproval")
        probe.tap() // "return" from the approval

        let showCard = element(app, "assistant.showLinkCard")
        XCTAssertTrue(showCard.waitForExistence(timeout: 5), "Approved: the Link card should be offered")
        showCard.tap()
        XCTAssertTrue(element(app, "linkCard.view").waitForExistence(timeout: 5))
        // The whole number, however it's grouped on screen.
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label MATCHES '.*4000 +0099 +9000 +1984.*'"))
                .firstMatch.waitForExistence(timeout: 3),
            "The one-time card should be on screen"
        )
        attachScreenshot(of: app, named: "assistant-link-garage-checkout")
        // The garage's own checkout opens in the browser, card in hand.
        element(app, "linkCard.checkoutButton").tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "The garage's checkout should open")
    }

    /// Link never pays a street meter: with Link active, a street confirm
    /// asks for no Link approval and names the card on the parking account.
    func testLinkActiveStreetStaysOnTheParkingAccountsCard() {
        let app = openAssistant("singleSpot", linkScenario: "connected", paymentSource: "link_wallet")
        ask(app, "spot near the museum")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))
        scrollTo(app, "assistant.confirm.opt-street").tap()

        let note = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'session starts when you park' AND label CONTAINS 'card on your parking account'")
        ).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 5), "The street note should name the parking account's card")
        XCTAssertFalse(
            element(app, "assistant.externalLinkProbe").exists,
            "A street meter must not open a Link approval"
        )
    }

    /// The empty state offers starters in the user's city, and tapping one
    /// asks it without typing.
    func testSuggestedPromptChipsAskDirectly() {
        let app = openAssistant("singleSpot")
        let chips = app.buttons.matching(identifier: "assistant.promptChip")
        XCTAssertGreaterThan(chips.count, 0, "The empty state offers starters")
        XCTAssertTrue(element(app, "assistant.emptyState").exists)
        XCTAssertFalse(element(app, "assistant.userMessage").exists, "Nothing asked yet")
        attachScreenshot(of: app, named: "assistant-empty-state")
        let chip = chips.element(boundBy: 0)
        let asked = chip.label
        chip.tap()

        // The tap sent it: the user's own bubble carries exactly the chip's
        // words (the chip itself can't satisfy this — it isn't a user
        // message), and the empty state is gone.
        let userMessage = element(app, "assistant.userMessage")
        XCTAssertTrue(userMessage.waitForExistence(timeout: 5))
        XCTAssertEqual(userMessage.label, asked)
        XCTAssertFalse(element(app, "assistant.emptyState").exists)
    }

    /// Sending puts the keyboard away and keeps the newest reply on screen.
    func testKeyboardDismissesOnSendAndNewestReplyStaysVisible() {
        let app = openAssistant("singleSpot")
        let field = element(app, "assistant.inputField")
        field.tap()
        field.typeText("Park me near the MFA for 90 minutes")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "Keyboard is up while typing")

        element(app, "assistant.sendButton").tap()
        // The keyboard goes away so the reply and its card own the screen.
        XCTAssertTrue(
            waitForDisappearance(app.keyboards.firstMatch, timeout: 5),
            "The keyboard should dismiss on send"
        )

        // The plan card lands and is actually on screen, not below the fold.
        let plan = element(app, "assistant.singleSpotPlan")
        XCTAssertTrue(plan.waitForExistence(timeout: 10))
        let hero = element(app, "assistant.confirm.opt-street")
        XCTAssertTrue(hero.waitForExistence(timeout: 5))
        XCTAssertTrue(hero.isHittable, "The newest reply's action must be reachable")
    }

    private func waitForDisappearance(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while element.exists && Date() < deadline {
            usleep(200_000)
        }
        return !element.exists
    }

    /// Exists AND is on screen. `exists` alone is the trap: a lazily
    /// realized element can be in the accessibility tree while sitting
    /// under the fold, and `tap()` then synthesizes an event that reaches
    /// nothing — the action never runs and the failure surfaces later,
    /// somewhere else entirely.
    private func waitForHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !(element.exists && element.isHittable) && Date() < deadline {
            usleep(200_000)
        }
        return element.exists && element.isHittable
    }

    func testRefusesNonParkingTopics() {
        let app = openAssistant("refuse")
        ask(app, "what's a good pasta recipe?")
        let refusal = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'only help with parking'")
        ).firstMatch
        XCTAssertTrue(refusal.waitForExistence(timeout: 10))
        XCTAssertFalse(element(app, "assistant.singleSpotPlan").exists)
    }

    func testErrorStateSurfaces() {
        let app = openAssistant("error")
        ask(app, "find me parking")
        XCTAssertTrue(element(app, "assistant.errorRow").waitForExistence(timeout: 10))
    }
}
