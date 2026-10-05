import CoreLocation
import Foundation
import UserNotifications

/// A park detected while the app is in the background. The detector posts
/// /parked and the Parked sheet is waiting on the Park tab, but nothing
/// told the driver — they walked away from an unpaid meter unless they
/// happened to open the app. This local notification does (time-sensitive:
/// the meter is running), and tapping it lands on the waiting sheet.
///
/// Only when there is something to say: a park at an unmetered spot, in a
/// free period, or where there is nothing to pay stays silent, so parking
/// at home doesn't nag every time.
///
/// A park that isn't a street meter (FR-54) gets a prompt of its own: a
/// garage or a paid lot says what V1 can do about it (nothing: pay there),
/// and an unclear place asks what it is. Those wait until the car has been
/// still for a minute, and are made once a day per place; a park with a
/// quote is never held back or skipped.
///
/// A street park the server holds for the walk-away (FR-55) says nothing
/// here at all while the phone is at the car: no notification, no sheet.
/// When the phone has left, the server's own prompt is shown word for
/// word ("Pay $4.10 for zone 456?") with Pay · Not now · Wrong spot.
enum ParkedNotice {
    struct Content: Equatable {
        let title: String
        let body: String
    }

    // MARK: - Place prompts (FR-54)

    /// What the driver can say a place is (POST /parked/:id/place).
    enum PlaceAnswer: String, Sendable, CaseIterable {
        case street, garage, lot, nopay
        /// "I'm not parked here": a passenger, a drive-through.
        case notHere = "not_here"
    }

    /// A button on a place prompt. The raw value is the notification
    /// action's identifier: what a tap comes back as.
    enum Action: String, Sendable, CaseIterable {
        case notHere = "parked.place.not_here"
        case notAGarage = "parked.place.not_a_garage"
        case noPayment = "parked.place.nopay"
        case street = "parked.place.street"
        case garage = "parked.place.garage"
        case lot = "parked.place.lot"

        var title: String {
            switch self {
            case .notHere: "Not here"
            case .notAGarage: "Not a garage"
            case .noPayment: "No payment"
            case .street: "Street"
            case .garage: "Garage"
            case .lot: "Lot"
            }
        }

        /// What the tap records. "Not a garage" records nothing by itself:
        /// it opens the app to ask what the place is.
        var answer: PlaceAnswer? {
            switch self {
            case .notHere: .notHere
            case .notAGarage: nil
            case .noPayment: .nopay
            case .street: .street
            case .garage: .garage
            case .lot: .lot
            }
        }

        var opensApp: Bool { answer == nil }
    }

    /// Which buttons a notification carries (its UNNotificationCategory).
    enum Category: String, Sendable, CaseIterable {
        case garage = "parked.garage"
        case lot = "parked.lot"
        /// What is this place? Nothing metered is in reach.
        case ask = "parked.ask"
        /// The place is unclear but there is a street quote: tapping the
        /// notification is "street"; the buttons are the other answers.
        case askStreet = "parked.ask_street"

        var actions: [Action] {
            switch self {
            case .garage: [.notHere, .notAGarage]
            case .lot: [.notHere, .noPayment]
            case .ask: [.street, .garage, .lot, .noPayment]
            case .askStreet: [.garage, .lot, .noPayment]
            }
        }
    }

    /// One notification: what it says, its buttons, and how loudly.
    struct Prompt: Equatable {
        let content: Content
        let category: Category?
        /// Breaks through a Focus: a meter is running, or a garage or lot
        /// the driver may think ParkAgent is paying.
        let timeSensitive: Bool
        /// About the place, with nothing ParkAgent can pay: held back
        /// while the car was just moving, and made once a day per place.
        let isPlacePrompt: Bool
    }

    static let garageBody = "ParkAgent can't pay drive-up garages yet. Pay at the station or on the garage's own page."
    static let lotBody = "This lot charges, and ParkAgent can't pay lots yet. Pay at the pay station or by the lot's sign."
    static let askContent = Content(
        title: "Parked?",
        body: "Tell ParkAgent what this place is and it won't ask again."
    )

