import CoreLocation
import Foundation

// Local UI state, distinct from the wire types in APIModels.swift.

/// A request to run the provider link flow outside onboarding — from the
/// parked sheet, Settings re-link, or the provider_relink push.
struct ProviderLinkPrompt: Identifiable {
    var providerId: String
    var id: String { providerId }
}

/// The app's names for city keys (zone-id prefixes). Mirrors the server
/// registry's cityDisplayName for offline use (chips, pickers).
enum CityCatalog {
    static let all = ["nyc", "bos"]

    /// Picker/list order: alphabetical by display name — no home-city bias.
    static var allByDisplayName: [String] {
        all.sorted { (displayName($0) ?? $0) < (displayName($1) ?? $1) }
    }

    /// "Boston and New York City" — for coverage copy, derived from the
    /// catalog so no screen hardcodes a city list.
    static var supportedCitiesSentence: String {
        let names = allByDisplayName.compactMap { displayName($0) }
        switch names.count {
        case 0: return "supported cities"
        case 1: return names[0]
        default: return names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
        }
    }

    static func displayName(_ city: String?) -> String? {
        switch city {
        case "nyc": "New York City"
        case "bos": "Boston"
        default: nil
        }
    }

    /// Which provider runs the city's meters (mirrors the server registry),
    /// so onboarding can resume its link step after a relaunch.
    static func providerId(for city: String?) -> String? {
        switch city {
        case "nyc": "parknyc"
        case "bos": "passport"
        default: nil
        }
    }

    /// The provider's user-facing name ("My card on ParkBoston").
    static func providerDisplayName(for city: String?) -> String? {
        switch city {
        case "nyc": "ParkNYC"
        case "bos": "ParkBoston"
        default: nil
        }
    }

    /// Where to point a map when all we know is the city. Only used as a
    /// fallback — the map prefers the user's actual location.
    static func center(of city: String?) -> CLLocationCoordinate2D? {
        switch city {
        case "nyc": CLLocationCoordinate2D(latitude: 40.7549, longitude: -73.9840)
        case "bos": CLLocationCoordinate2D(latitude: 42.3555, longitude: -71.0655)
        default: nil
        }
    }

    /// The assistant's empty-state starters: real streets and landmarks in
    /// the user's own city show what it understands better than a generic
    /// example — and a user is never offered another city's landmark. No
    /// city NAMES in the copy (the catalog's display names are the one
    /// source of those); an unknown city gets phrasing that names no place.
    static func assistantStarters(for city: String?) -> [String] {
        switch city {
        case "bos":
            [
                "Park me near the MFA for two hours",
                "Garage near Fenway at 7 Saturday",
                "Cheapest spot on Newbury Street",
                "Plan my day of stops",
            ]
        case "nyc":
            [
                "Park me near the Met for two hours",
                "Garage near Lincoln Center at 7",
                "Cheapest spot in SoHo",
                "Plan my day of stops",
            ]
        default:
            [
                "Find me a spot near here",
                "Cheapest parking for two hours",
                "Plan my day of stops",
            ]
        }
    }

    /// Last-resort map center when the city is unknown too. Boston, because
    /// that is where the prototype is driven — not a claim about coverage.
    static let fallbackCenter = CLLocationCoordinate2D(latitude: 42.3555, longitude: -71.0655)
}

/// The session the user is currently paying for.
struct ActiveSession: Identifiable {
    var sessionId: String
    var zoneNumber: String
    var zoneLabel: String
    var startedAt: Date
    var expiresAt: Date
    var amountUsd: Double
    var extendCount: Int
    var maxExtendCount: Int
    var maxStayReached: Bool
    var autoExtend: Bool
    /// Which card pays this street session: the card on the provider
    /// account or the ParkAgent card (Link never pays a street meter).
    var paymentSource: PaymentSource = .providerCard

    var id: String { sessionId }

    var canExtend: Bool { !maxStayReached && extendCount < maxExtendCount }

    /// Gold "expiring" treatment inside the last 10 minutes.
    static let expiringThreshold: TimeInterval = 10 * 60

    func remaining(at date: Date) -> TimeInterval {
        expiresAt.timeIntervalSince(date)
    }

    func isExpiring(at date: Date) -> Bool {
        let remaining = remaining(at: date)
        return remaining > 0 && remaining < Self.expiringThreshold
    }
}

/// The three tabs.
enum AppTab: Hashable {
    case park
    case activity
    case wallet
}
