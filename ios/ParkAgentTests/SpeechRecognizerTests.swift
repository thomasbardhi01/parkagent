import XCTest
@testable import ParkAgent

/// The dictation lifecycle against the injected scripted recognizer — the
/// state machine only, no audio engine, no permission prompts. Pins the
/// #104 follow-up fixes: re-entrant start is a no-op, stop is idempotent
/// and always hands the transcript off, and the UserDefaults scenario is
/// dead outside UI-test launches.
@MainActor
final class SpeechRecognizerTests: XCTestCase {
    private static let script = "Park me near the MFA at 2 for two hours"

    /// Bounded poll so a broken state machine fails fast instead of hanging.
    ///
    /// The budget is generous on purpose. The scripted session is driven by
    /// real `Task.sleep`s (8 words at 140 ms, then a 3-step countdown at
    /// 900 ms ≈ 3.8 s), so on a loaded machine the wall clock stretches
    /// well past a tight bound — this suite went red at 150 s for a test
    /// that normally finishes in 5. A broken state machine still fails
    /// here, just less punctually; a busy CI box no longer does.
    private func waitUntil(
        _ what: String,
        timeout: TimeInterval = 60,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("Timed out waiting for \(what)")
                return
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    func testScriptedSessionStreamsCountsDownAndHandsOff() async {
        let speech = SpeechRecognizer(scenarioOverride: .scripted)
        await speech.start()
        XCTAssertEqual(speech.state, .listening)

        await waitUntil("words to stream") { !speech.words.isEmpty }
        await waitUntil("silence countdown") { speech.silenceCountdown != nil }
        await waitUntil("auto-stop") { speech.state == .idle }

        XCTAssertEqual(speech.finishedTranscript, Self.script)
        XCTAssertNil(speech.silenceCountdown)
        speech.acknowledge()
        XCTAssertNil(speech.finishedTranscript)
    }

    /// A second start while one is live must not reset the session (the
    /// production bug was worse: the real path could double-install the
    /// audio tap and crash — the isStarting/state guard covers both).
    func testSecondStartWhileListeningIsANoOp() async {
        let speech = SpeechRecognizer(scenarioOverride: .scripted)
        await speech.start()
        await waitUntil("some words") { speech.words.count >= 2 }
        let wordsBefore = speech.words.count

        await speech.start()

        XCTAssertEqual(speech.state, .listening)
        XCTAssertGreaterThanOrEqual(
            speech.words.count, wordsBefore,
            "A re-entrant start must not clear the in-flight transcript"
        )
        speech.stop()
    }

    func testManualStopHandsOffPartialAndIsIdempotent() async {
        let speech = SpeechRecognizer(scenarioOverride: .scripted)
        await speech.start()
        await waitUntil("some words") { speech.words.count >= 2 }

        speech.stop()
        XCTAssertEqual(speech.state, .idle)
        let handedOff = speech.finishedTranscript
        XCTAssertTrue(handedOff?.hasPrefix("Park") == true, "Partial transcript should hand off")

        speech.stop() // second stop: no crash, no state change, no re-hand-off
        XCTAssertEqual(speech.state, .idle)
        XCTAssertEqual(speech.finishedTranscript, handedOff)
    }

    func testRestartAfterStopBeginsAFreshSession() async {
        let speech = SpeechRecognizer(scenarioOverride: .scripted)
        await speech.start()
        await waitUntil("some words") { speech.words.count >= 2 }
        speech.stop()

        await speech.start()
        XCTAssertEqual(speech.state, .listening)
        XCTAssertNil(speech.finishedTranscript, "A new session clears the old hand-off")
        await waitUntil("fresh words") { !speech.words.isEmpty }
        speech.stop()
    }

    func testDeniedAndUnavailableStatesAndReset() async {
        let denied = SpeechRecognizer(scenarioOverride: .denied)
        await denied.start()
        XCTAssertEqual(denied.state, .denied)
        denied.resetAvailability()
        XCTAssertEqual(denied.state, .idle)

        let unavailable = SpeechRecognizer(scenarioOverride: .unavailable)
        await unavailable.start()
        XCTAssertEqual(unavailable.state, .unavailable)
        unavailable.resetAvailability()
        XCTAssertEqual(unavailable.state, .idle)
    }

    /// The device crash class behind #2: the speech-authorization handler
    /// arrives on a background queue, and a main-actor-isolated closure
    /// traps there under Swift 6. The bridge must accept a callback fired
    /// from ANY queue without trapping and still resume correctly.
    ///
    /// Scope, honestly: this pins the BRIDGE's contract. It does not drive
    /// `start()`'s real call site (that shows a system prompt), so it would
    /// still pass if someone inlined `SFSpeechRecognizer.requestAuthorization`
    /// back into the @MainActor method. What keeps the call site safe is
    /// structural: the bridge's parameters are `@Sendable`, and a
    /// `@Sendable` closure never inherits the enclosing actor's isolation.
    func testAuthorizationCallbackOnBackgroundQueueDoesNotTrap() async {
        let granted = await SpeechRecognizer.bridgeAuthorization { done in
            DispatchQueue.global(qos: .userInitiated).async {
                done(true)
            }
        }
        XCTAssertTrue(granted)

        let denied = await SpeechRecognizer.bridgeAuthorization { done in
            DispatchQueue.global(qos: .background).async {
                done(false)
            }
        }
        XCTAssertFalse(denied)
    }

    /// Dismissing the sheet while the permission alert is up: stop() has
    /// no session to tear down (state is still .idle, so it returns
    /// early), and without the startCancelled flag start() would resume
    /// and bring up a mic for a view that's gone — leaving the .record
    /// session active and other apps ducked.
    func testStopDuringPermissionPromptAbortsTheStart() async {
        let gate = PermissionGate()
        let speech = SpeechRecognizer(
            scenarioOverride: nil,
            requestPermissions: { await gate.wait() }
        )
        let started = Task { await speech.start() }

        await waitUntil("the permission prompt to be reached") { gate.isWaiting }
        XCTAssertEqual(speech.state, .idle, "Still idle while the alert is up")

        speech.stop() // the sheet is dismissed
        gate.grant(true) // the user then allows it — too late
        await started.value

        XCTAssertEqual(speech.state, .idle, "A cancelled start must not begin listening")
        XCTAssertNil(speech.finishedTranscript)
    }

    /// The same flag must not leak into the next attempt on the SAME
    /// recognizer. The retry is answered "denied" so it never reaches the
    /// real audio path: `.denied` is only reachable past the cancellation
    /// check, so a leaked flag would leave the state at `.idle` instead.
    func testStartAfterACancelledStartStillWorks() async {
        let gate = PermissionGate()
        let speech = SpeechRecognizer(
            scenarioOverride: nil,
            requestPermissions: { await gate.wait() }
        )
        let cancelled = Task { await speech.start() }
        await waitUntil("the permission prompt") { gate.isWaiting }
        speech.stop()
        gate.grant(true)
        await cancelled.value
        XCTAssertEqual(speech.state, .idle)

        let retry = Task { await speech.start() }
        await waitUntil("the retry's permission prompt") { gate.isWaiting }
        gate.grant(false)
        await retry.value
        XCTAssertEqual(speech.state, .denied, "The retry must run past the cancellation check")
    }

    /// The persisted -speechScenario key must be inert outside UI-test
    /// launches — it rewires the REAL recognizer, unlike the MockAPI keys.
    func testDefaultsScenarioIsGatedOnUITesting() {
        UserDefaults.standard.set("scripted", forKey: SpeechMockScenario.defaultsKey)
        defer { UserDefaults.standard.removeObject(forKey: SpeechMockScenario.defaultsKey) }

        XCTAssertFalse(LaunchOverrides.uiTesting, "Unit-test host must not launch with -uiTesting")
        XCTAssertNil(
            SpeechMockScenario.fromDefaults(),
            "A leftover speechScenario default must never reach a normal launch"
        )
    }
}

/// A permission prompt a test can hold open: `wait()` suspends until
/// `grant()` answers, so a dismissal can land in between.
private final class PermissionGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var waiting = false

