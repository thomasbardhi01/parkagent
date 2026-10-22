import XCTest

/// "Check the signs" (Issue N) from the parked sheet. The simulator has no
/// camera, so the test feeds a rendered sign; the reading of it is the
/// real on-device Vision OCR, and the mock server scripts its verdict on
/// that text (a one-hour limit is stricter than the fixtures' two hours).
final class SignCheckUITests: ParkAgentUITestCase {
    func testAStricterSignOffersAShorterStayTakenOnce() {
        let app = launchApp(scenario: "singleQuote", extraArguments: ["-signReader", "YES"])
        simulateParkFromHome(app)

        let check = element(app, "parkedSheet.checkSignsButton")
        XCTAssertTrue(check.waitForExistence(timeout: 5), "Check the signs missing with the reader on")
        check.tap()
        XCTAssertTrue(element(app, "signCheck.view").waitForExistence(timeout: 5), "Sign check sheet did not open")
        XCTAssertTrue(element(app, "signCheck.choosePhotoButton").exists, "The photo fallback is missing")

        let read = element(app, "signCheck.readButton")
        XCTAssertFalse(read.isEnabled, "Nothing to read before a photo")
        element(app, "signCheck.debugFixtureSignButton").tap()
        XCTAssertTrue(element(app, "signCheck.photos").waitForExistence(timeout: 5), "The photo did not appear")
        read.tap()

        let stricter = element(app, "signCheck.verdict.stricter")
        XCTAssertTrue(stricter.waitForExistence(timeout: 20), "The rendered one-hour sign did not read as stricter")
        XCTAssertTrue(element(app, "signCheck.advisoryNote").exists, "The advisory note is missing")

        let accept = element(app, "signCheck.acceptButton")
        XCTAssertTrue(accept.exists, "No shorter stay offered")
        XCTAssertEqual(accept.label, "Hold this park to 1 hr")
        accept.tap()
        let accepted = element(app, "signCheck.acceptedNote")
        XCTAssertTrue(accepted.waitForExistence(timeout: 5), "Accepting did not confirm")
        XCTAssertFalse(element(app, "signCheck.acceptButton").exists, "The offer can be taken only once")

        element(app, "signCheck.doneButton").tap()
        XCTAssertTrue(element(app, "signCheck.view").waitForNonExistence(timeout: 5), "Sign check did not close")
        XCTAssertTrue(element(app, "parkedSheet.payButton").exists, "The parked sheet's Pay is gone after a check")
    }

    func testNoCheckButtonWhenTheReaderIsOff() {
        let app = launchApp(scenario: "singleQuote")
        simulateParkFromHome(app)
        XCTAssertTrue(element(app, "parkedSheet.payButton").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "parkedSheet.checkSignsButton").exists, "Check the signs shown with the reader off")
    }
}