    /// "Looks like the Fixture Deck"; a name with its own article keeps it.
    static func garageContent(name: String?) -> Content {
        guard let name, !name.isEmpty else {
            return Content(title: "Parked in a garage?", body: "This looks like a garage. \(garageBody)")
        }
        let article = name.lowercased().hasPrefix("the ") ? "" : "the "
        return Content(title: "Looks like \(article)\(name)", body: garageBody)
    }

    static func lotContent(name: String?) -> Content {
        guard let name, !name.isEmpty else { return Content(title: "Parked in a paid lot", body: lotBody) }
        return Content(title: "Parked at \(name)", body: lotBody)
    }

    /// The place variant of a /parked answer: a garage, a lot, or the ask.
    /// nil for a street answer.
    static func placeContent(for response: ParkedResponse) -> Content? {
        switch response.action {
        case .garage:
            response.place?.placeClass == "lot"
                ? lotContent(name: response.place?.garageName)
                : garageContent(name: response.place?.garageName)
        case .unknownZone where response.rule == "place_unknown":
            askContent
        default:
            nil
        }
    }

    /// nil → nothing worth interrupting for.
    static func prompt(for response: ParkedResponse) -> Prompt? {
        switch response.action {
        case .nopay:
            return nil
        case .garage:
            guard let content = placeContent(for: response) else { return nil }
            let category: Category = response.place?.placeClass == "lot" ? .lot : .garage
            return Prompt(content: content, category: category, timeSensitive: true, isPlacePrompt: true)
        case .unknownZone:
            guard let content = placeContent(for: response) else { return nil }
            return Prompt(content: content, category: .ask, timeSensitive: false, isPlacePrompt: true)
        case .pay, .confirm, .ignore:
            // Held for the walk-away: the server's prompt says it then.
            if response.awaitsWalkAway == true { return nil }
            guard let content = streetContent(for: response) else { return nil }
            return Prompt(
                content: content,
                category: response.rule == "place_unknown" ? .askStreet : nil,
                timeSensitive: true, isPlacePrompt: false
            )
        }
    }

    /// nil → nothing worth interrupting for.
    static func content(for response: ParkedResponse) -> Content? {
        prompt(for: response)?.content
    }

    /// The street notice, as it has always read.
    private static func streetContent(for response: ParkedResponse) -> Content? {
        guard response.action == .pay || response.action == .confirm,
              let candidate = response.candidates.first
        else { return nil }
        let dryRun = response.dryRun ? " Dry run — nothing will be charged." : ""
        if response.needsZoneNumber {
            return Content(
                title: "Parked — zone number needed",
                body: "Open ParkAgent and type the zone number from the meter to pay.\(dryRun)"
            )
        }
        let quote = response.quote ?? candidate.quote
        let zone = "Parked in zone \(candidate.providerZoneNumber)"
        // Parks the sheet can't pay as-is: say what's in the way instead of
        // inviting a payment the server will refuse.
        if response.provider?.linked == false {
            let name = response.provider?.displayName ?? "your parking account"
            return Content(title: zone, body: "Connect \(name) in ParkAgent to pay here, or pay at the meter.\(dryRun)")
        }
        if response.rule == "session_cap_exceeded" || response.rule == "daily_cap_exceeded" {
            let limit = response.rule == "daily_cap_exceeded" ? "today's limit" : "your per-stop limit"
            return Content(
                title: zone,
                body: "\(Format.money(quote.totalUsd)) is over \(limit), so ParkAgent won't pay it. Pay at the meter or in your parking app.\(dryRun)"
            )
        }
        let choice = response.candidates.count > 1 ? " Pick the side of the street you're on." : ""
        return Content(
            title: "Parked in zone \(candidate.providerZoneNumber)",
            body: "Pay \(Format.money(quote.totalUsd)) for \(Format.minutes(quote.stayMinutes)) — open ParkAgent to confirm.\(choice)\(dryRun)"
        )
    }

    // MARK: - When to say it

    /// Why a park is passed over in silence.
    enum Silence: Equatable {
        /// A street answer with nothing to pay (no zone, a free period).
        case nothingToSay
        /// `nopay`: nothing to pay here, and the server saw nothing that
        /// would charge.
        case noPayment
        /// One of the driver's own saved places: already answered, twice.
        case savedPlace
        /// This place was already asked about today.
        case askedToday
        /// The driver said "not here" at this spot in the last two hours.
        case notHere
        /// A street park the server holds until the phone leaves the car
        /// (FR-55): nothing is said or shown before then.
        case awaitingWalkAway
    }

