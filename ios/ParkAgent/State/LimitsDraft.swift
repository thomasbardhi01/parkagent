import Foundation

/// The limits being edited on the budget step or Account → Spending
/// limits: seeded from GET /me/limits, stepped within the ceilings and
/// bounds the server sent, saved through PUT /me/limits. One type for both
/// screens so they step, bound, and word things the same way.
struct LimitsDraft: Equatable {
    enum Field { case sessionCap, dailyCap, defaultStay }

    var sessionCapUsd: Double
    var dailyCapUsd: Double
    var defaultStayMinutes: Int
    let ceilings: UserLimitsResponse.LimitCeilings
    let stay: UserLimitsResponse.LimitBounds.StayBounds

    /// The steppers move in these units.
    static let capStepUsd: Double = 5
    static let stayStepMinutes = 15

    init(_ response: UserLimitsResponse) {
        sessionCapUsd = response.limits.sessionCapUsd
        dailyCapUsd = response.limits.dailyCapUsd
        defaultStayMinutes = response.limits.defaultStayMinutes
        ceilings = response.ceilings
        stay = response.bounds.stayMinutes
    }

    var limits: SpendingLimits {
        SpendingLimits(sessionCapUsd: sessionCapUsd, dailyCapUsd: dailyCapUsd, defaultStayMinutes: defaultStayMinutes)
    }

    /// Whether the stepper can move that way (at a bound it can't).
    func canStep(_ field: Field, up: Bool) -> Bool {
        switch field {
        case .sessionCap: up ? sessionCapUsd < ceilings.sessionCapUsd : sessionCapUsd > Self.capStepUsd
        case .dailyCap: up ? dailyCapUsd < ceilings.dailyCapUsd : dailyCapUsd > Self.capStepUsd
        case .defaultStay: up ? defaultStayMinutes < stay.max : defaultStayMinutes > stay.min
        }
    }

    /// One step, never past a ceiling or below the smallest step.
    mutating func step(_ field: Field, up: Bool) {
        let cap = { (value: Double, ceiling: Double) -> Double in
            up ? min(ceiling, value + Self.capStepUsd) : max(Self.capStepUsd, value - Self.capStepUsd)
        }
        switch field {
        case .sessionCap: sessionCapUsd = cap(sessionCapUsd, ceilings.sessionCapUsd)
        case .dailyCap: dailyCapUsd = cap(dailyCapUsd, ceilings.dailyCapUsd)
        case .defaultStay:
            defaultStayMinutes = up
                ? min(stay.max, defaultStayMinutes + Self.stayStepMinutes)
                : max(stay.min, defaultStayMinutes - Self.stayStepMinutes)
        }
    }
}

/// Every sentence about limits, so the two screens never disagree.
enum LimitsCopy {
    static func preview(_ draft: LimitsDraft) -> String {
        "We'll pay up to \(Format.money(draft.sessionCapUsd)) per stop and \(Format.money(draft.dailyCapUsd)) per day without asking."
    }

    static func ceilings(_ draft: LimitsDraft) -> String {
        "ParkAgent pays at most \(Format.money(draft.ceilings.sessionCapUsd)) per stop and \(Format.money(draft.ceilings.dailyCapUsd)) per day right now; yours can be lower."
    }

    static let loadFailed = "Couldn't load your limits."

    /// Why a save didn't happen, in words a person can act on. A refused
    /// value is the server's own sentence, as is.
    static func saveFailure(_ error: Error) -> String {
        if let rejected = error as? LimitsRejected {
            return rejected.errorDescription ?? "Those limits weren't saved."
        }
        switch error as? APIError {
        case .transport:
            return "Couldn't reach the server, so your limits weren't changed. Check the connection and try again."
        case .server(let status):
            return "The server couldn't save your limits (error \(status)). Try again in a minute."
        case .unauthorized:
            return "You're signed out. Sign in again to change your limits."
        case .some(let other):
            return other.errorDescription ?? "Your limits weren't saved. Try again."
        case .none:
            return "Your limits weren't saved. Try again."
        }
    }
}
