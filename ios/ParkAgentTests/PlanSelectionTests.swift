import MapKit
import XCTest
@testable import ParkAgent

/// Choosing an option on a single-spot plan: one selection drives rows and
/// pins, the recommended pin keeps its color only while nothing else is
/// chosen, the map centers on the choice, and the detail card's words come
/// from what the server sent.
@MainActor
final class PlanSelectionTests: XCTestCase {
    private func plan(_ json: String) throws -> SingleSpotPlan {
        let wrapped = "{\"planId\": \"p1\", \"plan\": \(json)}"
        let proposed = try JSONDecoder().decode(AssistantReply.ProposedPlan.self, from: Data(wrapped.utf8))
        guard case .singleSpot(let single) = proposed.plan else { throw XCTSkip("single spot expected") }
        return single
    }

    private var twoOptionPlan: String {
        """
        {"kind": "single_spot",
         "destination": {"lat": 42.35458, "lng": -71.04526, "label": "LoLa 42, Seaport"},
         "recommendedReason": "Cheapest and closest — free, 4 min walk",
         "options": [
          {"id": "street", "type": "street", "label": "Seaport Blvd", "detail": "", "priceUsd": 0,
           "durationMinutes": 180, "walkMinutes": 4, "zoneId": "bos-seaport-blvd-de413d-01",
           "lat": 42.3531, "lng": -71.0463, "recommended": true, "payOnArrival": true,
           "streetSummary": "Free after 6 PM on Seaport Blvd — 4 min walk", "streetState": "free",
           "priceBreakdown": {"meterUsd": 0, "feeUsd": 0}, "hoursToday": [{"start": "08:00", "end": "18:00"}],
           "maxStayMinutes": 240, "exceedsMaxStay": false},
          {"id": "garage", "type": "garage", "label": "One Seaport Garage", "detail": "", "priceUsd": 24,
           "durationMinutes": 180, "walkMinutes": 3, "entryType": "self", "provider": "parkwhiz",
           "startsAt": "2026-09-26T19:00:00-04:00",
           "lat": 42.3522, "lng": -71.0441, "recommended": false}
         ]}
        """
    }

    func testRecommendedStandsOutOnlyWhileNothingElseIsChosen() {
        XCTAssertEqual(PlanSelection.pinStyle(optionID: "street", recommendedID: "street", selectedID: nil), .recommended)
        XCTAssertEqual(PlanSelection.pinStyle(optionID: "garage", recommendedID: "street", selectedID: nil), .normal)
        XCTAssertEqual(PlanSelection.pinStyle(optionID: "garage", recommendedID: "street", selectedID: "garage"), .selected)
        XCTAssertEqual(
            PlanSelection.pinStyle(optionID: "street", recommendedID: "street", selectedID: "garage"), .dimmed,
            "The recommended pin loses its color when another option is chosen"
        )
        XCTAssertEqual(PlanSelection.pinStyle(optionID: "street", recommendedID: "street", selectedID: "street"), .selected)
    }

    func testTappingTheChosenOptionAgainClearsTheChoice() {
        XCTAssertEqual(PlanSelection.toggled(nil, tapping: "a"), "a")
        XCTAssertEqual(PlanSelection.toggled("a", tapping: "b"), "b")
        XCTAssertNil(PlanSelection.toggled("b", tapping: "b"))
    }

    func testTheMapCentersOnTheChoiceAndKeepsTheDestinationInView() throws {
        let p = try plan(twoOptionPlan)
        let region = PlanSelection.region(p, selectedID: "garage")
        XCTAssertEqual(region.center.latitude, 42.3522, accuracy: 1e-9)
        XCTAssertEqual(region.center.longitude, -71.0441, accuracy: 1e-9)
        // The destination (the route's other end) and the other option —
        // dimmed but still tappable — are inside the frame.
        for point in [(42.35458, -71.04526), (42.3531, -71.0463)] {
            XCTAssertLessThan(abs(point.0 - region.center.latitude), region.span.latitudeDelta / 2)
            XCTAssertLessThan(abs(point.1 - region.center.longitude), region.span.longitudeDelta / 2)
        }
        // Nothing chosen: the overview, not centered on any option.
        let overview = PlanSelection.region(p, selectedID: nil)
        XCTAssertNotEqual(overview.center.latitude, 42.3522, accuracy: 1e-6)
    }