    enum Decision: Equatable {
        case post(Prompt)
        /// The car was moving within the last minute: say it once it has
        /// been still that long (and not at all if it drives on).
        case hold(Prompt, until: Date)
        case silent(Silence)
        /// A park with no fix at its spot, and an answer that is about the
        /// street where GPS last saw it: say only that the park couldn't
        /// be placed.
        case unlocated

        /// Whether the Parked sheet is put up for this park.
        var showsSheet: Bool {
            switch self {
            case .post, .hold: true
            // The sheet has always said "no zone here" / "free right now".
            case .silent(.nothingToSay): true
            case .silent, .unlocated: false
            }
        }
    }

    /// A place prompt waits until the car has been still this long.
    static let stillFor: TimeInterval = 60

    /// What to do about a /parked answer. `located` is false for a park
    /// reported from its entry fix (no GPS at the spot).
    static func decide(
        for response: ParkedResponse,
        located: Bool = true,
        at coordinate: CLLocationCoordinate2D?,
        memory: PlaceMemory,
        lastAutomotiveAt: Date?,
        now: Date,
        calendar: Calendar = .current
    ) -> Decision {
        if !located {
            // Only an answer about the place itself is about this car.
            let aboutThePlace = response.place != nil
                && (response.action == .garage || response.action == .nopay
                    || (response.action == .unknownZone && response.rule == "place_unknown"))
            guard aboutThePlace else { return .unlocated }
        }
        if response.awaitsWalkAway == true { return .silent(.awaitingWalkAway) }
        guard let prompt = prompt(for: response) else {
            return .silent(response.action == .nopay ? .noPayment : .nothingToSay)
        }
        // Something to pay: always, and at once.
        guard prompt.isPlacePrompt else { return .post(prompt) }
        if response.place?.isSavedPlace == true { return .silent(.savedPlace) }
        if let coordinate {
            if memory.isSuppressed(at: coordinate, now: now) { return .silent(.notHere) }
            if memory.promptedSameDay(at: coordinate, now: now, calendar: calendar) { return .silent(.askedToday) }
        }
        if let lastAutomotiveAt {
            let due = lastAutomotiveAt.addingTimeInterval(stillFor)
            if due > now { return .hold(prompt, until: due) }
        }
        return .post(prompt)
    }

    /// With no signal there is no /parked answer yet, and so no park on
    /// the server to answer about. What the phone's own classification
    /// can say in the meantime: a garage, or that the park couldn't be
    /// placed.
    static func offlinePrompt(for classification: PlaceClassification, preciseOff: Bool) -> Prompt {
        if !preciseOff, classification.placeClass == .garage {
            return Prompt(content: garageContent(name: nil), category: nil, timeSensitive: true, isPlacePrompt: true)
        }
        return Prompt(content: unlocatedContent(preciseOff: preciseOff), category: nil, timeSensitive: true, isPlacePrompt: false)
    }

    /// The categories iOS needs registered before any of them is posted.
    static var notificationCategories: Set<UNNotificationCategory> {
        let place = Category.allCases.map { category in
            UNNotificationCategory(
                identifier: category.rawValue,
                actions: category.actions.map { action in
                    UNNotificationAction(
                        identifier: action.rawValue, title: action.title,
                        options: action.opensApp ? [.foreground] : []
                    )
                },
                intentIdentifiers: []
            )
        }
        let walkAway = WalkAwayCategory.allCases.map { category in
            UNNotificationCategory(
                identifier: category.rawValue,
                actions: category.actions.map { action in
                    UNNotificationAction(identifier: action.rawValue, title: action.title, options: action.options)
                },
                intentIdentifiers: []
            )
        }
        return Set(place + walkAway)
    }

    // MARK: - The walk-away prompt (FR-55)

    /// A button on the walk-away prompt. The raw value is the notification
    /// action's identifier.
    enum WalkAwayAction: String, Sendable, CaseIterable {
        case pay = "park.pay"
        case notNow = "park.not_now"
        case wrongSpot = "park.wrong_spot"

