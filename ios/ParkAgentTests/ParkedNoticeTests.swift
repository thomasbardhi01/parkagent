import CoreLocation
import UserNotifications
import XCTest
@testable import ParkAgent

/// The background-park notification: said only when there's something to
/// pay, with the zone and the price the sheet will show.
final class ParkedNoticeTests: XCTestCase {
    func testAPayableParkNamesTheZoneAndThePrice() throws {
        var parked = MockFixtures.singleQuote()
        parked.dryRun = false
        let content = try XCTUnwrap(ParkedNotice.content(for: parked))
        let quote = try XCTUnwrap(parked.quote)
        XCTAssertEqual(content.title, "Parked in zone 110436")
        XCTAssertEqual(
            content.body,
            "Pay \(Format.money(quote.totalUsd)) for \(Format.minutes(quote.stayMinutes)) — open ParkAgent to confirm."
        )
    }

    func testDryRunSaysNothingWillBeCharged() throws {
        let parked = MockFixtures.singleQuote()
        XCTAssertTrue(parked.dryRun, "Fixture should be dry run")
        let content = try XCTUnwrap(ParkedNotice.content(for: parked))
        XCTAssertTrue(content.body.hasSuffix("Dry run — nothing will be charged."), content.body)
    }

    func testTwoSidesAskToPickOne() throws {
        let content = try XCTUnwrap(ParkedNotice.content(for: MockFixtures.twoCandidates()))
        XCTAssertTrue(content.body.contains("Pick the side of the street you're on."), content.body)
    }

    func testAnUnnumberedBlockAsksForTheMetersNumber() throws {
        let parked = MockFixtures.bostonQuote(
            provider: MockFixtures.parkedProvider(id: "passport", status: "linked"),
            zoneNumber: nil
        )
        XCTAssertTrue(parked.needsZoneNumber, "Fixture should need a zone number")
        let content = try XCTUnwrap(ParkedNotice.content(for: parked))
        XCTAssertEqual(content.title, "Parked — zone number needed")
    }

    /// Parking at home (no meter) or after hours (free) must stay quiet —
    /// otherwise every drive home ends in a notification.
    func testNothingToPayStaysSilent() {
        XCTAssertNil(ParkedNotice.content(for: MockFixtures.unknownZone()))
        XCTAssertNil(ParkedNotice.content(for: MockFixtures.freePeriod()))
    }
}

/// The pending park survives the process for a while, and no longer.
final class ParkedNoticeStoreTests: XCTestCase {
    override func tearDown() {
        ParkedNotice.store(nil)
        super.tearDown()
    }

    func testAFreshParkIsRestored() {
        let parked = MockFixtures.singleQuote()
        ParkedNotice.store(parked)
        XCTAssertEqual(ParkedNotice.restore()?.parkedEventId, parked.parkedEventId)
    }

    func testClearingRemovesIt() {
        ParkedNotice.store(MockFixtures.singleQuote())
        ParkedNotice.store(nil)
        XCTAssertNil(ParkedNotice.restore())
    }

    /// Storing the same park again (the launch-time restore) must not
    /// refresh its age.
    func testRestoringTheSameParkKeepsItsAge() throws {
        let parked = MockFixtures.singleQuote()
        ParkedNotice.store(parked)
        let first = try XCTUnwrap(UserDefaults.standard.data(forKey: "pendingParked"))
        ParkedNotice.store(parked)
        XCTAssertEqual(UserDefaults.standard.data(forKey: "pendingParked"), first)
        // A different park replaces it.
        ParkedNotice.store(MockFixtures.twoCandidates())
        XCTAssertNotEqual(UserDefaults.standard.data(forKey: "pendingParked"), first)
    }
}

extension ParkedNoticeTests {
    /// A park the sheet can't pay as-is says what's in the way, never "Pay".
    func testRefusedParksDontInviteAPayment() throws {
        var overCap = MockFixtures.singleQuote()
        overCap.action = .confirm
        overCap.rule = "session_cap_exceeded"
        let capped = try XCTUnwrap(ParkedNotice.content(for: overCap))
        XCTAssertTrue(capped.body.contains("won't pay it"), capped.body)
        XCTAssertFalse(capped.body.hasPrefix("Pay "), capped.body)

        let unlinked = MockFixtures.singleQuote(provider: MockFixtures.parkedProvider(id: "parknyc", status: "unlinked"))
        XCTAssertEqual(unlinked.provider?.linked, false, "Fixture should be unlinked")
        let content = try XCTUnwrap(ParkedNotice.content(for: unlinked))
        XCTAssertTrue(content.body.hasPrefix("Connect ParkNYC in ParkAgent"), content.body)
    }

