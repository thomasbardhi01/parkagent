import XCTest
@testable import ParkAgent

/// The itinerary ordering rule (ItineraryOrder, mirrored on the server by
/// orderStopsByArrival): timed stops in arrival order, untimed stops in
/// the slots the user put them.
final class ItineraryOrderTests: XCTestCase {
    private func stop(_ id: String, _ arrival: String?) -> ItineraryStop {
        ItineraryStop(
            id: id, label: id, address: "", lat: 42.35, lng: -71.08,
            arrival: arrival, durationMinutes: 60, choice: "street",
            costUsd: 4.1, zoneId: nil, garageOptionId: nil, deepLink: nil,
            sessionId: nil, paymentSource: nil, garageLinkPushedAt: nil
        )
    }

    private func at(_ hhmm: String) -> String { "2026-01-05T\(hhmm):00-05:00" }

    private func permutations<T>(_ items: [T]) -> [[T]] {
        guard items.count > 1 else { return [items] }
        return items.indices.flatMap { i -> [[T]] in
            var rest = items
            let head = rest.remove(at: i)
            return permutations(rest).map { [head] + $0 }
        }
    }

    /// Two untimed stops, three timed, two of those tied.
    private var mixed: [ItineraryStop] {
        [stop("a", at("09:00")), stop("b", at("11:00")), stop("c", at("11:00")),
         stop("u1", nil), stop("u2", nil)]
    }

    func testEveryInputOrderComesOutAscendingWithUntimedStopsInPlace() {
        let inputs = permutations(mixed)
        XCTAssertEqual(inputs.count, 120)
        for input in inputs {
            let out = ItineraryOrder.normalized(input)
            XCTAssertEqual(Set(out.map(\.id)), Set(input.map(\.id)))
            XCTAssertEqual(out.count, input.count)

            let times = out.compactMap(ItineraryOrder.arrival(of:))
            XCTAssertEqual(times, times.sorted(), "later stop above an earlier one: \(out.map(\.id))")

            for (index, stop) in input.enumerated() where stop.arrival == nil {
                XCTAssertEqual(out[index].id, stop.id, "untimed \(stop.id) left its slot")
            }

            let tie = { (stops: [ItineraryStop]) in stops.map(\.id).filter { $0 == "b" || $0 == "c" } }
            XCTAssertEqual(tie(out), tie(input), "tied stops swapped")
        }
    }

    /// The server stores ET with an offset; the app writes UTC. Both must
    /// read as instants, or a re-timed stop sorts by string.
    func testOffsetsAndUtcCompareAsInstants() {
        let out = ItineraryOrder.normalized([
            stop("late", at("15:00")),
            stop("early", "2026-01-05T19:30:00Z"), // 14:30 ET
        ])
        XCTAssertEqual(out.map(\.id), ["early", "late"])
    }

    func testOnlyAnUntimedStopIsMovable() {
        XCTAssertTrue(ItineraryOrder.isMovable(stop("u", nil)))
        XCTAssertFalse(ItineraryOrder.isMovable(stop("t", at("09:00"))))
    }

    func testUntimedStopsReadAnyTime() {
        XCTAssertEqual(Format.arrivalTime(nil), "Any time")
        XCTAssertNotEqual(Format.arrivalTime(at("09:00")), "Any time")
    }

    /// Sign-off sends the card's changes with it (the server re-prices
    /// them). Comparing only the ORDER once dropped a new time on a stop
    /// that stayed put.
    func testSignOffSavesAnyCardEditNotJustAReorder() {
        let proposed = [stop("a", at("09:00")), stop("b", at("11:00"))]
        XCTAssertNil(AssistantModel.cardEditsToSend(proposed: proposed, card: proposed))

        var retimed = proposed
        retimed[1].arrival = at("12:00") // same order, new time
        XCTAssertEqual(AssistantModel.cardEditsToSend(proposed: proposed, card: retimed), retimed)

        var cleared = proposed
        cleared[0].arrival = nil
        XCTAssertEqual(AssistantModel.cardEditsToSend(proposed: proposed, card: cleared), cleared)

        var longer = proposed
        longer[0].durationMinutes = 90
        XCTAssertEqual(AssistantModel.cardEditsToSend(proposed: proposed, card: longer), longer)
    }

    /// An untimed stop decodes from the server's `null` and from a stop
    /// with no arrival key at all.
    func testUntimedStopDecodesFromNullOrMissing() throws {
        let json = #"""
        [{"id": "n", "label": "x", "address": "", "lat": 1, "lng": 2, "arrival": null,
          "durationMinutes": 60, "choice": "street", "costUsd": 1},
         {"id": "m", "label": "x", "address": "", "lat": 1, "lng": 2,
          "durationMinutes": 60, "choice": "street", "costUsd": 1}]
        """#
        let stops = try JSONDecoder().decode([ItineraryStop].self, from: Data(json.utf8))
        XCTAssertEqual(stops.map(\.arrival), [nil, nil])
    }
}
