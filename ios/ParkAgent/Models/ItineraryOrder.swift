import Foundation

/// The one ordering rule for an itinerary's stops. The server applies the
/// same rule (server/src/services/assistant/plans.ts `orderStopsByArrival`),
/// so what's stored is what shows.
///
/// A stop with no set time keeps the slot it occupies — the user put it
/// there; the timed stops fill the remaining slots in ascending arrival,
/// ties keeping their relative order. So a later stop can never render
/// above an earlier one, and only an untimed stop is ever moved by hand.
/// An arrival that doesn't parse orders like no time at all, as it does on
/// the server.
enum ItineraryOrder {
    static func normalized(_ stops: [ItineraryStop]) -> [ItineraryStop] {
        struct Timed {
            let stop: ItineraryStop
            let index: Int
            let at: Date
        }
        let timed = stops.enumerated()
            .compactMap { index, stop in arrival(of: stop).map { Timed(stop: stop, index: index, at: $0) } }
            .sorted { $0.at != $1.at ? $0.at < $1.at : $0.index < $1.index }
        var next = timed.makeIterator()
        return stops.map { stop in
            arrival(of: stop) == nil ? stop : next.next()!.stop
        }
    }

    /// Drag and Move up/down exist only for a stop without a set time: a
    /// timed stop's place is its time.
    static func isMovable(_ stop: ItineraryStop) -> Bool {
        arrival(of: stop) == nil
    }

    static func arrival(of stop: ItineraryStop) -> Date? {
        stop.arrival.flatMap(Format.parseArrival)
    }
}
