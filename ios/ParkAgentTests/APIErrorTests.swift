import XCTest
@testable import ParkAgent

/// A failed payment must never claim the meter is unpaid unless that's
/// certain: after the pay click, a provider step that didn't confirm (or a
/// dropped connection) may have charged, and a blind retry pays twice.
final class APIErrorTests: XCTestCase {
    private func executorFailure(_ code: String) -> APIError {
        LiveAPI.failure(status: 502, data: Data(#"{"error":"executor_failed","code":"\#(code)","decisionId":"d1"}"#.utf8))
    }

    func testExecutorFailedDecodesWithItsCode() {
        guard case .executorFailed(let code) = executorFailure("ui_changed") else {
            return XCTFail("502 executor_failed should decode as .executorFailed")
        }
        XCTAssertEqual(code, "ui_changed")
    }

    func testPreChargeCodesSayTheMeterIsntPaid() {
        for code in ["payment_declined", "payment_method_missing", "vehicle_missing", "zone_not_found", "auth_expired", "parking_denied"] {
            let error = executorFailure(code)
            XCTAssertTrue(error.providerDeclined, code)
            XCTAssertFalse(error.paymentOutcomeUnknown, code)
            XCTAssertTrue(error.startFailureMessage.contains("the meter isn't paid"), "\(code): \(error.startFailureMessage)")
        }
    }

    func testCodesAfterThePayClickNeverClaimUnpaid() {
        for code in ["ui_changed", "network", "browser_crashed", "unknown"] {
            let error = executorFailure(code)
            XCTAssertTrue(error.paymentOutcomeUnknown, code)
            XCTAssertFalse(error.startFailureMessage.contains("isn't paid"), code)
            XCTAssertTrue(error.startFailureMessage.contains("so you don't pay twice"), code)
        }
    }

    func testALostConnectionMayHavePaid() {
        let error = APIError.transport(URLError(.timedOut))
        XCTAssertTrue(error.paymentOutcomeUnknown)
        XCTAssertTrue(error.startFailureMessage.contains("may or may not have gone through"), error.startFailureMessage)
    }

    /// The Link one-time card is shown once; the server answers any later
    /// reveal 410, and that must read as its own sentence, not a server
    /// error.
    func testAnAlreadyRevealedLinkCardSaysSo() {
        let error = LiveAPI.failure(status: 410, data: Data(#"{"error":"card_already_revealed"}"#.utf8))
        guard case .refused(let code) = error else {
            return XCTFail("410 card_already_revealed should decode as .refused, got \(error)")
        }
        XCTAssertEqual(code, "card_already_revealed")
        XCTAssertEqual(error.errorDescription, "That Link card was already shown once, and it can't be shown again.")
    }

    func testAPlainRefusalKeepsItsOwnSentence() {
        let error = LiveAPI.failure(status: 409, data: Data(#"{"error":"session_already_active"}"#.utf8))
        XCTAssertFalse(error.paymentOutcomeUnknown)
        XCTAssertEqual(error.startFailureMessage, "A parking session is already running. Stop it before starting another.")
    }
}