    func testStreetDetailComesFromTheStreetSearch() throws {
        let street = try plan(twoOptionPlan).options[0]
        let detail = OptionDetailPresentation(option: street, destinationLabel: "LoLa 42, Seaport")
        XCTAssertEqual(detail.price, "Free — nothing to pay for this stay")
        XCTAssertEqual(detail.walk, "4 min walk from LoLa 42, Seaport")
        XCTAssertNil(detail.entry)
        XCTAssertEqual(detail.hours, "Meters 8 AM–6 PM today · 4 hr max")
        XCTAssertEqual(detail.checkout, "Pays through ParkBoston with the card saved there when you park here.")
        // The ParkAgent card pays meters for someone who chose it.
        let onOurCard = OptionDetailPresentation(option: street, destinationLabel: nil, paymentSource: .parkagentCard)
        XCTAssertEqual(onOurCard.checkout, "Pays through ParkBoston with the ParkAgent card when you park here.")
    }

    func testMeteredStreetShowsTheMeterAndFeeSplit() throws {
        let p = try plan("""
        {"kind": "single_spot", "options": [
          {"id": "s", "type": "street", "label": "Northern Av", "detail": "", "priceUsd": 4.10,
           "durationMinutes": 180, "zoneId": "bos-northern-av-36f4fd-00", "recommended": true,
           "priceBreakdown": {"meterUsd": 3.75, "feeUsd": 0.35},
           "hoursToday": [{"start": "08:00", "end": "20:00"}], "maxStayMinutes": 120,
           "exceedsMaxStay": true}
        ]}
        """)
        let detail = OptionDetailPresentation(option: p.options[0], destinationLabel: nil)
        XCTAssertEqual(detail.price, "Meter $3.75 + ParkBoston fee $0.35 = $4.10")
        XCTAssertEqual(detail.hours, "Meters 8 AM–8 PM today · 2 hr max — your stay runs past it")
        // A Confirm sets the spot; the meter is paid at the curb.
        XCTAssertEqual(detail.checkout, "Pays through ParkBoston with the card saved there when you park here.")
    }

    func testGarageDetailNamesItsSiteEntryAndWindow() throws {
        let garage = try plan(twoOptionPlan).options[1]
        let detail = OptionDetailPresentation(option: garage, destinationLabel: "LoLa 42, Seaport")
        XCTAssertEqual(detail.price, "$24.00 at checkout on ParkWhiz")
        XCTAssertEqual(detail.entry, "Self park")
        XCTAssertEqual(detail.checkout, "Checkout finishes on ParkWhiz; your pass lives in your ParkWhiz account.")
        let viaLink = OptionDetailPresentation(option: garage, destinationLabel: nil, linkPays: true)
        XCTAssertEqual(
            viaLink.checkout,
            "Approve it in Link, then pay at ParkWhiz's checkout with your Link card; the pass lives in your ParkWhiz account."
        )
        let start = try XCTUnwrap(Format.parseArrival("2026-09-26T19:00:00-04:00"))
        XCTAssertEqual(
            detail.hours,
            "\(Format.clockTime(start))–\(Format.clockTime(start.addingTimeInterval(180 * 60)))"
        )
    }

    func testMeterHoursClock() {
        XCTAssertEqual(OptionDetailPresentation.clock("08:00"), "8 AM")
        XCTAssertEqual(OptionDetailPresentation.clock("18:30"), "6:30 PM")
        XCTAssertEqual(OptionDetailPresentation.clock("24:00"), "midnight")
        XCTAssertEqual(OptionDetailPresentation.clock("12:00"), "noon")
    }
}
