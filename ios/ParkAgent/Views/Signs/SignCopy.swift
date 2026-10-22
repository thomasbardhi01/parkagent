import Foundation

/// Every sentence the parking-sign reader says (Issue N), in one place so
/// the sheet, its tests and the parked sheet's button never disagree. The
/// reader is advisory: no sentence here may say ParkAgent paid, extended,
/// or changed a price because of the signs.
enum SignCopy {
    static let checkButton = "Check the signs"
    static let title = "Check the signs"
    static let intro = "Take a photo of each sign at your spot, up to three. ParkAgent reads them on your phone and compares them with what it knows about this block."
    /// The same sentence as the camera permission (project.yml
    /// NSCameraUsageDescription): what leaves the phone, and when.
    static let privacy = "If a reading is unclear, one photo is sent with the text; it is kept only if you choose."
    static let takePhoto = "Take a photo"
    static let choosePhoto = "Choose a photo"
    static let cameraOff = "Camera access is off. Choose a photo you've taken instead, or turn the camera on in Settings."
    static let read = "Read the signs"
    static let reading = "Reading the signs…"
    static let keepPhoto = "If a photo is sent, let ParkAgent keep it for 30 days to fix its map"
    static let advisory = "This is a reading of the signs, not a guarantee. The posted signs are what count."
    static let startOver = "Check again"
    static let done = "Done"

    static func headline(_ verdict: SignVerdict) -> String {
        switch verdict {
        case .agrees: "The signs match what ParkAgent has here."
        case .stricter: "The signs are stricter than ParkAgent's data."
        case .conflicts: "The signs disagree with ParkAgent's data."
        case .unreadable: "ParkAgent couldn't read these signs."
        }
    }

    static func detail(_ check: SignCheckResponse) -> String {
        switch check.verdict {
        case .agrees:
            "Nothing changes."
        case .stricter:
            if let minutes = check.offer?.maxStayMinutes {
                "They allow \(Format.minutes(minutes)) for this park. ParkAgent can hold this park to that, so it never buys time past it."
            } else {
                "Go by the posted signs."
            }
        case .conflicts:
            "Which is right? Go by the posted signs, and move the car if they say you can't stay."
        case .unreadable:
            "Try a closer, straight-on photo of each sign, in good light."
        }
    }

    /// ParkAgent's side, shown next to what the signs say.
    static func ourSide(_ zone: SignZone) -> String {
        if let max = zone.maxStayMinutes { return "ParkAgent's data for this block: \(Format.minutes(max)) max." }
        return "ParkAgent's data for this block: no time limit."
    }

    static func accept(_ minutes: Int) -> String { "Hold this park to \(Format.minutes(minutes))" }
    static func accepted(_ minutes: Int) -> String {
        "Done. ParkAgent won't keep this park past \(Format.minutes(minutes))."
    }

    /// The accept's answer in words: the stay accepted, or, when the
    /// running session already has more time than that on the meter, that
    /// time and that no more is added (the server never cuts below it).
    static func accepted(_ answer: SignAcceptResponse) -> String {
        if let held = answer.sessionMaxStayMinutes, held > answer.maxStayMinutes {
            let onMeter = answer.paidMinutes ?? held
            return "Done. This park already has \(Format.minutes(onMeter)) on the meter, so ParkAgent won't add any more."
        }
        return accepted(answer.maxStayMinutes)
    }

    /// What a reason code means, in words; nil for one this build doesn't know.
    static func reason(_ code: String) -> String? {
        switch code {
        case "no_parking": "No parking now"
        case "no_stopping": "No stopping now"
        case "tow_zone": "Tow zone now"
        case "street_cleaning": "Street cleaning now"
        case "permit_only": "Permit holders only now"
        case "no_parking_later": "No parking starts during your stay"
        case "no_stopping_later": "No stopping starts during your stay"
        case "tow_zone_later": "A tow zone starts during your stay"
        case "street_cleaning_later": "Street cleaning starts during your stay"
        case "permit_only_later": "Permit-only parking starts during your stay"
        case "time_limit_shorter": "A shorter time limit is posted"
        case "time_limit_longer": "A longer limit is posted; ParkAgent keeps the shorter one"
        case "meter_where_free": "A meter is posted where ParkAgent has free parking"
        default: nil
        }
    }

    /// One rule as a short line: "2 hr limit · Mon–Sat 08:00–20:00".
    static func rule(_ rule: SignRule) -> String {
        let what: String = switch rule.kind {
        case "time_limit": rule.limitMinutes.map { "\(Format.minutes($0)) limit" } ?? "Time limit"
        case "meter": rule.limitMinutes.map { "Meter, \(Format.minutes($0)) max" } ?? "Meter"
        case "no_parking": "No parking"
        case "no_stopping": "No stopping"
        case "street_cleaning": "Street cleaning"
        case "permit_only": rule.permitZone.map { "Permit only (\($0))" } ?? "Permit only"
        case "tow_zone": "Tow zone"
        default: "Restriction"
        }
        var parts = [what]
        if !rule.days.isEmpty { parts.append(days(rule.days)) }
        if let start = rule.start, let end = rule.end { parts.append("\(start)–\(end)") }
        return parts.joined(separator: " · ")
    }

    private static let order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    /// "Mon–Sat" for a run of days, else "Mon, Wed, Fri".
    static func days(_ days: [String]) -> String {
        let indices = days.compactMap { order.firstIndex(of: $0.lowercased()) }.sorted()
        let name = { (i: Int) in order[i].prefix(1).uppercased() + order[i].dropFirst() }
        guard let first = indices.first, let last = indices.last else { return "" }
        if indices.count > 2, indices == Array(first...last) { return "\(name(first))–\(name(last))" }
        return indices.map(name).joined(separator: ", ")
    }
}
