import Foundation

enum Format {
    static func money(_ amount: Double) -> String {
        amount.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    static func minutes(_ minutes: Int) -> String {
        let hours = minutes / 60
        let remainder = minutes % 60
        if hours == 0 { return "\(remainder) min" }
        if remainder == 0 { return "\(hours) hr" }
        return "\(hours) hr \(remainder) min"
    }

    static func countdown(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        return String(format: "%d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
    }

    static func clockTime(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    static func dayAndTime(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) {
            return "Today, \(clockTime(date))"
        }
        if Calendar.current.isDateInYesterday(date) {
            return "Yesterday, \(clockTime(date))"
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    /// Section headers for day-grouped lists.
    static func dayHeader(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    static func distanceMeters(_ meters: Double) -> String {
        meters < 1000 ? "\(Int(meters.rounded())) m" : String(format: "%.1f km", meters / 1000)
    }
}

extension Format {
    private static let arrivalPlain = Date.ISO8601FormatStyle()
    private static let arrivalFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    /// Itinerary stops carry ISO arrival strings; render as clock time.
    /// nil is a stop the user cleared the time on.
    static func arrivalTime(_ iso: String?) -> String {
        guard let iso else { return "Any time" }
        guard let date = parseArrival(iso) else { return iso }
        return clockTime(date)
    }

    /// Noon on an itinerary's day ("2026-01-05", or a full ISO date whose
    /// first ten characters are the day) — where a time lands when the user
    /// sets one on a stop that had none.
    static func noon(onPlanDay day: String) -> Date? {
        let parts = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(
            year: parts[0], month: parts[1], day: parts[2], hour: 12
        ))
    }

    static func parseArrival(_ iso: String) -> Date? {
        (try? arrivalFractional.parse(iso)) ?? (try? arrivalPlain.parse(iso))
    }

    static func arrivalISO(_ date: Date) -> String {
        date.formatted(arrivalPlain)
    }
}