    /// A park with nowhere to point says why, instead of staying silent.
    func testAnUnlocatedParkSaysWhyAndWhatToDo() {
        let precise = ParkedNotice.unlocatedContent(preciseOff: true)
        XCTAssertTrue(precise.body.contains("Precise Location is off"), precise.body)
        XCTAssertTrue(precise.body.contains("Settings"), precise.body)
        let gps = ParkedNotice.unlocatedContent(preciseOff: false)
        XCTAssertFalse(gps.body.contains("Precise"), gps.body)
        XCTAssertTrue(gps.body.contains("Pay at the meter"), gps.body)
    }
}

/// FR-54: the prompts for a park that isn't a street meter. A garage or a
/// paid lot says what V1 can do about it (nothing: pay there), an unclear
/// place asks once, and no-pay says nothing at all.
@MainActor
final class ParkedPlaceNoticeTests: XCTestCase {
    private typealias Geo = PlaceClassifierTests.Geo

    private let noon = Date(timeIntervalSince1970: 1_800_000_000)
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func decide(
        _ response: ParkedResponse,
        located: Bool = true,
        at coordinate: CLLocationCoordinate2D? = Geo.origin,
        memory: PlaceMemory = PlaceMemory(),
        lastAutomotiveAt: Date? = nil,
        now: Date? = nil
    ) -> ParkedNotice.Decision {
        ParkedNotice.decide(
            for: response, located: located, at: coordinate, memory: memory,
            lastAutomotiveAt: lastAutomotiveAt, now: now ?? noon, calendar: utc
        )
    }

    // MARK: - The variants

