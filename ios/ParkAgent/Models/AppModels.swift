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
    /// "issuing_card" | "link_wallet" — which source pays this session.
    var paymentSource: String = "issuing_card"

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

/// One row of history.
struct SessionRecord: Identifiable, Hashable {
    var id: String
    var zoneNumber: String
    var zoneLabel: String
    var startedAt: Date
    var endedAt: Date?
    var amountUsd: Double
    var status: StatusPill.Status
    /// Where the car sat, for the little map on the detail screen.
    var lat: Double?
    var lng: Double?
}
