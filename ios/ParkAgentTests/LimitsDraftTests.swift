import XCTest
@testable import ParkAgent

/// The limits both screens edit: stepped within the server's ceilings and
/// bounds, and a failed save said the way a person can act on it — a
/// refused value in the server's own words, never "Couldn't save to the
/// server" for everything.
final class LimitsDraftTests: XCTestCase {
    private func response(session: Double = 45, daily: Double = 60, stay: Int = 90) -> UserLimitsResponse {
        UserLimitsResponse(
            limits: SpendingLimits(sessionCapUsd: session, dailyCapUsd: daily, defaultStayMinutes: stay),
            saved: .init(sessionCapUsd: nil, dailyCapUsd: nil, defaultStayMinutes: nil),
            defaults: SpendingLimits(sessionCapUsd: 45, dailyCapUsd: 60, defaultStayMinutes: 90),
            ceilings: .init(sessionCapUsd: 45, dailyCapUsd: 60),
            bounds: .init(minCapUsd: 1, stayMinutes: .init(min: 15, max: 240)),
            clamped: []
        )
    }

    func testCapsStopAtTheCeilings() {
        var draft = LimitsDraft(response(session: 40, daily: 58))
        XCTAssertTrue(draft.canStep(.sessionCap, up: true))
        draft.step(.sessionCap, up: true)
        XCTAssertEqual(draft.sessionCapUsd, 45)
        XCTAssertFalse(draft.canStep(.sessionCap, up: true), "No stepping past what ParkAgent may pay")
        draft.step(.sessionCap, up: true)
        XCTAssertEqual(draft.sessionCapUsd, 45)

        draft.step(.dailyCap, up: true) // 58 → 60, not 63
        XCTAssertEqual(draft.dailyCapUsd, 60)
    }

    func testCapsAndStayStopAtTheirFloors() {
        var draft = LimitsDraft(response(session: 5, daily: 10, stay: 15))
        XCTAssertFalse(draft.canStep(.sessionCap, up: false))
        draft.step(.sessionCap, up: false)
        XCTAssertEqual(draft.sessionCapUsd, 5)
        XCTAssertFalse(draft.canStep(.defaultStay, up: false))
        draft.step(.defaultStay, up: false)
        XCTAssertEqual(draft.defaultStayMinutes, 15)
        draft.step(.defaultStay, up: true)
        XCTAssertEqual(draft.defaultStayMinutes, 30)
    }

    func testStayStopsAtTheBoundsMax() {
        var draft = LimitsDraft(response(stay: 240))
        XCTAssertFalse(draft.canStep(.defaultStay, up: true))
        draft.step(.defaultStay, up: true)
        XCTAssertEqual(draft.defaultStayMinutes, 240)
    }

    func testSavesWhatWasEdited() {
        var draft = LimitsDraft(response())
        draft.step(.dailyCap, up: false)
        XCTAssertEqual(draft.limits, SpendingLimits(sessionCapUsd: 45, dailyCapUsd: 55, defaultStayMinutes: 90))
    }

    // MARK: - Why a save didn't happen

    func testARefusalIsTheServersOwnSentence() {
        let rejected = LimitsRejected(issues: [
            LimitsIssue(
                field: "sessionCapUsd",
                code: "session_above_daily",
                message: "Per stop can't be more than per day ($30.00).",
                limit: 30
            ),
        ])
        XCTAssertEqual(LimitsCopy.saveFailure(rejected), "Per stop can't be more than per day ($30.00).")
    }

    func testTransportAndServerFailuresSayWhatHappened() {
        XCTAssertEqual(
            LimitsCopy.saveFailure(APIError.transport(URLError(.notConnectedToInternet))),
            "Couldn't reach the server, so your limits weren't changed. Check the connection and try again."
        )
        XCTAssertEqual(
            LimitsCopy.saveFailure(APIError.server(status: 500)),
            "The server couldn't save your limits (error 500). Try again in a minute."
        )
        XCTAssertEqual(
            LimitsCopy.saveFailure(APIError.unauthorized),
            "You're signed out. Sign in again to change your limits."
        )
    }
}