    func testAKnownGarageIsNamedAndSaysWhatToDo() throws {
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: MockFixtures.garage()))
        XCTAssertEqual(prompt.content.title, "Looks like the Fixture Deck")
        XCTAssertEqual(
            prompt.content.body,
            "ParkAgent can't pay drive-up garages yet. Pay at the station or on the garage's own page."
        )
        XCTAssertEqual(prompt.category, .garage)
        XCTAssertEqual(prompt.category?.actions, [.notHere, .notAGarage])
        XCTAssertEqual(prompt.category?.actions.map(\.title), ["Not here", "Not a garage"])
        XCTAssertTrue(prompt.timeSensitive)
        XCTAssertTrue(prompt.isPlacePrompt)
        // A name that brings its own article doesn't get a second one.
        let named = try XCTUnwrap(ParkedNotice.prompt(for: MockFixtures.garage(name: "The Fixture Garage")))
        XCTAssertEqual(named.content.title, "Looks like The Fixture Garage")
    }

    func testAGarageNobodyCanNameAsks() throws {
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: MockFixtures.garage(name: nil)))
        XCTAssertEqual(prompt.content.title, "Parked in a garage?")
        XCTAssertTrue(prompt.content.body.contains("can't pay drive-up garages yet"), prompt.content.body)
        XCTAssertEqual(prompt.category, .garage)
    }

    func testAPaidLotSaysItChargesAndOffersNoPayment() throws {
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: MockFixtures.paidLot()))
        XCTAssertEqual(prompt.content.title, "Parked at Fixture Lot")
        XCTAssertEqual(
            prompt.content.body,
            "This lot charges, and ParkAgent can't pay lots yet. Pay at the pay station or by the lot's sign."
        )
        XCTAssertEqual(prompt.category, .lot)
        XCTAssertEqual(prompt.category?.actions.map(\.title), ["Not here", "No payment"])
        XCTAssertTrue(prompt.timeSensitive)
        let unnamed = try XCTUnwrap(ParkedNotice.prompt(for: MockFixtures.paidLot(name: nil)))
        XCTAssertEqual(unnamed.content.title, "Parked in a paid lot")
    }

    func testAnUnclearPlaceAsksOncePassively() throws {
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: MockFixtures.placeUnknown()))
        XCTAssertEqual(prompt.content.title, "Parked?")
        XCTAssertEqual(prompt.content.body, "Tell ParkAgent what this place is and it won't ask again.")
        XCTAssertEqual(prompt.category, .ask)
        XCTAssertEqual(prompt.category?.actions.map(\.title), ["Street", "Garage", "Lot", "No payment"])
        XCTAssertFalse(prompt.timeSensitive, "Nothing is running: it can wait")
        XCTAssertTrue(prompt.isPlacePrompt)
    }

    /// The place is unclear but a meter in reach would charge: the street
    /// notice, exactly as today, with the other answers one tap away.
    func testAnUnclearPlaceWithAQuoteIsTheStreetNotice() throws {
        let unclear = MockFixtures.placeUnknownWithQuote()
        var street = unclear
        street.rule = "rate_above_ceiling"
        street.place = nil
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: unclear))
        XCTAssertEqual(prompt.content, ParkedNotice.content(for: street))
        XCTAssertTrue(prompt.content.body.hasPrefix("Pay "), prompt.content.body)
        XCTAssertEqual(prompt.category, .askStreet)
        XCTAssertEqual(prompt.category?.actions.map(\.title), ["Garage", "Lot", "No payment"])
        XCTAssertTrue(prompt.timeSensitive, "A meter may be running")
        XCTAssertFalse(prompt.isPlacePrompt, "There is something to pay: never held back, never deduped")
    }

    func testNoPayIsSilent() {
        XCTAssertNil(ParkedNotice.prompt(for: MockFixtures.noPayment()))
        XCTAssertNil(ParkedNotice.content(for: MockFixtures.noPayment()))
        XCTAssertEqual(decide(MockFixtures.noPayment()), .silent(.noPayment))
        XCTAssertFalse(decide(MockFixtures.noPayment()).showsSheet, "No sheet either")
    }

    /// Street parks are untouched: no category, the content they always had.
    func testStreetNoticesCarryNoPlaceActions() throws {
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: MockFixtures.singleQuote()))
        XCTAssertNil(prompt.category)
        XCTAssertFalse(prompt.isPlacePrompt)
        XCTAssertEqual(prompt.content, ParkedNotice.content(for: MockFixtures.singleQuote()))
        XCTAssertEqual(decide(MockFixtures.unknownZone()), .silent(.nothingToSay))
        XCTAssertTrue(decide(MockFixtures.unknownZone()).showsSheet, "The sheet still says there's no zone here")
    }

    /// V1 has no ticket flow (#181): nothing offers to scan one.
    func testNothingOffersToScanATicket() {
        for category in ParkedNotice.Category.allCases {
            XCTAssertFalse(category.actions.isEmpty, category.rawValue)
            for action in category.actions {
                XCTAssertFalse(action.title.localizedCaseInsensitiveContains("scan"), action.title)
            }
        }
        // Every action either records an answer or opens the app to ask.
        XCTAssertEqual(ParkedNotice.Action.notHere.answer, .notHere)
        XCTAssertEqual(ParkedNotice.Action.noPayment.answer, .nopay)
        XCTAssertEqual(ParkedNotice.Action.street.answer, .street)
        XCTAssertEqual(ParkedNotice.Action.garage.answer, .garage)
        XCTAssertEqual(ParkedNotice.Action.lot.answer, .lot)
        XCTAssertNil(ParkedNotice.Action.notAGarage.answer, "It isn't a garage: ask what it is")
        XCTAssertEqual(ParkedNotice.Action.allCases.filter(\.opensApp), [.notAGarage])
        // Identifiers are what a tap comes back as.
        XCTAssertEqual(Set(ParkedNotice.Action.allCases.map(\.rawValue)).count, ParkedNotice.Action.allCases.count)
        XCTAssertEqual(ParkedNotice.Action(rawValue: ParkedNotice.Action.noPayment.rawValue), .noPayment)
    }

    // MARK: - The buttons, as iOS sees them

    /// iOS shows a button only for a category registered before the
    /// notification is posted. Registered at launch, with only "Not a
    /// garage" bringing the app forward.
    func testTheCategoriesAreRegisteredAtLaunch() async {
        PushManager.shared.attach()
        let registered = await UNUserNotificationCenter.current().notificationCategories()
        for category in ParkedNotice.Category.allCases {
            let found = registered.first { $0.identifier == category.rawValue }
            XCTAssertEqual(found?.actions.map(\.identifier), category.actions.map(\.rawValue), category.rawValue)
            XCTAssertEqual(found?.actions.map(\.title), category.actions.map(\.title), category.rawValue)
            for action in found?.actions ?? [] {
                XCTAssertEqual(
                    action.options.contains(.foreground),
                    action.identifier == ParkedNotice.Action.notAGarage.rawValue,
                    action.identifier
                )
            }
        }
    }

    /// A tapped button comes back as its identifier plus the userInfo the
    /// notification was posted with: which park, and where.
    func testATappedButtonNamesItsPark() throws {
        let userInfo: [AnyHashable: Any] = ["type": "parked", "parkedEventId": "pe1", "lat": 42.35, "lng": -71.07]
        let tapped = try XCTUnwrap(PushManager.placeAction(identifier: "parked.place.nopay", userInfo: userInfo))
        XCTAssertEqual(tapped.action, .noPayment)
        XCTAssertEqual(tapped.parkedEventId, "pe1")
        XCTAssertEqual(tapped.coordinate?.latitude, 42.35)
        XCTAssertEqual(tapped.coordinate?.longitude, -71.07)

        // The notification itself (not a button) is the ordinary tap.
        XCTAssertNil(PushManager.placeAction(identifier: UNNotificationDefaultActionIdentifier, userInfo: userInfo))
        // A button with no park behind it answers nothing.
        XCTAssertNil(PushManager.placeAction(identifier: "parked.place.nopay", userInfo: ["type": "parked"]))
        // No spot is still an answer for the server.
        let bare = try XCTUnwrap(PushManager.placeAction(identifier: "parked.place.not_here", userInfo: ["parkedEventId": "pe2"]))
        XCTAssertEqual(bare.action, .notHere)
        XCTAssertNil(bare.coordinate)
    }

    // MARK: - When not to ask

    func testNeverWhileTheCarWasMovingInTheLastMinute() throws {
        let garage = MockFixtures.garage()
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: garage))
        XCTAssertEqual(
            decide(garage, lastAutomotiveAt: noon.addingTimeInterval(-20)),
            .hold(prompt, until: noon.addingTimeInterval(40))
        )
        XCTAssertEqual(decide(garage, lastAutomotiveAt: noon.addingTimeInterval(-59)), .hold(prompt, until: noon.addingTimeInterval(1)))
        XCTAssertEqual(decide(garage, lastAutomotiveAt: noon.addingTimeInterval(-60)), .post(prompt))
        XCTAssertEqual(decide(garage, lastAutomotiveAt: noon.addingTimeInterval(-600)), .post(prompt))
        XCTAssertEqual(decide(garage, lastAutomotiveAt: nil), .post(prompt))
        // The ask and the lot wait the same way.
        guard case .hold = decide(MockFixtures.placeUnknown(), lastAutomotiveAt: noon.addingTimeInterval(-5)) else {
            return XCTFail("The ask must wait too")
        }
        guard case .hold = decide(MockFixtures.paidLot(), lastAutomotiveAt: noon.addingTimeInterval(-5)) else {
            return XCTFail("The lot must wait too")
        }
        XCTAssertTrue(decide(garage, lastAutomotiveAt: noon.addingTimeInterval(-5)).showsSheet)
    }

    /// A meter doesn't wait for the driver to settle: street notices go out
    /// as they always have.
    func testAStreetQuoteIsNeverHeldBack() throws {
        let street = MockFixtures.singleQuote()
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: street))
        XCTAssertEqual(decide(street, lastAutomotiveAt: noon.addingTimeInterval(-5)), .post(prompt))
        let unclear = MockFixtures.placeUnknownWithQuote()
        XCTAssertEqual(
            decide(unclear, lastAutomotiveAt: noon.addingTimeInterval(-5)),
            .post(try XCTUnwrap(ParkedNotice.prompt(for: unclear)))
        )
    }

    func testNeverTwiceForTheSamePlaceInADay() throws {
        let garage = MockFixtures.garage()
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: garage))
        var memory = PlaceMemory()
        XCTAssertEqual(decide(garage, memory: memory), .post(prompt))
        memory.notePrompt(at: Geo.origin, now: noon)

        // The same garage that afternoon, a few spaces over: quiet, and no sheet.
        let later = noon.addingTimeInterval(4 * 3_600)
        let again = decide(garage, at: Geo.at(n: 30, e: 0), memory: memory, now: later)
        XCTAssertEqual(again, .silent(.askedToday))
        XCTAssertFalse(again.showsSheet)
        XCTAssertEqual(decide(MockFixtures.placeUnknown(), memory: memory, now: later), .silent(.askedToday))

        // Somewhere else the same day, and the same place tomorrow, ask.
        XCTAssertEqual(decide(garage, at: Geo.at(n: 0, e: 200), memory: memory, now: later), .post(prompt))
        XCTAssertEqual(decide(garage, memory: memory, now: noon.addingTimeInterval(24 * 3_600)), .post(prompt))
        // "A day" is the calendar's: 11 pm and 1 am are two days.
        let lateEvening = try XCTUnwrap(utc.date(from: DateComponents(year: 2027, month: 1, day: 15, hour: 23)))
        var night = PlaceMemory()
        night.notePrompt(at: Geo.origin, now: lateEvening)
        XCTAssertEqual(decide(garage, memory: night, now: lateEvening.addingTimeInterval(2 * 3_600)), .post(prompt))
        XCTAssertEqual(decide(garage, memory: night, now: lateEvening.addingTimeInterval(1_800)), .silent(.askedToday))
    }

    /// A meter that would charge is said every time, whatever was asked
    /// about the place earlier that day.
    func testAPayableParkIsNeverDeduped() throws {
        var memory = PlaceMemory()
        memory.notePrompt(at: Geo.origin, now: noon)
        memory.notMyCar(at: Geo.origin, now: noon)
        for response in [MockFixtures.singleQuote(), MockFixtures.twoCandidates(), MockFixtures.placeUnknownWithQuote()] {
            let prompt = try XCTUnwrap(ParkedNotice.prompt(for: response))
            XCTAssertEqual(decide(response, memory: memory, now: noon.addingTimeInterval(60)), .post(prompt), response.rule)
        }
    }

    /// The driver answered here twice already: nothing new to say.
    func testASavedPlaceIsNotAskedAbout() {
        let saved = MockFixtures.garage(source: "memory")
        XCTAssertEqual(decide(saved), .silent(.savedPlace))
        XCTAssertFalse(decide(saved).showsSheet)
    }

    func testNotHereQuietsTheSpotForTwoHours() throws {
        let garage = MockFixtures.garage()
        var memory = PlaceMemory()
        memory.notMyCar(at: Geo.origin, now: noon)
        XCTAssertEqual(decide(garage, memory: memory, now: noon.addingTimeInterval(3_600)), .silent(.notHere))
        XCTAssertEqual(
            decide(garage, memory: memory, now: noon.addingTimeInterval(PlaceMemory.notMyCarFor + 1)),
            .post(try XCTUnwrap(ParkedNotice.prompt(for: garage)))
        )
    }

    /// A held prompt is taken back if the car drives on before it is due,
    /// and only then: once it is due it has been said.
    func testAHeldPromptCanBeTakenBackUntilItIsDue() async throws {
        let garage = MockFixtures.garage()
        let prompt = try XCTUnwrap(ParkedNotice.prompt(for: garage))
        await ParkedNotice.post(prompt, parkedEventId: "pe-held", at: Geo.origin, due: noon.addingTimeInterval(40), now: noon)
        let held = try XCTUnwrap(ParkedNotice.held)
        XCTAssertEqual(held.parkedEventId, "pe-held")
        XCTAssertEqual(held.due, noon.addingTimeInterval(40))
        XCTAssertEqual(held.notedAt, noon)

        let cancelled = ParkedNotice.cancelHeld(now: noon.addingTimeInterval(10))
        XCTAssertEqual(cancelled, held, "The car drove on 10 s in: the prompt comes back")
        XCTAssertNil(ParkedNotice.held)
        XCTAssertNil(ParkedNotice.cancelHeld(now: noon.addingTimeInterval(11)), "Nothing left to take back")

        // Past its due time it was delivered: driving off later takes nothing back.
        await ParkedNotice.post(prompt, parkedEventId: "pe-held", at: Geo.origin, due: noon.addingTimeInterval(40), now: noon)
        XCTAssertNil(ParkedNotice.cancelHeld(now: noon.addingTimeInterval(41)))
        XCTAssertNil(ParkedNotice.held)

        // A prompt posted at once holds nothing, and replaces one that was held.
        await ParkedNotice.post(prompt, parkedEventId: "pe-held", at: Geo.origin, due: noon.addingTimeInterval(40), now: noon)
        await ParkedNotice.post(prompt, parkedEventId: "pe-now", at: Geo.origin, due: nil, now: noon)
        XCTAssertNil(ParkedNotice.held)
        ParkedNotice.withdraw()
    }

    // MARK: - No fix at the spot

    func testAParkWithNoFixIsPromptedFromTheServersAnswer() throws {
        let garage = MockFixtures.garage()
        XCTAssertEqual(decide(garage, located: false), .post(try XCTUnwrap(ParkedNotice.prompt(for: garage))))
        let ask = MockFixtures.placeUnknown()
        XCTAssertEqual(decide(ask, located: false), .post(try XCTUnwrap(ParkedNotice.prompt(for: ask))))
        XCTAssertEqual(decide(MockFixtures.noPayment(), located: false), .silent(.noPayment))
    }

    /// The fix sent was the entry fix, not the car's. A street answer for
    /// it (a server from before FR-54, or one with nothing to add) must
    /// never reach the driver as a quote: say the park couldn't be placed.
    func testAStreetAnswerForAParkWithNoFixIsNeverShown() {
        for response in [MockFixtures.singleQuote(), MockFixtures.twoCandidates(), MockFixtures.freePeriod(), MockFixtures.unknownZone()] {
            let decision = decide(response, located: false)
            XCTAssertEqual(decision, .unlocated, response.rule)
            XCTAssertFalse(decision.showsSheet, response.rule)
        }
        var quoted = MockFixtures.placeUnknownWithQuote()
        quoted.place = MockFixtures.place("unknown", confidence: 0)
        XCTAssertEqual(decide(quoted, located: false), .unlocated, "A quote for the entry fix is not for the car")
    }

    // MARK: - On the phone alone

    /// Underground with no signal, /parked can't answer. The phone's own
    /// classification still says "garage", with nothing to act on yet.
    func testAnOfflineGarageParkIsSaidFromThePhonesOwnRead() throws {
        let garage = PlaceClassification(
            placeClass: .garage, confidence: 0.6, runnerUp: nil,
            inputs: .init(located: false, memoryHit: false, footprintId: nil, footprintKind: nil, containsPoint: false,
                          nearestEntranceM: nil, gpsLoss: true, baroDeltaM: nil, crawl: false, entryFix: nil, zones: .unknown)
        )
        let prompt = ParkedNotice.offlinePrompt(for: garage, preciseOff: false)
        XCTAssertEqual(prompt.content.title, "Parked in a garage?")
        XCTAssertTrue(prompt.content.body.contains("can't pay drive-up garages yet"), prompt.content.body)
        XCTAssertNil(prompt.category, "No park on the server yet to answer about")

        var unknown = garage
        unknown.placeClass = .unknown
        XCTAssertEqual(
            ParkedNotice.offlinePrompt(for: unknown, preciseOff: false).content,
            ParkedNotice.unlocatedContent(preciseOff: false)
        )
        XCTAssertEqual(
            ParkedNotice.offlinePrompt(for: garage, preciseOff: true).content,
            ParkedNotice.unlocatedContent(preciseOff: true),
            "Precise Location off is its own problem, with its own fix"
        )
    }
}

