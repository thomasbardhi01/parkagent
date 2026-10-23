import Foundation

// The parking-sign reader (Issue N; server/API.md "POST /parked/:id/signs").
// Advisory only: a check can warn, or offer a shorter max stay the driver
// may accept for this park. Nothing here prices, pays, or extends.

/// What the phone sends: the text it recognized on the signs (always), one
/// photo only when that recognition was unsure, and where the phone is.
struct SignCheckRequest: Encodable, Sendable, Equatable {
    var text: String
    var fix: SignFix?
    var photo: SignPhoto?
    /// Keep the photo 30 days for the zone-data review queue. Off unless
    /// the driver turns it on, and meaningless without a photo.
    var storePhoto: Bool?
}

struct SignFix: Codable, Sendable, Equatable {
    var lat: Double
    var lng: Double
    var accuracy: Double
}

struct SignPhoto: Codable, Sendable, Equatable {
    var mediaType: String
    /// Base64 of the downscaled JPEG.
    var data: String
}

enum SignVerdict: String, Codable, Sendable, Equatable {
    case agrees, stricter, conflicts, unreadable

    /// A verdict this build doesn't know reads as unreadable: it claims
    /// nothing and offers nothing.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SignVerdict(rawValue: raw) ?? .unreadable
    }
}

/// One restriction the signs show, as the server grounded it.
struct SignRule: Codable, Sendable, Equatable, Hashable {
    var kind: String
    var days: [String]
    var start: String?
    var end: String?
    var limitMinutes: Int?
    var permitZone: String?
    var exceptions: [String]
}

struct SignOffer: Codable, Sendable, Equatable {
    var maxStayMinutes: Int
}

struct SignZone: Codable, Sendable, Equatable {
    var zoneId: String
    var maxStayMinutes: Int?
}

struct SignCheckResponse: Codable, Sendable, Equatable {
    var checkId: String
    var verdict: SignVerdict
    var rules: [SignRule]
    var confidence: Double
    var reasons: [String]
    var offer: SignOffer?
    var zone: SignZone?
    var photoKept: Bool
    var advisory: Bool
    var decisionId: String
}

struct SignAcceptResponse: Codable, Sendable, Equatable {
    var accepted: Bool
    /// The stay accepted from the signs.
    var maxStayMinutes: Int
    var sessionId: String?
    /// What a running session is held to: never below what it has already
    /// bought, so it can be longer than the stay accepted. Nil with no
    /// running session, and from a server that doesn't say.
    var sessionMaxStayMinutes: Int? = nil
    /// What that session has bought, in all, since it started.
    var paidMinutes: Int? = nil
    /// The stay that binds the park: the shortest accepted, this check's
    /// or an earlier one's. Nil from a server that doesn't say.
    var acceptedMinutes: Int? = nil
    /// A session that will take the stay but hasn't yet (its start is
    /// still at the provider). Nil from a server that doesn't say.
    var holdPending: Bool? = nil
}