        var title: String {
            switch self {
            case .pay: "Pay"
            case .notNow: "Not now"
            case .wrongSpot: "Wrong spot"
            }
        }

        var options: UNNotificationActionOptions {
            switch self {
            // Money moves on this tap: a locked phone asks for Face ID or
            // the passcode first, so a pocket or a bystander can't pay.
            case .pay: [.authenticationRequired]
            case .notNow: []
            // Fixing the spot takes the sheet.
            case .wrongSpot: [.foreground]
            }
        }
    }

    enum WalkAwayCategory: String, Sendable, CaseIterable {
        /// A tap pays the amount in the title.
        case confirm = "park.confirm"
        /// Nothing a tap can pay (which side? no linked account, a missing
        /// zone number, over a limit): the notification opens the app.
        case attention = "park.attention"

        var actions: [WalkAwayAction] {
            switch self {
            case .confirm: [.pay, .notNow, .wrongSpot]
            case .attention: [.notNow]
            }
        }
    }

    /// The notification a walk-away prompt becomes: the server's title and
    /// body as written, and Pay only when the prompt carries an amount a
    /// tap pays.
    struct WalkAwayNotice: Equatable {
        let content: Content
        let category: WalkAwayCategory
        /// What rides along for the buttons: which park, which side, and
        /// the total on screen (the server pays no more than it).
        let parkedEventId: String
        let zoneId: String?
        let zoneNumber: String?
        let shownTotalUsd: Double?
    }

    static func walkAwayNotice(for prompt: ParkPrompt) -> WalkAwayNotice {
        WalkAwayNotice(
            content: Content(title: prompt.title, body: prompt.body),
            category: prompt.payable ? .confirm : .attention,
            parkedEventId: prompt.parkedEventId,
            zoneId: prompt.payable ? prompt.zoneId : nil,
            zoneNumber: prompt.zoneNumber,
            shownTotalUsd: prompt.payable ? prompt.amountUsd : nil
        )
    }