/// The driver's answer about a place (FR-54): sent to the server first,
/// and the phone's place memory changes only when that succeeds.
@MainActor
final class PlaceAnswerTests: XCTestCase {
    private typealias Geo = PlaceClassifierTests.Geo

    /// Answers POST /parked/:id/place and nothing else.
    final class AnsweringAPI: HangingAPI, @unchecked Sendable {
        private let lock = NSLock()
        private var _calls: [(id: String, placeClass: String, name: String?)] = []
        private let fails: Bool

        init(fails: Bool = false) { self.fails = fails }

        var calls: [(id: String, placeClass: String, name: String?)] { lock.withLock { _calls } }

        override func answerPlace(parkedEventId: String, placeClass: String, name: String?) async throws -> PlaceAnswerResponse {
            lock.withLock { _calls.append((parkedEventId, placeClass, name)) }
            if fails { throw APIError.transport(URLError(.notConnectedToInternet)) }
            return PlaceAnswerResponse(ok: true, parkedEventId: parkedEventId, placeClass: placeClass, name: name, changed: true, decisionId: "d2")
        }
    }

    private func tempPlaces() -> PlaceMemoryStore {
        PlaceMemoryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    }

    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testAnAnswerTheServerTookIsRemembered() async {
        let api = AnsweringAPI()
        let places = tempPlaces()
        let first = await PlaceAnswers.record(.garage, parkedEventId: "pe1", at: Geo.origin, api: api, memory: places, now: now)
        XCTAssertTrue(first)
        XCTAssertEqual(api.calls.map(\.id), ["pe1"])
        XCTAssertEqual(api.calls.map(\.placeClass), ["garage"])
        XCTAssertEqual(places.memory.places.map(\.placeClass), [.garage])
        XCTAssertNil(places.memory.place(near: Geo.origin), "One answer isn't a saved place yet")

        // The same answer at the next park here saves the place.
        _ = await PlaceAnswers.record(.garage, parkedEventId: "pe2", at: Geo.at(n: 10, e: 0), api: api, memory: places, now: now.addingTimeInterval(86_400))
        XCTAssertEqual(places.memory.place(near: Geo.origin)?.placeClass, .garage)
        // And it is on disk for the detector's next launch.
        XCTAssertEqual(PlaceMemoryStore(directory: places.fileURL.deletingLastPathComponent()).memory.places.count, 1)
    }

