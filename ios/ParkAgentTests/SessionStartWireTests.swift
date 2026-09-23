import XCTest
@testable import ParkAgent

/// POST /session/start's dual response shape. The regression this pins:
/// the app decoded only the started shape, so the server's 200
/// {status: "free_period"} threw and free parking rendered as a payment
/// failure while the push said parking was free.
final class SessionStartWireTests: XCTestCase {
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private func outcome(_ json: String) throws -> SessionStartOutcome {
        try decoder.decode(SessionStartWire.self, from: Data(json.utf8)).outcome()
    }

    func testStartedShapeDecodes() throws {
        let result = try outcome(
            #"{"sessionId": "s1", "expiresAt": "2026-09-22T21:00:00Z", "amountUsd": 7.28}"#
        )
        guard case .started(let response) = result else {
            return XCTFail("Expected .started, got \(result)")
        }
        XCTAssertEqual(response.sessionId, "s1")
        XCTAssertEqual(response.amountUsd, 7.28)
    }

    func testFreePeriodShapeDecodes() throws {
        let result = try outcome(
            #"{"status": "free_period", "zoneId": "bos-x", "notice": "No Meter Parking. Mon-Sat 8am-8pm", "decisionId": "d1"}"#
        )
        guard case .freePeriod(let notice) = result else {
            return XCTFail("Expected .freePeriod, got \(result)")
        }
        XCTAssertEqual(notice, "No Meter Parking. Mon-Sat 8am-8pm")
    }

    func testFreePeriodWithoutNoticeStillDecodes() throws {
        let result = try outcome(#"{"status": "free_period"}"#)
        guard case .freePeriod(let notice) = result else {
            return XCTFail("Expected .freePeriod, got \(result)")
        }
        XCTAssertNil(notice)
    }

    func testNeitherShapeThrowsInsteadOfGuessing() {
        XCTAssertThrowsError(try outcome(#"{"unrelated": true}"#))
        // A started shape missing a required field must not decode as free.
        XCTAssertThrowsError(try outcome(#"{"sessionId": "s1"}"#))
    }
}