    /// Time-sensitive, under the same identifier as every parked
    /// notification: a newer prompt (a changed price) replaces the old.
    @MainActor
    static func post(_ notice: WalkAwayNotice) async {
        let notification = UNMutableNotificationContent()
        notification.title = notice.content.title
        notification.body = notice.content.body
        notification.sound = .default
        notification.interruptionLevel = .timeSensitive
        notification.categoryIdentifier = notice.category.rawValue
        var userInfo: [String: Any] = ["type": type, "parkedEventId": notice.parkedEventId]
        if let zoneId = notice.zoneId { userInfo["zoneId"] = zoneId }
        if let zoneNumber = notice.zoneNumber { userInfo["zoneNumber"] = zoneNumber }
        if let shown = notice.shownTotalUsd { userInfo["shownTotalUsd"] = shown }
        notification.userInfo = userInfo
        held = nil
        let request = UNNotificationRequest(identifier: type, content: notification, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// Pay from the notification didn't go through: say so, since the
    /// prompt it was tapped on is gone.
    static func payFailedContent(zoneNumber: String?, message: String) -> Content {
        Content(
            title: zoneNumber.map { "Zone \($0) wasn't paid" } ?? "The meter wasn't paid",
            body: "\(message) Open ParkAgent to see where it stands."
        )
    }

    @MainActor
    static func postPayFailed(_ content: Content, parkedEventId: String) async {
        let notification = UNMutableNotificationContent()
        notification.title = content.title
        notification.body = content.body
        notification.sound = .default
        notification.interruptionLevel = .timeSensitive
        notification.userInfo = ["type": type, "parkedEventId": parkedEventId]
        let request = UNNotificationRequest(identifier: type, content: notification, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// Pay was tapped at the car and the hour the server keeps a park ran
    /// out with the phone still there: nothing was paid, and the driver
    /// was counting on it.
    static func expiredContent(zoneNumber: String?) -> Content {
        Content(
            title: zoneNumber.map { "Zone \($0) wasn't paid" } ?? "The meter wasn't paid",
            body: "You tapped Pay, but ParkAgent pays when you walk away from the car, and an hour passed first. If you're still parked, pay in the app."
        )
    }

    /// The session ended because the phone came back to the car. Said
    /// quietly (no sound, not time-sensitive: the driver is at the car),
    /// so that someone who only came back for a bag knows the meter is no
    /// longer being looked after before walking away again.
    static let sessionEndedType = "session_ended_at_return"

    static func sessionEndedContent(zoneNumber: String, stopped: Bool, paidUntil: Date) -> Content {
        let zone = zoneNumber.isEmpty ? "the meter" : "zone \(zoneNumber)"
        return stopped
            ? Content(
                title: "Parking session ended",
                body: "You're back at your car, so ParkAgent stopped \(zone). If you're staying parked, pay again in the app."
            )
            : Content(
                title: "Parking session ended",
                body: "You're back at your car. \(zone.prefix(1).uppercased() + zone.dropFirst()) stays paid until \(Format.clockTime(paidUntil)), and ParkAgent won't add more time."
            )
    }

    @MainActor
    static func postSessionEnded(_ content: Content) async {
        let notification = UNMutableNotificationContent()
        notification.title = content.title
        notification.body = content.body
        notification.interruptionLevel = .passive
        notification.userInfo = ["type": sessionEndedType]
        let request = UNNotificationRequest(identifier: sessionEndedType, content: notification, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    // MARK: - A park waiting for its walk-away

    /// The park the server is holding, where the car is, and the prompt
    /// already shown for it. On disk: iOS ends a backgrounded app between
    /// the park and the walk-away all the time, and a relaunch must pick
    /// the reporting back up (and not show the same prompt twice).
    struct Waiting: Codable {
        var response: ParkedResponse
        var latitude: Double
        var longitude: Double
        var savedAt: Date
        var shown: ParkPrompt?
        /// Pay was tapped at the car: kept, and paid at walk-away.
        var confirmed = false

        var coordinate: CLLocationCoordinate2D {
            CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        }

        /// The /parked answer with the prompt's own quote for its side:
        /// what the sheet shows is what the tap pays.
        var presentable: ParkedResponse {
            guard let quote = shown?.quote else { return response }
            var copy = response
            copy.candidates = copy.candidates.map { candidate in
                guard candidate.zoneId == quote.zoneId else { return candidate }
                var updated = candidate
                updated.quote = quote
                updated.providerZoneNumber = quote.providerZoneNumber
                return updated
            }
            if copy.quote?.zoneId == quote.zoneId { copy.quote = quote }
            return copy
        }
    }

    private static let waitingKey = "waitingPark"
    /// The server stops asking about a park after an hour.
    static let waitingFor: TimeInterval = 60 * 60

    static func storeWaiting(_ waiting: Waiting?) {
        let defaults = UserDefaults.standard
        guard let waiting, let data = try? JSONEncoder().encode(waiting) else {
            defaults.removeObject(forKey: waitingKey)
            return
        }
        defaults.set(data, forKey: waitingKey)
    }

    static func restoreWaiting(now: Date = AppClock.now) -> Waiting? {
        let defaults = UserDefaults.standard
        guard let data = defaults.data(forKey: waitingKey),
              let waiting = try? JSONDecoder().decode(Waiting.self, from: data)
        else { return nil }
        guard now.timeIntervalSince(waiting.savedAt) < waitingFor else {
            defaults.removeObject(forKey: waitingKey)
            return nil
        }
        return waiting
    }

    /// The push/notification `type` a tap routes on (PushManager → Park tab).
    static let type = "parked"

    /// Paid, dismissed, or signed out: the notification is stale, whether
    /// it was delivered or is still waiting for the car to be still.
    @MainActor
    static func withdraw() {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [type])
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [type])
        held = nil
    }

    // MARK: - A prompt being held

    /// A place prompt scheduled for when the car has been still a minute.
    struct Held: Equatable {
        var parkedEventId: String?
        var latitude: Double
        var longitude: Double
        var notedAt: Date
        var due: Date
    }

    @MainActor private(set) static var held: Held?

    /// The car drove on before a held prompt was due: it was a pause, not
    /// a park. Takes the prompt back and says which one, so its sheet and
    /// its "asked today" note can go too. nil when nothing was waiting.
    @MainActor
    static func cancelHeld(now: Date = Date()) -> Held? {
        guard let waiting = held else { return nil }
        held = nil
        guard waiting.due > now else { return nil }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [type])
        return waiting
    }

    // MARK: - Surviving the process

    /// The pending park, kept on disk for a while: iOS may end a
    /// backgrounded app after the notification is posted, and a tap must
    /// still land on the sheet it promised.
    private static let storeKey = "pendingParked"
    static let freshFor: TimeInterval = 30 * 60

    private struct Stored: Codable {
        let savedAt: Date
        let response: ParkedResponse
    }

    static func store(_ response: ParkedResponse?) {
        let defaults = UserDefaults.standard
        guard let response else {
            defaults.removeObject(forKey: storeKey)
            return
        }
        // The same park again (restored at launch): keep its original time,
        // or every relaunch would make a stale park fresh.
        if let data = defaults.data(forKey: storeKey),
           let stored = try? JSONDecoder().decode(Stored.self, from: data),
           stored.response.parkedEventId == response.parkedEventId {
            return
        }
        guard let data = try? JSONEncoder().encode(Stored(savedAt: AppClock.now, response: response)) else { return }
        defaults.set(data, forKey: storeKey)
    }

    /// The stored park if it's still fresh; a stale one is dropped.
    static func restore() -> ParkedResponse? {
        let defaults = UserDefaults.standard
        guard let data = defaults.data(forKey: storeKey),
              let stored = try? JSONDecoder().decode(Stored.self, from: data)
        else { return nil }
        guard AppClock.now.timeIntervalSince(stored.savedAt) < freshFor else {
            defaults.removeObject(forKey: storeKey)
            return nil
        }
        return stored.response
    }

    /// Enough evidence of a park, but no fix precise enough to say which
    /// block (Precise Location off, or no GPS under cover). Nothing was
    /// reported, so nothing can be paid; say why instead of staying silent.
    static let unlocatedType = "parked_unlocated"

    static func unlocatedContent(preciseOff: Bool) -> Content {
        preciseOff
            ? Content(
                title: "Parked? ParkAgent couldn't tell where",
                body: "Precise Location is off, so iOS blurs your location by a few kilometers. Turn it on in Settings → ParkAgent → Location, or pay at the meter."
            )
            : Content(
                title: "Parked? ParkAgent couldn't tell where",
                body: "There was no GPS fix good enough to pick the block. Pay at the meter or in your parking app this time."
            )
    }

    static func postUnlocated(preciseOff: Bool) async {
        let content = unlocatedContent(preciseOff: preciseOff)
        let notification = UNMutableNotificationContent()
        notification.title = content.title
        notification.body = content.body
        notification.sound = .default
        notification.interruptionLevel = .timeSensitive
        notification.userInfo = ["type": unlocatedType]
        let request = UNNotificationRequest(identifier: unlocatedType, content: notification, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    /// Post a prompt now, or at `due`. The park's id and spot ride in the
    /// notification, so a button tapped after iOS ended the app still
    /// knows which park, and where, it is answering about.
    @MainActor
    static func post(_ prompt: Prompt, parkedEventId: String?, at coordinate: CLLocationCoordinate2D?, due: Date?, now: Date = Date()) async {
        let notification = UNMutableNotificationContent()
        notification.title = prompt.content.title
        notification.body = prompt.content.body
        notification.sound = prompt.timeSensitive ? .default : nil
        notification.interruptionLevel = prompt.timeSensitive ? .timeSensitive : .passive
        var userInfo: [String: Any] = ["type": type]
        if let parkedEventId { userInfo["parkedEventId"] = parkedEventId }
        if let coordinate {
            userInfo["lat"] = coordinate.latitude
            userInfo["lng"] = coordinate.longitude
        }
        notification.userInfo = userInfo
        if let category = prompt.category, parkedEventId != nil {
            notification.categoryIdentifier = category.rawValue
        }
        var trigger: UNNotificationTrigger?
        if let due, due > now {
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, due.timeIntervalSince(now)), repeats: false)
            if let coordinate {
                held = Held(
                    parkedEventId: parkedEventId, latitude: coordinate.latitude, longitude: coordinate.longitude,
                    notedAt: now, due: due
                )
            }
        } else {
            held = nil
        }
        // One identifier: a newer park replaces an older, unanswered one.
        let request = UNNotificationRequest(identifier: type, content: notification, trigger: trigger)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
