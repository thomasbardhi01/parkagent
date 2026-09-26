import XCTest

/// Live transcription in the assistant sheet, driven by the scripted
/// recognizer (`-speechScenario`): streaming words, the silence countdown,
/// the editable hand-off into the input field, and the denied/unavailable
/// notices. No real microphone or Speech framework is touched.
final class SpeechUITests: ParkAgentUITestCase {
    private static let scriptedText = "Park me near the MFA at 2 for two hours"
    private static let continuityText = "Find me parking at Seaport at 7 PM near Lola 42 for three hours"

    private func openAssistant(speechScenario: String, pauseSeconds: Int? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-resetState", "YES",
            "-useMockAPI", "YES",
            "-uiTesting", "YES",
            "-skipOnboarding", "YES",
            // Auth gates the app now: start past the welcome screen.
            "-signedIn", "YES",
            "-fixedNow", Self.fixedNow,
            "-assistantScenario", "singleSpot",
            "-speechScenario", speechScenario,
        ] + (pauseSeconds.map { ["-dictationPauseSeconds", String($0)] } ?? [])
        app.launch()
        element(app, "home.askAssistantButton").tap()
        XCTAssertTrue(element(app, "assistant.inputField").waitForExistence(timeout: 5))
        return app
    }

    /// Mic tap → words stream into the live panel → a quiet moment says
    /// "still listening" → a silence past the pause limit lands the words
    /// in the input field, still editable, and nothing was sent on the
    /// user's behalf.
    func testScriptedDictationStreamsThenHandsOffEditable() {
        let app = openAssistant(speechScenario: "scripted")
        element(app, "assistant.micButton").tap()

        let panel = element(app, "assistant.liveTranscript")
        XCTAssertTrue(panel.waitForExistence(timeout: 5), "Live transcript panel missing")
        // Words arrive progressively — an early word shows before the
        // scripted session has finished.
        XCTAssertTrue(app.staticTexts["Park"].waitForExistence(timeout: 5), "First word did not stream in")

        // A quiet moment: still listening, and the panel says how to finish.
        XCTAssertTrue(
            element(app, "assistant.dictation.pausing").waitForExistence(timeout: 10),
            "The pause hint never appeared"
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

    /// One continuous dictation (the device test: "it stops too quickly, and
    /// a pause starts a fresh transcript"): a finished segment, an ended
    /// recognition task, a 2-second pause, fillers, a stutter, and a
    /// recognizer starting over all land in ONE message; it keeps listening
    /// with a waveform and a running clock until the mic is tapped, and
    /// nothing is sent until the user sends it.
    ///
    /// The pause limit is widened to 10 s here, through the real setting:
    /// on a slow CI runner XCUITest's own snapshots stall the app's main
    /// thread about a second at a time, which stretched the scripted 2 s
    /// pause past the 3 s default and ended the dictation mid-test. The
    /// limit itself is pinned by SpeechRecognizerTests
    /// (testPauseToleranceIsConfigurable); this test is about continuity.
    func testContinuousDictationKeepsEveryWordUntilFinished() {
        let app = openAssistant(speechScenario: "continuity", pauseSeconds: 10)
        element(app, "assistant.micButton").tap()

        let text = element(app, "assistant.dictation.text")
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        waitForLabel(of: text, toBe: "Find me parking at Seaport.", timeout: 10)
        // After the pause and the ended task: the first segment is still
        // there, and the rest appended to it.
        waitForLabel(of: text, toBe: Self.continuityText, timeout: 20)
        XCTAssertTrue(element(app, "assistant.liveTranscript").exists, "Still listening")
        XCTAssertTrue(element(app, "assistant.dictation.waveform").exists)
        let elapsed = element(app, "assistant.dictation.elapsed")
        XCTAssertTrue(elapsed.exists)
        XCTAssertNotNil(elapsed.label.range(of: #"^Listening for \d+:\d\d$"#, options: .regularExpression), elapsed.label)
        XCTAssertFalse(element(app, "assistant.userMessage").exists, "Nothing sends by itself")
        attachScreenshot(of: app, named: "assistant-dictation-continuous")

        // The mic finishes it: every word in the field, still not sent.
        element(app, "assistant.micButton").tap()
        XCTAssertTrue(element(app, "assistant.liveTranscript").waitForNonExistence(timeout: 5))
        XCTAssertEqual(element(app, "assistant.inputField").value as? String, Self.continuityText)
        XCTAssertFalse(element(app, "assistant.userMessage").exists)
    }

    /// The pause limit is the user's setting (`dictationPauseSeconds`): at
    /// 1 s, the same script's 2 s pause ends the dictation, and what was
    /// said goes to the field — nothing lost, nothing sent.
    func testPauseLimitIsTheUsersSetting() {
        let app = openAssistant(speechScenario: "continuity", pauseSeconds: 1)
        element(app, "assistant.micButton").tap()
        XCTAssertTrue(element(app, "assistant.liveTranscript").waitForExistence(timeout: 5))
        XCTAssertTrue(element(app, "assistant.liveTranscript").waitForNonExistence(timeout: 15))
        XCTAssertEqual(element(app, "assistant.inputField").value as? String, "Find me parking at Seaport.")
        XCTAssertFalse(element(app, "assistant.userMessage").exists)
    }

    /// Send while dictating finishes the dictation and sends every word.
    func testSendFinishesTheDictation() {
        let app = openAssistant(speechScenario: "continuity", pauseSeconds: 10)
        element(app, "assistant.micButton").tap()
        let text = element(app, "assistant.dictation.text")
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        waitForLabel(of: text, toBe: Self.continuityText, timeout: 20)

        element(app, "assistant.sendButton").tap()
        let sent = app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == 'assistant.userMessage' AND label == %@", Self.continuityText
        )).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 5), "Send sends everything said")
        XCTAssertFalse(element(app, "assistant.liveTranscript").exists, "and ends the dictation")
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

    /// Dismissing the sheet mid-dictation releases the mic (onDisappear →
    /// stop); reopening starts clean and a fresh session works.
    func testDismissingSheetStopsDictation() {
        let app = openAssistant(speechScenario: "scripted")
        element(app, "assistant.micButton").tap()
        XCTAssertTrue(element(app, "assistant.liveTranscript").waitForExistence(timeout: 5))

        app.buttons["Done"].tap()
        element(app, "home.askAssistantButton").tap()
        XCTAssertTrue(element(app, "assistant.inputField").waitForExistence(timeout: 5))
        XCTAssertFalse(element(app, "assistant.liveTranscript").exists, "Old session must not survive")

        element(app, "assistant.micButton").tap()
        XCTAssertTrue(
            element(app, "assistant.liveTranscript").waitForExistence(timeout: 5),
            "A fresh session should start after the teardown"
        )
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
