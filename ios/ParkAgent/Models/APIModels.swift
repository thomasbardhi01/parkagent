import Foundation

// Wire types mirroring server/API.md. Field names match the JSON exactly;
// the policy document is snake_case on the wire, so those types carry
// explicit CodingKeys.

struct ParkedRequest: Codable, Sendable {
    var lat: Double
    var lng: Double
    var accuracy: Double
    var ts: Date
    var signals: [String]
}

enum ParkedAction: String, Codable, Sendable {
    case pay
    case confirm
    case ignore
    case unknownZone = "unknown_zone"
}

struct ParkedResponse: Codable, Sendable, Identifiable {
    var action: ParkedAction
    var candidates: [Candidate]
    var quote: Quote?
    var rule: String
    var dryRun: Bool
    var parkedEventId: String
    var decisionId: String

    var id: String { parkedEventId }
}

struct Candidate: Codable, Sendable, Identifiable, Equatable {
    var zoneId: String
    var parknycZoneNumber: String
    var distanceM: Double
    var containsPoint: Bool
    var rateFirstHourUsd: Double
    var rateAdditionalHourUsd: Double
    var maxStayMinutes: Int
    var hours: [EnforcementHours]
    var quote: Quote

    var id: String { zoneId }
}

struct EnforcementHours: Codable, Sendable, Equatable {
    var days: [String]
    var start: String
    var end: String
}

struct Quote: Codable, Sendable, Equatable {
    var zoneId: String
    var parknycZoneNumber: String
    var stayMinutes: Int
    var chargedMinutes: Int
    var meterUsd: Double
    var feeUsd: Double
    var totalUsd: Double
}

struct Policy: Codable, Sendable {
    var dryRun: Bool
    var sessionCapUsd: Double
    var dailyCapUsd: Double
    var autoPayMaxRatePerHour: Double
    var defaultStayMinutes: Int
    var parknycFeeUsd: Double
    var autoExtend: AutoExtendPolicy
    var respectEnforcementHours: Bool
    var ticketCostUsd: Double

    enum CodingKeys: String, CodingKey {
        case dryRun = "dry_run"
        case sessionCapUsd = "session_cap_usd"
        case dailyCapUsd = "daily_cap_usd"
        case autoPayMaxRatePerHour = "auto_pay_max_rate_per_hour"
        case defaultStayMinutes = "default_stay_minutes"
        case parknycFeeUsd = "parknyc_fee_usd"
        case autoExtend = "auto_extend"
        case respectEnforcementHours = "respect_enforcement_hours"
        case ticketCostUsd = "ticket_cost_usd"
    }
}

struct AutoExtendPolicy: Codable, Sendable {
    var enabled: Bool
    var maxCount: Int
    var maxMinutesEach: Int
    var noExtendWithinMinutesOfMaxStay: Int

    enum CodingKeys: String, CodingKey {
        case enabled
        case maxCount = "max_count"
        case maxMinutesEach = "max_minutes_each"
        case noExtendWithinMinutesOfMaxStay = "no_extend_within_minutes_of_max_stay"
    }
}

struct PolicyResponse: Codable, Sendable {
    var policy: Policy
    var hash: String
    var dryRun: Bool
}

// Session endpoints are 501 stubs server-side until Phase 5; these are the
// planned shapes from API.md so the app can code against them now.

struct SessionStartRequest: Codable, Sendable {
    var parkedEventId: String
    var zoneId: String
    var minutes: Int
}

struct SessionStartResponse: Codable, Sendable {
    var sessionId: String
    var expiresAt: Date
    var amountUsd: Double
}

struct SessionStopResponse: Codable, Sendable {
    var sessionId: String
    var stoppedAt: Date
}

struct SessionExtendResponse: Codable, Sendable {
    var sessionId: String
    var expiresAt: Date
    var amountUsd: Double
}

struct LocationReport: Codable, Sendable {
    var lat: Double
    var lng: Double
    var accuracy: Double
    var ts: Date
}

struct DeviceRegistration: Codable, Sendable {
    var token: String
    var platform: String
    var environment: String
}
