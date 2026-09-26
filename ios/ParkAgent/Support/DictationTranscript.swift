import Foundation

/// One continuous dictation's text: the segments a recognizer has
/// committed, plus the one it's still guessing at. Kept apart from the
/// audio so every rule here is unit-testable.
///
/// The 2026-09-25 device test: dictation "stops too quickly, and a pause
/// starts a fresh transcript, wiping what I said". Recognizers end a
/// segment at a pause in three different ways, and each one used to
/// replace the text so far:
///  - a FINAL result, then fresh partials (or the task ends and a new one
///    starts) — the final is committed and the next partial appends;
///  - partials that silently start over ("Find me parking at Seaport" →
///    "At") with no final — seen as a reset and the old partial committed;
///  - partials that start over but REPEAT what this recognition task
///    already committed ("Find me parking at Seaport at 7", even across
///    several commits) — the committed words are not repeated.
struct DictationTranscript: Equatable {
    private(set) var committed: [String] = []
    private(set) var partial = ""
    /// Where the current recognition task's commits begin in `committed`.
    private var taskStart = 0

    /// Everything said so far, cleaned and joined.
    var text: String { TranscriptJoiner.join(committed + [partial]) }

    var isEmpty: Bool { text.isEmpty }

    /// The recognizer's current guess for the segment in progress.
    mutating func apply(partial newText: String) {
        var text = newText.trimmingCharacters(in: .whitespacesAndNewlines)
        // A recognizer that keeps the task's whole utterance after a commit:
        // what this task committed isn't said twice (word by word, so a
        // period or a capital doesn't hide the repeat).
        let taskText = committed[taskStart...].joined(separator: " ")
        text = Self.dropping(prefix: taskText, from: text)
        if Self.isReset(from: partial, to: text) {
            commit()
        }
        partial = text
    }

    /// `text` without its first words when they are `prefix`'s words.
    static func dropping(prefix: String, from text: String) -> String {
        let core = { (word: Substring) in word.lowercased().trimmingCharacters(in: .punctuationCharacters) }
        let prefixWords = prefix.split(separator: " ").map(core).filter { !$0.isEmpty }
        let words = text.split(separator: " ")
        guard !prefixWords.isEmpty, words.count >= prefixWords.count,
              zip(words, prefixWords).allSatisfy({ core($0) == $1 })
        else { return text }
        return words.dropFirst(prefixWords.count).joined(separator: " ")
    }

    /// The recognizer finished the segment in progress.
    mutating func apply(final text: String) {
        apply(partial: text)
        commit()
    }

    /// The recognition task ended (iOS ends them at long pauses and after
    /// about a minute): what it had is kept, and the next task appends.
    mutating func taskEnded() {
        commit()
        taskStart = committed.count
    }

    private mutating func commit() {
        let segment = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        partial = ""
        guard !segment.isEmpty else { return }
        committed.append(segment)
    }

    /// Did the recognizer start a new segment without saying so? A
    /// revision keeps or grows the guess ("Fine me" → "Find me parking");
    /// a restart drops back to a shorter guess with a different first
    /// word ("Find me parking at Seaport" → "At").
    static func isReset(from old: String, to new: String) -> Bool {
        let oldWords = old.split(separator: " ")
        let newWords = new.split(separator: " ")
        guard oldWords.count >= 2, !newWords.isEmpty, newWords.count < oldWords.count else { return false }
        return oldWords[0].lowercased() != newWords[0].lowercased()
    }
}

/// Joins dictated segments into one message: fillers and stutters don't
/// split it ("Find me parking at Seaport." + "Um, at 7 PM near near Lola 42"
/// → "Find me parking at Seaport at 7 PM near Lola 42").
enum TranscriptJoiner {
    /// Hesitations, dropped wherever they fall.
    static let fillers: Set<String> = [
        "um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "hmm", "hm", "mm", "mhm",
    ]

    /// Words that continue a sentence — a segment starting with one joins
    /// the previous one instead of beginning a new sentence.
    private static let continuations: Set<String> = [
        "at", "for", "near", "in", "on", "and", "or", "but", "the", "a", "an", "to",
        "around", "about", "by", "from", "with", "then", "so", "until", "after", "before",
        "tonight", "tomorrow", "today", "this", "next", "maybe", "also", "please", "close",
    ]

    /// One segment without fillers or stuttered repeats ("near near").
    static func clean(_ segment: String) -> String {
        var kept: [String] = []
        var previousCore: String?
        for token in segment.split(whereSeparator: \.isWhitespace) {
            let core = token.lowercased().trimmingCharacters(in: .punctuationCharacters)
            if core.isEmpty || fillers.contains(core) { continue }
            if core == previousCore, core.allSatisfy(\.isLetter) { continue }
            kept.append(String(token))
            previousCore = core
        }
        return kept.joined(separator: " ")
    }

    static func join(_ segments: [String]) -> String {
        var result = ""
        for raw in segments {
            var segment = clean(raw)
            guard !segment.isEmpty else { continue }
            if result.isEmpty {
                result = segment
                continue
            }
            let firstWord = segment.split(separator: " ").first.map(String.init) ?? ""
            let firstCore = firstWord.lowercased().trimmingCharacters(in: .punctuationCharacters)
            if continuations.contains(firstCore) {
                // "…at Seaport." + "At 7 PM" is one sentence: no period, no capital.
                if let last = result.last, last == "." || last == "," {
                    result.removeLast()
                }
                segment = segment.prefix(1).lowercased() + segment.dropFirst()
            } else if let last = result.last, last == "," {
                result.removeLast()
            }
            result += " " + segment
        }
        return result
    }
}
