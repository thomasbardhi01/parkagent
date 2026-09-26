import CoreLocation
import Foundation
import MapKit

/// The rules for choosing an option on a single-spot plan, kept apart from
/// the views so they're unit-testable: how each map pin looks for a given
/// selection, where the map centers, and the words on the detail card.
///
/// One selection drives both the rows and the pins. Tapping a row or its
/// pin selects that option: its pin is highlighted, the map recenters on
/// it, every other pin dims, and its detail card opens. The recommended
/// option keeps its distinct color only while nothing else is selected.
enum PlanSelection {
    enum PinStyle: String, Equatable {
        /// Nothing selected: the recommended option stands out.
        case recommended
        /// This option is the selection.
        case selected
        /// Another option is the selection.
        case dimmed
        /// Nothing selected, not the recommended one.
        case normal
    }

    static func pinStyle(optionID: String, recommendedID: String?, selectedID: String?) -> PinStyle {
        if let selectedID {
            return optionID == selectedID ? .selected : .dimmed
        }
        return optionID == recommendedID ? .recommended : .normal
    }

    /// Tapping the selected option again clears the selection.
    static func toggled(_ current: String?, tapping id: String) -> String? {
        current == id ? nil : id
    }

    /// The overview: the destination and every pinned option, with a floor
    /// so a single pin doesn't zoom to the building.
    static func overviewRegion(_ plan: SingleSpotPlan) -> MKCoordinateRegion {
        var points: [CLLocationCoordinate2D] = plan.options.compactMap(\.coordinate)
        if let destination = plan.destination?.coordinate { points.append(destination) }
        return fitting(points)
    }

    /// Centered ON the selected option, wide enough to keep the destination
    /// (the route's other end) and the other options in view — dimmed, but
    /// still there to tap.
    static func region(_ plan: SingleSpotPlan, selectedID: String?) -> MKCoordinateRegion {
        guard let selectedID,
              let option = plan.options.first(where: { $0.id == selectedID }),
              let center = option.coordinate
        else { return overviewRegion(plan) }
        var others: [CLLocationCoordinate2D] = plan.options.compactMap(\.coordinate)
        if let destination = plan.destination?.coordinate { others.append(destination) }
        let latReach = others.map { abs($0.latitude - center.latitude) }.max() ?? 0
        let lngReach = others.map { abs($0.longitude - center.longitude) }.max() ?? 0
        return MKCoordinateRegion(
            center: center,
            span: MKCoordinateSpan(
                // 2.9×: the farthest pin sits a pin's width inside the
                // 200-pt map — MapKit drops an annotation whose view would
                // cross the edge.
                latitudeDelta: max(0.004, latReach * 2.9),
                longitudeDelta: max(0.004, lngReach * 2.9)
            )
        )
    }

    private static func fitting(_ points: [CLLocationCoordinate2D]) -> MKCoordinateRegion {
        guard let first = points.first else {
            // No pins at all (the plan carries its options' own points, so
            // this is a malformed plan): the metro fallback, never a fixed
            // point in one city.
            return MKCoordinateRegion(
                center: CityCatalog.fallbackCenter,
                span: MKCoordinateSpan(latitudeDelta: 0.01, longitudeDelta: 0.01)
            )
        }
        let lats = points.map(\.latitude)
        let lngs = points.map(\.longitude)
        let minLat = lats.min() ?? first.latitude
        let maxLat = lats.max() ?? first.latitude
        let minLng = lngs.min() ?? first.longitude
        let maxLng = lngs.max() ?? first.longitude
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
            span: MKCoordinateSpan(
                latitudeDelta: max((maxLat - minLat) * 1.6, 0.006),
                longitudeDelta: max((maxLng - minLng) * 1.6, 0.006)
            )
        )
    }
}

/// The words on an option's detail card. Everything comes from the plan
/// the server sent — the street search's price split and posted hours,
/// the garage search's source — never computed on the phone.
struct OptionDetailPresentation: Equatable {
    /// "Meter $3.75 + ParkBoston fee $0.35 = $4.10"
    let price: String
    /// "4 min walk from LoLa 42, Seaport"
    let walk: String?
    /// "Self park" (garages)
    let entry: String?
    /// Street: "Meters 8 AM–6 PM today · 4 hr max"; garage: "7:00 PM–10:00 PM".
    let hours: String?
    /// Who takes the money and where.
    let checkout: String

