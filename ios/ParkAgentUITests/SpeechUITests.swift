import XCTest

/// Live transcription in the assistant sheet, driven by the scripted
/// recognizer (`-speechScenario`): streaming words, the silence countdown,
/// the editable hand-off into the input field, and the denied/unavailable
/// notices. No real microphone or Speech framework is touched.
final class SpeechUITests: ParkAgentUITestCase {
    private static let scriptedText = "Park me near the MFA at 2 for two hours"

    private func openAssistant(speechScenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-resetState", "YES",
            "-useMockAPI", "YES",
            "-uiTesting", "YES",
            "-skipOnboarding", "YES",
            "-fixedNow", Self.fixedNow,
            "-assistantScenario", "singleSpot",
            "-speechScenario", speechScenario,
        ]
        app.launch()
        element(app, "home.askAssistantButton").tap()
        XCTAssertTrue(element(app, "assistant.inputField").waitForExistence(timeout: 5))
        return app
    }

    /// Mic tap → words stream into the live panel → silence countdown →
    /// auto-stop lands the transcript in the input field, still editable,
    /// and nothing was sent on the user's behalf.
    func testScriptedDictationStreamsThenHandsOffEditable() {
        let app = openAssistant(speechScenario: "scripted")
        element(app, "assistant.micButton").tap()

        let panel = element(app, "assistant.liveTranscript")
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "Live transcript panel missing")
        // Words arrive progressively — an early word shows before the
        // scripted session has finished.
        XCTAssertTrue(app.staticTexts["Park"].waitForExistence(timeout: 5), "First word did not stream in")

        // Silence: the visible countdown precedes the auto-stop. Screenshot
        // taken here so the PR shows the countdown state.
        XCTAssertTrue(
            element(app, "assistant.silenceCountdown").waitForExistence(timeout: 10),
            "Silence countdown never appeared"
        )
        attachScreenshot(of: app, named: "assistant-listening")
        XCTAssertTrue(panel.waitForNonExistence(timeout: 10), "Auto-stop did not end the session")

        // The transcript is in the input field, not sent.
        let field = element(app, "assistant.inputField")
        XCTAssertEqual(field.value as? String, Self.scriptedText, "Transcript should land in the field")
        XCTAssertFalse(element(app, "assistant.userMessage").exists, "Nothing may send on the user's behalf")

        // Editable: the user can change it before sending.
        field.tap()
        field.typeText(" please")
        element(app, "assistant.sendButton").tap()
        let sent = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'please'")
        ).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 5), "Edited transcript did not send")
        XCTAssertTrue(element(app, "assistant.singleSpotPlan").waitForExistence(timeout: 10))
    }

    /// Manual stop mid-stream also hands the partial transcript to the field.
    func testManualStopKeepsPartialTranscript() {
        let app = openAssistant(speechScenario: "scripted")
        element(app, "assistant.micButton").tap()
        XCTAssertTrue(app.staticTexts["Park"].waitForExistence(timeout: 5))

        element(app, "assistant.micButton").tap() // now a stop button
        XCTAssertTrue(element(app, "assistant.liveTranscript").waitForNonExistence(timeout: 5))
        let value = element(app, "assistant.inputField").value as? String ?? ""
        XCTAssertTrue(value.hasPrefix("Park"), "Partial transcript should be kept, got \"\(value)\"")
    }

    /// Permission denied: a notice with a Settings path, and typing still works.
    func testDeniedShowsNoticeWithSettingsPath() {
        let app = openAssistant(speechScenario: "denied")
        element(app, "assistant.micButton").tap()

        let notice = element(app, "assistant.speechDeniedNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "Denied notice missing")
        XCTAssertTrue(app.buttons["Open Settings"].exists, "Settings path missing")
        XCTAssertFalse(element(app, "assistant.liveTranscript").exists)

        // Dismiss works and the keyboard path is unaffected.
        app.buttons["Dismiss"].tap()
        XCTAssertTrue(notice.waitForNonExistence(timeout: 5), "Notice did not dismiss")
        let field = element(app, "assistant.inputField")
        field.tap()
        field.typeText("typed instead")
        element(app, "assistant.sendButton").tap()
        XCTAssertTrue(element(app, "assistant.userMessage").waitForExistence(timeout: 5))
    }

    /// Recognition unavailable: its own notice, no Settings button.
    func testUnavailableShowsNotice() {
        let app = openAssistant(speechScenario: "unavailable")
        element(app, "assistant.micButton").tap()

        let notice = element(app, "assistant.speechUnavailableNotice")
        XCTAssertTrue(notice.waitForExistence(timeout: 5), "Unavailable notice missing")
        XCTAssertFalse(app.buttons["Open Settings"].exists, "Settings can't fix unavailability")
        app.buttons["Dismiss"].tap()
        XCTAssertTrue(notice.waitForNonExistence(timeout: 5))
    }
}
