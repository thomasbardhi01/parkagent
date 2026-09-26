import XCTest
@testable import ParkAgent

/// One continuous dictation's text. The device test: "a pause starts a
/// fresh transcript, wiping what I said" — each way a recognizer can start
/// a new segment must APPEND, and fillers and stutters must not split the
/// message.
final class DictationTranscriptTests: XCTestCase {
    func testAFinalSegmentThenNewPartialsAppend() {
        var t = DictationTranscript()
        t.apply(partial: "Find me parking")
        t.apply(final: "Find me parking at Seaport")
        t.apply(partial: "at 7 PM")
        XCTAssertEqual(t.text, "Find me parking at Seaport at 7 PM")
    }

    func testAnEndedTaskKeepsItsWordsAndTheNextTaskAppends() {
        var t = DictationTranscript()
        t.apply(partial: "Find me parking at Seaport")
        t.taskEnded()
        t.apply(partial: "near Lola 42")
        XCTAssertEqual(t.text, "Find me parking at Seaport near Lola 42")
    }

    func testARecognizerThatSilentlyStartsOverIsANewSegment() {
        var t = DictationTranscript()
        t.apply(partial: "Find me parking at Seaport")
        // No final: the next guess is shorter and starts with another word.
        t.apply(partial: "At")
        t.apply(partial: "At 7 PM")
        XCTAssertEqual(t.text, "Find me parking at Seaport at 7 PM")
    }

    func testARevisionIsNotANewSegment() {
        var t = DictationTranscript()
        t.apply(partial: "Fine me")
        t.apply(partial: "Find me parking")
        XCTAssertEqual(t.text, "Find me parking")
        t.apply(partial: "Find me parking near")
        t.apply(partial: "Find me parking near Lola")
        XCTAssertEqual(t.committed, [], "Growing guesses are one segment")
    }

    func testARecognizerThatRepeatsTheCommittedTextDoesntSayItTwice() {
        var t = DictationTranscript()
        t.apply(final: "Find me parking at Seaport")
        t.apply(partial: "Find me parking at Seaport at 7")
        XCTAssertEqual(t.text, "Find me parking at Seaport at 7")
    }

    /// A recognizer whose results within one task are cumulative, across
    /// two commits: nothing it already committed is said twice.
    func testCumulativeResultsAcrossSeveralCommitsDontRepeat() {
        var t = DictationTranscript()
        t.apply(final: "Find me parking at Seaport")
        t.apply(final: "Find me parking at Seaport at 7 PM")
        t.apply(partial: "Find me parking at Seaport at 7 PM near Lola")
        XCTAssertEqual(t.text, "Find me parking at Seaport at 7 PM near Lola")
        // A new task starts clean: its first words aren't compared with the
        // last task's.
        t.taskEnded()
        t.apply(partial: "Find more")
        XCTAssertEqual(t.text, "Find me parking at Seaport at 7 PM near Lola Find more")
    }

    func testFillersAndStuttersDontSplitTheMessage() {
        XCTAssertEqual(
            TranscriptJoiner.join(["Find me parking at Seaport.", "Um, at 7 PM near near Lola 42", "uh", "For three hours"]),
            "Find me parking at Seaport at 7 PM near Lola 42 for three hours"
        )
    }

    func testNamesKeepTheirCapitals() {
        XCTAssertEqual(TranscriptJoiner.join(["near", "Lola 42"]), "near Lola 42")
        XCTAssertEqual(TranscriptJoiner.join(["Park me near the MFA", "Tomorrow at 2"]), "Park me near the MFA tomorrow at 2")
    }

    func testCleaning() {
        XCTAssertEqual(TranscriptJoiner.clean("um uh hmm"), "")
        XCTAssertEqual(TranscriptJoiner.clean("the the garage"), "the garage")
        XCTAssertEqual(TranscriptJoiner.clean("42 42 Seaport"), "42 42 Seaport", "Numbers can repeat")
    }

    /// Dictating into a field that already has words appends to them.
    @MainActor
    func testDictationAppendsToWhatsAlreadyInTheField() {
        XCTAssertEqual(AssistantSheetView.merge("near Lola 42", "At 7 PM"), "near Lola 42 at 7 PM")
        XCTAssertEqual(AssistantSheetView.merge("", "Find me parking"), "Find me parking")
    }
}