    /// `paymentSource` is the Wallet's; `linkPays` is whether Link pays
    /// garages right now. The payment sentences are WalletCopy's.
    init(
        option: SingleSpotOption,
        destinationLabel: String?,
        paymentSource: PaymentSource = .providerCard,
        linkPays: Bool = false
    ) {
        let city = option.zoneId.flatMap { $0.split(separator: "-").first.map(String.init) }
        let meterApp = CityCatalog.providerDisplayName(for: city) ?? "the city's parking app"
        let garageSite = option.provider.flatMap(GarageSource.displayName)

        if option.type == "street" {
            if let split = option.priceBreakdown {
                price = split.meterUsd == 0
                    ? "Free — nothing to pay for this stay"
                    : "Meter \(Format.money(split.meterUsd)) + \(meterApp) fee \(Format.money(split.feeUsd)) = \(Format.money(option.priceUsd))"
            } else {
                price = option.priceUsd == 0
                    ? "Free — nothing to pay for this stay"
                    : "\(Format.money(option.priceUsd)) for \(Format.minutes(option.durationMinutes))"
            }
            entry = nil
            hours = Self.meterHours(option)
            checkout = WalletCopy.streetPays(provider: meterApp, source: paymentSource)
        } else {
            price = garageSite.map { "\(Format.money(option.priceUsd)) at checkout on \($0)" }
                ?? "\(Format.money(option.priceUsd)) at the garage's checkout"
            entry = option.entryType.flatMap { $0 == "unknown" ? nil : "\($0.capitalized) park" }
                .map { $0 == "Valet park" ? "Valet" : $0 }
            hours = Self.window(option)
            checkout = WalletCopy.garageCheckout(site: garageSite, linkPays: linkPays && option.priceUsd > 0)
        }
        if let minutes = option.walkMinutes {
            walk = destinationLabel.map { "\(minutes) min walk from \($0)" } ?? "\(minutes) min walk"
        } else {
            walk = nil
        }
    }

    /// "Meters 8 AM–6 PM today · 4 hr max", "No meters today".
    private static func meterHours(_ option: SingleSpotOption) -> String? {
        guard let hours = option.hoursToday else { return nil }
        let posted = hours.isEmpty
            ? "No meters today"
            : "Meters " + hours.map { "\(clock($0.start))–\(clock($0.end))" }.joined(separator: ", ") + " today"
        guard let max = option.maxStayMinutes else { return posted }
        let limit = max % 60 == 0 ? "\(max / 60) hr max" : "\(max) min max"
        return option.exceedsMaxStay == true
            ? "\(posted) · \(limit) — your stay runs past it"
            : "\(posted) · \(limit)"
    }

    /// The stay's window when the plan is for later; nil for "now".
    private static func window(_ option: SingleSpotOption) -> String? {
        guard let startsAt = option.startsAt, let start = Format.parseArrival(startsAt) else {
            return "For \(Format.minutes(option.durationMinutes)) from when you arrive"
        }
        let end = start.addingTimeInterval(TimeInterval(option.durationMinutes * 60))
        return "\(Format.clockTime(start))–\(Format.clockTime(end))"
    }

    /// "08:00" → "8 AM", "18:30" → "6:30 PM", "24:00" → "midnight".
    static func clock(_ hhmm: String) -> String {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return hhmm }
        let minutes = (parts[0] * 60 + parts[1]) % 1440
        if minutes == 0 { return "midnight" }
        if minutes == 720 { return "noon" }
        let h24 = minutes / 60
        let m = minutes % 60
        let h12 = h24 % 12 == 0 ? 12 : h24 % 12
        let suffix = h24 < 12 ? "AM" : "PM"
        return m == 0 ? "\(h12) \(suffix)" : String(format: "%d:%02d %@", h12, m, suffix)
    }
}

extension SingleSpotPlan.Destination {
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}
