import Foundation

// Local UI state, distinct from the wire types in APIModels.swift.

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
