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

    /// A street option says what the block is doing during the stay, in
    /// the street search's own words — not the model's "meter" blurb.
    func testStreetOptionSaysWhatTheBlockIsDoing() {
        let app = openAssistant("singleSpot")
        ask(app, "Park me near the MFA for 90 minutes")
        let detail = element(app, "assistant.optionDetail.opt-street")
        XCTAssertTrue(detail.waitForExistence(timeout: 10))
        XCTAssertEqual(detail.label, "Metered until 8 PM, then free on Boylston St — 2 min walk")
    }

    /// Choosing an option: a row tap and a pin tap are the same selection.
    /// The selected pin is highlighted and every other pin dims — the
    /// recommended one included, which keeps its color only while nothing
    /// else is chosen — and the selected option's detail card opens.
    func testSelectingAnOptionSyncsRowsAndPins() {
        let app = openAssistant("singleSpot")
        ask(app, "Park me near the MFA for 90 minutes")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))

        let streetPin = element(app, "assistant.mapPin.opt-street")
        let deckPin = element(app, "assistant.mapPin.opt-garage")
        let valetPin = element(app, "assistant.mapPin.opt-garage-2")
        XCTAssertTrue(streetPin.waitForExistence(timeout: 5))
        // Nothing chosen: the recommended pin stands out, and the card says why.
        XCTAssertEqual(streetPin.value as? String, "recommended")
        XCTAssertEqual(deckPin.value as? String, "normal")
        XCTAssertEqual(
            element(app, "assistant.recommendedReason").label,
            "Cheapest and closest — $4.10, 2 min walk"
        )
        XCTAssertFalse(element(app, "assistant.detail.checkout.opt-garage").exists)

        // Row → pin.
        scrollTo(app, "assistant.optionRow.opt-garage").tap()
        waitForValue(of: deckPin, toBe: "selected")
        XCTAssertEqual(streetPin.value as? String, "dimmed", "The recommended pin gives up its color")
        XCTAssertEqual(valetPin.value as? String, "dimmed")
        XCTAssertEqual(element(app, "assistant.optionRow.opt-garage").value as? String, "selected")
        let deckCheckout = scrollTo(app, "assistant.detail.checkout.opt-garage")
        XCTAssertEqual(
            deckCheckout.label,
            "Checkout finishes on SpotHero; your pass lives in your SpotHero account."
        )
        XCTAssertEqual(
            element(app, "assistant.detail.walk.opt-garage").label,
            "3 min walk from Museum of Fine Arts"
        )
        attachScreenshot(of: app, named: "assistant-option-selected")

        // Pin → row: the valet's pin moves the selection and the card.
        scrollTo(app, "assistant.mapPin.opt-garage-2").tap()
        waitForValue(of: valetPin, toBe: "selected")
        XCTAssertEqual(deckPin.value as? String, "dimmed")
        XCTAssertEqual(element(app, "assistant.optionRow.opt-garage-2").value as? String, "selected")
        XCTAssertEqual(element(app, "assistant.optionRow.opt-garage").value as? String, "")
        XCTAssertTrue(element(app, "assistant.detail.entry.opt-garage-2").waitForExistence(timeout: 3))
        XCTAssertFalse(element(app, "assistant.detail.checkout.opt-garage").exists, "One card open")

        // The same pin again clears the choice: the recommendation is back.
        scrollTo(app, "assistant.mapPin.opt-garage-2").tap()
        waitForValue(of: streetPin, toBe: "recommended")
        XCTAssertEqual(valetPin.value as? String, "normal")
    }

    private func waitForValue(of element: XCUIElement, toBe expected: String, timeout: TimeInterval = 5) {
        let predicate = NSPredicate(format: "value == %@", expected)
        let wait = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(
            XCTWaiter.wait(for: [wait], timeout: timeout), .completed,
            "\(element.identifier) value: expected \(expected), got \(String(describing: element.value))"
        )
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

    /// Itinerary order. The mock lists the six stops 4,1,6,2,5,3 (stop-N
    /// arrives at (9+N):00), so every order asserted below is one the app
    /// produced, never the fixture's. A later stop must never render above
    /// an earlier one: a timed stop can't be moved by hand, a new time
    /// re-sorts it, and only a stop whose time is cleared can be moved.
    func testItineraryStopsStayInArrivalOrderThroughEditsAndSignOff() {
        let app = openAssistant("itinerary")
        ask(app, "plan my boston day")
        XCTAssertTrue(element(app, "assistant.itineraryPlan").waitForExistence(timeout: 10))
        XCTAssertTrue(element(app, "assistant.dayTotal").label.contains("$40.40"))

        // First render: arrival order, not list order.
        assertStopsTopToBottom(app, ["stop-1", "stop-2", "stop-3", "stop-4", "stop-5", "stop-6"],
                               "the card must sort the stops by arrival")

        // A timed stop's menu: Edit stop, and no Move up/down — even
        // though stop-2 is neither first nor last. The positive half of the
        // pair is the Edit button in the same open menu.
        scrollTo(app, "assistant.stopMenu.stop-2").tap()
        XCTAssertTrue(app.buttons["Edit stop"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Move up"].exists, "a timed stop must not move by hand")
        XCTAssertFalse(app.buttons["Move down"].exists, "a timed stop must not move by hand")

        // Re-time stop-2 to 11 PM — later than every other stop in any US
        // time zone or UTC. It must MOVE: above stop-3 before, below
        // stop-6 after.
        XCTAssertLessThan(stopRow(app, "stop-2").frame.minY, stopRow(app, "stop-3").frame.minY)
        app.buttons["Edit stop"].tap()
        setStopTime(app, hour: "11", period: "PM")
        attachScreenshot(of: app, named: "assistant-itinerary-stop-time")
        element(app, "stopEdit.save").tap()
        XCTAssertTrue(waitForDisappearance(element(app, "stopEdit.save"), timeout: 5))
        XCTAssertGreaterThan(
            stopRow(app, "stop-2").frame.minY, stopRow(app, "stop-6").frame.minY,
            "a later time must re-sort the stop below the others"
        )
        assertStopsTopToBottom(app, ["stop-1", "stop-3", "stop-4", "stop-5", "stop-6", "stop-2"],
                               "after re-timing stop-2")

        // Clear stop-4's time: it stays in its slot and reads "Any time"…
        scrollTo(app, "assistant.stopMenu.stop-4").tap()
        XCTAssertTrue(app.buttons["Edit stop"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Move up"].exists, "still timed until saved")
        app.buttons["Edit stop"].tap()
        setToggle(app, "stopEdit.hasTime", on: false)
        element(app, "stopEdit.save").tap()
        XCTAssertTrue(waitForDisappearance(element(app, "stopEdit.save"), timeout: 5))
        waitForLabelContaining(stopRow(app, "stop-4"), "Any time")
        assertStopsTopToBottom(app, ["stop-1", "stop-3", "stop-4", "stop-5", "stop-6", "stop-2"],
                               "clearing a time leaves the stop where it was")

        // …and is now the one stop that moves by hand. Move it up past a
        // timed stop; the timed stops keep their time order around it.
        scrollTo(app, "assistant.stopMenu.stop-4").tap()
        XCTAssertTrue(app.buttons["Move up"].waitForExistence(timeout: 3), "an untimed stop moves")
        app.buttons["Move up"].tap()
        assertStopsTopToBottom(app, ["stop-1", "stop-4", "stop-3", "stop-5", "stop-6", "stop-2"],
                               "the untimed stop moved; timed stops stay in time order")
        attachScreenshot(of: app, named: "assistant-itinerary-arrival-order")

        scrollTo(app, "assistant.signOffButton").tap()
        let done = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Signed off'")
        ).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5))

        // The day on Home keeps the card's edits and the same order (the
        // edits save as the day's first PATCH; view-mode rows reuse the
        // assistant stop-row identifiers).
        app.buttons["Done"].tap()
        XCTAssertTrue(element(app, "home.dayHeader").waitForExistence(timeout: 5))
        XCTAssertTrue(stopRow(app, "stop-2").waitForExistence(timeout: 5))
        waitForLabelContaining(stopRow(app, "stop-4"), "Any time")
        assertStopsTopToBottom(app, ["stop-1", "stop-4", "stop-3", "stop-5", "stop-6", "stop-2"],
                               "Home shows the signed-off day in the same order")
        attachScreenshot(of: app, named: "assistant-day-on-home")

        // Home's edit mode: the system drag handle is on the untimed stop
        // alone — one handle among six rows, and it's that stop's.
        element(app, "home.dayEditButton").tap()
        XCTAssertTrue(element(app, "home.dayStop.stop-4").waitForExistence(timeout: 5))
        let handles = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Reorder '"))
        XCTAssertEqual(handles.count, 1, "only a stop with no set time gets a drag handle")
        XCTAssertEqual(handles.firstMatch.label, "Reorder MFA meeting")
    }

    /// #131: an edit is priced by the SERVER before sign-off (the mock
    /// prices a changed stop at the fixture's own rates: street $4.10 an
    /// hour, garage $12 an hour). A longer street stop raises its cost and
    /// the day total — asserted before and after, exactly. A garage stop
    /// stretched to 3 hours takes the day over the $60 cap: Sign off turns
    /// off and says why; shortening it back turns it on again.
    func testEditedStopIsRepricedBeforeSignOff() {
        let app = openAssistant("itinerary")
        ask(app, "plan my boston day")
        XCTAssertTrue(element(app, "assistant.itineraryPlan").waitForExistence(timeout: 10))
        let total = element(app, "assistant.dayTotal")
        XCTAssertTrue(total.waitForExistence(timeout: 5))
        XCTAssertEqual(total.label, "$40.40 of $60.00")
        XCTAssertTrue(stopRow(app, "stop-1").label.contains("$4.10"), stopRow(app, "stop-1").label)
        XCTAssertFalse(stopRow(app, "stop-1").label.contains("$8.20"))

        // stop-1 (street): 60 → 120 minutes.
        editDuration(app, stop: "stop-1", steps: 4, up: true)
        waitForLabel(of: total, toBe: "$44.50 of $60.00", timeout: 10)
        waitForLabelContaining(stopRow(app, "stop-1"), "$8.20")
        XCTAssertTrue(scrollTo(app, "assistant.signOffButton").isEnabled, "a day under the cap signs off")
        XCTAssertFalse(element(app, "assistant.overCapNote").exists)

        // stop-3 (garage): 60 → 180 minutes, $12 → $36: the day is $68.50.
        editDuration(app, stop: "stop-3", steps: 8, up: true)
        waitForLabel(of: total, toBe: "$68.50 of $60.00", timeout: 10)
        let reason = element(app, "assistant.overCapNote")
        XCTAssertTrue(reason.waitForExistence(timeout: 5), "no reason given for the disabled Sign off")
        XCTAssertTrue(reason.label.contains("over your $60.00 daily limit"), reason.label)
        XCTAssertFalse(scrollTo(app, "assistant.signOffButton").isEnabled, "over the cap must not sign off")
        attachScreenshot(of: app, named: "assistant-itinerary-over-cap")

        // Back to an hour: the proposed garage price again, and Sign off.
        editDuration(app, stop: "stop-3", steps: 8, up: false)
        waitForLabel(of: total, toBe: "$44.50 of $60.00", timeout: 10)
        XCTAssertTrue(reason.waitForNonExistence(timeout: 5), "the over-cap reason outlived the fix")
        XCTAssertTrue(scrollTo(app, "assistant.signOffButton").isEnabled, "back under the cap signs off")
    }

    /// Open a stop's edit sheet, step its duration by 15-minute steps, save.
    private func editDuration(_ app: XCUIApplication, stop: String, steps: Int, up: Bool) {
        scrollTo(app, "assistant.stopMenu.\(stop)").tap()
        XCTAssertTrue(app.buttons["Edit stop"].waitForExistence(timeout: 3))
        app.buttons["Edit stop"].tap()
        // SwiftUI names a Stepper's buttons "<identifier>-Increment/-Decrement".
        let button = app.buttons["stopEdit.duration-\(up ? "Increment" : "Decrement")"]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "no duration stepper")
        for _ in 0..<steps { button.tap() }
        element(app, "stopEdit.save").tap()
        XCTAssertTrue(waitForDisappearance(element(app, "stopEdit.save"), timeout: 5))
    }

    private func stopRow(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        element(app, "assistant.stopRow.\(id)")
    }

    /// The geometric claim: sorted by where they render, the rows come out
    /// in exactly this order. Every row is in the tree (the card is a plain
    /// VStack), so relative minY holds wherever the transcript is scrolled.
    private func assertStopsTopToBottom(
        _ app: XCUIApplication,
        _ expected: [String],
        _ message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for id in expected {
            XCTAssertTrue(stopRow(app, id).waitForExistence(timeout: 5), "\(id) missing", file: file, line: line)
        }
        let rendered = expected
            .map { ($0, stopRow(app, $0).frame.minY) }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
        XCTAssertEqual(rendered, expected, message, file: file, line: line)
    }

    /// Turn the edit sheet's time wheels (hour, minute, AM/PM).
    private func setStopTime(_ app: XCUIApplication, hour: String, period: String) {
        let wheels = app.pickerWheels
        XCTAssertTrue(wheels.firstMatch.waitForExistence(timeout: 5), "no time wheels")
        wheels.element(boundBy: 0).adjust(toPickerWheelValue: hour)
        wheels.element(boundBy: wheels.count - 1).adjust(toPickerWheelValue: period)
    }

    /// A Form toggle's element spans the row; the tap has to land on the
    /// switch itself.
    private func setToggle(_ app: XCUIApplication, _ identifier: String, on: Bool) {
        let toggle = app.switches[identifier]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let wanted = on ? "1" : "0"
        if toggle.value as? String == wanted { return }
        toggle.switches.firstMatch.tap()
        if toggle.value as? String != wanted {
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        }
        XCTAssertEqual(toggle.value as? String, wanted, "\(identifier) didn't switch")
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

    /// A name with two locations is a question with one chip per place —
    /// never a guess — and tapping a chip sends that place as the user's
    /// own words and gets the plan (the device test's "Moo steakhouse").
    func testAmbiguousPlaceOffersTappableChoices() {
        let app = openAssistant("placeChoices")
        ask(app, "near Moo steakhouse")

        let seaport = element(app, "assistant.suggestion.1")
        XCTAssertTrue(seaport.waitForExistence(timeout: 10))
        XCTAssertEqual(element(app, "assistant.suggestion.0").label, "Mooo.... · 15 Beacon St, Beacon Hill")
        XCTAssertEqual(seaport.label, "Mooo.... · 49 Melcher St, Seaport")
        XCTAssertFalse(element(app, "assistant.singleSpotPlan").exists, "Asked, not guessed")
        attachScreenshot(of: app, named: "assistant-place-choices")

        seaport.tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == 'assistant.userMessage' AND label == %@", "Mooo...., 49 Melcher St"
        )).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 5), "The chip sends its reply as the user's message")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))
        XCTAssertFalse(
            element(app, "assistant.suggestion.0").exists,
            "An answered question's chips go away"
        )
    }

    /// Saved conversations: newest first, titled by the first request, with
    /// what each came to; opening one shows its transcript and plans
    /// read-only, and the next message continues it; swipe deletes one;
    /// "Delete all" clears them.
    func testHistoryListsOpensResumesAndDeletes() {
        let app = openAssistant("singleSpot")
        element(app, "assistant.historyButton").tap()

        let fenway = element(app, "assistant.history.row.mock-history-fenway")
        let mfa = element(app, "assistant.history.row.mock-history-mfa")
        XCTAssertTrue(fenway.waitForExistence(timeout: 5))
        XCTAssertTrue(mfa.exists)
        XCTAssertLessThan(fenway.frame.minY, mfa.frame.minY, "Newest first")
        XCTAssertTrue(mfa.label.hasPrefix("Park me near the MFA for 90 minutes"), "got: \(mfa.label)")
        XCTAssertTrue(mfa.label.contains("Street — Boylston St · $4.10"), "got: \(mfa.label)")
        XCTAssertEqual(
            element(app, "assistant.history.retention").label,
            "Conversations are kept for 90 days after you last use them."
        )
        attachScreenshot(of: app, named: "assistant-history")

        // Open: the transcript, and its plan read-only — no Confirm on a
        // plan whose prices were for then.
        XCTAssertFalse(element(app, "assistant.storedPlan.mock-plan-single").exists)
        mfa.tap()
        let stored = element(app, "assistant.storedPlan.mock-plan-single")
        XCTAssertTrue(stored.waitForExistence(timeout: 5))
        XCTAssertTrue(stored.label.contains("Chosen"), "The option the user chose is marked")
        XCTAssertFalse(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'assistant.confirm.'")).firstMatch.exists
        )
        let opened = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == 'assistant.userMessage' AND label == %@", "Park me near the MFA for 90 minutes"
        )).firstMatch
        XCTAssertTrue(opened.exists)

        // Resume: the next message continues this conversation — it's the
        // newest in the list afterwards.
        ask(app, "make it two hours")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))
        element(app, "assistant.historyButton").tap()
        XCTAssertTrue(mfa.waitForExistence(timeout: 5))
        XCTAssertLessThan(mfa.frame.minY, fenway.frame.minY, "The resumed conversation moved to the top")

        // Swipe to delete one.
        fenway.swipeLeft()
        app.buttons["Delete"].firstMatch.tap()
        XCTAssertTrue(fenway.waitForNonExistence(timeout: 5))
        XCTAssertTrue(mfa.exists)

        // Delete all, confirmed.
        element(app, "assistant.history.deleteAll").tap()
        element(app, "assistant.history.confirmDeleteAll").tap()
        XCTAssertTrue(element(app, "assistant.history.empty").waitForExistence(timeout: 5))
        XCTAssertFalse(mfa.exists)
    }

    /// A plan made in chat shows in Activity, and its detail opens the
    /// conversation it came from.
    func testActivityOpensTheConversationAPlanCameFrom() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-resetState", "YES", "-useMockAPI", "YES", "-uiTesting", "YES",
            "-skipOnboarding", "YES", "-signedIn", "YES", "-fixedNow", Self.fixedNow,
        ]
        app.launch()
        app.tabBars.buttons["Activity"].tap()
        let row = scrollTo(app, "activity.row.plan:mock-plan-single")
        XCTAssertTrue(row.label.contains("Boylston St"), "got: \(row.label)")
        row.tap()
        let open = element(app, "activityDetail.openConversation")
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "assistant.sheet").exists)
        open.tap()
        XCTAssertTrue(element(app, "assistant.storedPlan.mock-plan-single").waitForExistence(timeout: 5))
        let opened = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == 'assistant.userMessage' AND label == %@", "Park me near the MFA for 90 minutes"
        )).firstMatch
        XCTAssertTrue(opened.exists)
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