    var isWaiting: Bool {
        lock.lock()
        defer { lock.unlock() }
        return waiting
    }

    func wait() async -> Bool {
        await withCheckedContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            waiting = true
            lock.unlock()
        }
    }

    func grant(_ granted: Bool) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        waiting = false
        lock.unlock()
        continuation?.resume(returning: granted)
    }
}

/// The assistant's street confirmation wording: the pay-by-app number when
/// the server sent one, never the internal zone slug.
@MainActor
final class StreetNoteTests: XCTestCase {
    func testUsesProviderZoneNumberWhenPresent() {
        let note = AssistantModel.streetNote(
            providerZoneNumber: "81234", durationMinutes: 90, paymentSource: "parkagent_card"
        )
        XCTAssertTrue(note.hasPrefix("Zone 81234 is set for 90 min"))
        XCTAssertTrue(note.hasSuffix("Paying with the ParkAgent card."), "got: \(note)")
    }

    func testFallsBackWithoutANumber() {
        for missing in [nil, ""] {
            let note = AssistantModel.streetNote(
                providerZoneNumber: missing, durationMinutes: 60, paymentSource: "provider_card"
            )
            XCTAssertTrue(note.hasPrefix("Your spot is set for 60 min"), "got: \(note)")
            XCTAssertFalse(note.contains("bos-"), "No internal slugs in chat copy")
            XCTAssertTrue(note.hasSuffix("Paying with the card on your parking account."), "got: \(note)")
        }
    }

    /// A street meter is never paid by Link (the provider keeps one saved
    /// card) — whatever the server said, the note can't claim it.
    func testNeverClaimsLinkForAStreetMeter() {
        let note = AssistantModel.streetNote(
            providerZoneNumber: "456", durationMinutes: 30, paymentSource: "link_wallet"
        )
        XCTAssertFalse(note.contains("Link"), "got: \(note)")
    }
}