    func testAnAnswerTheServerNeverGotTeachesNothing() async {
        let api = AnsweringAPI(fails: true)
        let places = tempPlaces()
        for answer in ParkedNotice.PlaceAnswer.allCases {
            let ok = await PlaceAnswers.record(answer, parkedEventId: "pe1", at: Geo.origin, api: api, memory: places, now: now)
            XCTAssertFalse(ok, answer.rawValue)
        }
        XCTAssertEqual(api.calls.count, ParkedNotice.PlaceAnswer.allCases.count)
        XCTAssertEqual(places.memory, PlaceMemory())
        XCTAssertFalse(FileManager.default.fileExists(atPath: places.fileURL.path))
    }

    func testEachAnswerBecomesItsClass() async {
        for (answer, expected) in [(ParkedNotice.PlaceAnswer.street, PlaceClass.street), (.lot, .lot), (.nopay, .nopay), (.garage, .garage)] {
            let api = AnsweringAPI()
            let places = tempPlaces()
            _ = await PlaceAnswers.record(answer, parkedEventId: "pe1", at: Geo.origin, api: api, memory: places, now: now)
            XCTAssertEqual(api.calls.first?.placeClass, answer.rawValue)
            XCTAssertEqual(places.memory.places.map(\.placeClass), [expected], answer.rawValue)
        }
    }

    /// "Not here" is not a place: the spot goes quiet for two hours and
    /// nothing is learned about it.
    func testNotHereQuietsTheSpotAndTeachesNothing() async {
        let api = AnsweringAPI()
        let places = tempPlaces()
        let ok = await PlaceAnswers.record(.notHere, parkedEventId: "pe1", at: Geo.origin, api: api, memory: places, now: now)
        XCTAssertTrue(ok)
        XCTAssertEqual(api.calls.first?.placeClass, "not_here")
        XCTAssertTrue(places.memory.places.isEmpty)
        XCTAssertTrue(places.memory.isSuppressed(at: Geo.origin, now: now.addingTimeInterval(3_600)))
    }

    /// A notification that outlived its coordinates (it can't, but the
    /// userInfo is the system's to hand back) still records the answer.
    func testAnAnswerWithNoCoordinateIsRecordedButNotRemembered() async {
        let api = AnsweringAPI()
        let places = tempPlaces()
        let ok = await PlaceAnswers.record(.nopay, parkedEventId: "pe1", at: nil, api: api, memory: places, now: now)
        XCTAssertTrue(ok)
        XCTAssertEqual(api.calls.count, 1)
        XCTAssertEqual(places.memory, PlaceMemory())
    }
}
