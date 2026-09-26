import AVFoundation
import Foundation
import Observation
import Speech

/// Live dictation for the assistant sheet — ONE continuous dictation, not a
/// recognition task (2026-09-25 device test: "it stops too quickly, and a
/// pause starts a fresh transcript, wiping what I said"):
///
///  - segments append instead of replacing (DictationTranscript);
///  - when iOS ends a recognition task (a pause, or its ~1-minute limit)
///    the recognizer restarts on the same audio, keeping every word;
///  - a pause of up to `pauseTolerance` seconds (3 by default; the
///    `dictationPauseSeconds` user default overrides it) keeps listening —
///    only a longer silence after speech ends the dictation, and even then
///    the words go to the input field, never sent;
///  - tapping the mic or Send finishes it; a later dictation appends to
///    what's already in the field;
///  - filler words and stutters don't split the message (TranscriptJoiner).
///
/// On iOS 26 recognition runs on SpeechAnalyzer (SpeechTranscriber — built
/// for long-form, continuous audio) when the device supports it, with
/// SFSpeechRecognizer as the fallback; on-device either way when the
/// hardware can. The panel shows a live waveform and the elapsed time.
@MainActor
@Observable
final class SpeechRecognizer {
    enum State: Equatable {
        case idle
        case listening
        case denied
        case unavailable
    }

    /// One transcribed word. Position-stable ids: earlier words keep theirs
    /// as the text grows, so only new words fade in.
    struct Word: Identifiable, Equatable {
        let id: Int
        let text: String
    }

    private(set) var state: State = .idle
    private(set) var transcript = ""
    private(set) var words: [Word] = []
    /// Smoothed input level, 0…1 — the mic pulse.
    private(set) var level: Double = 0
    /// The last few dozen levels, oldest first — the waveform.
    private(set) var levels: [Double] = Array(repeating: 0, count: SpeechRecognizer.waveformSamples)
    /// When this dictation started — the elapsed time.
    private(set) var startedAt: Date?
    /// Quiet for a moment after speaking: still listening, and the panel
    /// says so ("tap to finish") rather than counting down.
    private(set) var isPausing = false
    /// Set when listening ends with words captured; the sheet moves it into
    /// the input field (editable before send) and calls `acknowledge()`.
    private(set) var finishedTranscript: String?
    /// Which engine is transcribing ("analyzer" | "legacy" | "scripted") —
    /// Diagnostics and tests read it.
    private(set) var engineName: String?
    /// Transparent restarts in this dictation (iOS ended a task; the words
    /// were kept and a new task picked up).
    private(set) var restartCount = 0

    static let waveformSamples = 32
    /// How long a pause after speech may last before the dictation ends.
    let pauseTolerance: TimeInterval
    /// Before any speech, how long to wait for the first word.
    let initialSilenceLimit: TimeInterval
    static let pauseToleranceKey = "dictationPauseSeconds"
    static let defaultPauseTolerance: TimeInterval = 3
    /// Quiet this long (and some speech captured) shows "still listening".
    private static let pausingAfter: TimeInterval = 1
    /// A bound on transparent restarts per dictation, so a recognizer that
    /// fails instantly can't spin.
    private static let maxRestarts = 30

    private var session = DictationTranscript()
    private var engine: (any DictationEngine)?
    private var lastActivityAt = Date()
    private var heardSpeech = false
    private var silenceWatchdog: Task<Void, Never>?
    /// True from the moment start() is entered until it resolves — the
    /// permission awaits suspend with state still .idle, and a second mic
    /// tap in that window must not double-install the audio tap (an
    /// uncatchable AVFoundation exception).
    private var isStarting = false
    /// Set when stop() lands DURING that startup window. stop() can't tear
    /// down a session that doesn't exist yet (state is still .idle, so it
    /// returns early), so start() checks this at each resume point and
    /// bails out instead — otherwise dismissing the sheet while the
    /// permission alert is up installs a tap and activates the .record
    /// session for a view that's already gone, leaving the mic hot and
    /// other apps ducked until the next launch.
    private var startCancelled = false
    #if DEBUG
    /// Tests inject a scenario directly; the UserDefaults path is for UI
    /// tests only and is gated on the -uiTesting launch flag. Neither
    /// exists in a Release build.
    private let scenarioOverride: SpeechMockScenario?
    #endif
    /// The permission gate (speech + mic), injectable so a test can hold
    /// it suspended and exercise a dismissal while the alert is up.
    private let requestPermissions: @Sendable () async -> Bool

    #if DEBUG
    init(
        scenarioOverride: SpeechMockScenario? = nil,
        requestPermissions: (@Sendable () async -> Bool)? = nil,
        pauseTolerance: TimeInterval? = nil,
        initialSilenceLimit: TimeInterval = 8
    ) {
        self.scenarioOverride = scenarioOverride
        self.requestPermissions = requestPermissions ?? Self.systemPermissions
        self.pauseTolerance = pauseTolerance ?? Self.configuredPauseTolerance()
        self.initialSilenceLimit = initialSilenceLimit
    }
    #else
    init() {
        requestPermissions = Self.systemPermissions
        pauseTolerance = Self.configuredPauseTolerance()
        initialSilenceLimit = 8
    }
    #endif

    /// The `dictationPauseSeconds` user default when set (1–30 s), else 3.
    private static func configuredPauseTolerance() -> TimeInterval {
        let configured = UserDefaults.standard.double(forKey: pauseToleranceKey)
        return configured > 0 ? min(max(configured, 1), 30) : defaultPauseTolerance
    }

    /// The real prompts: speech recognition, then the microphone. The
    /// speech ask goes through the nonisolated bridge, never a closure
    /// formed in this @MainActor context: SFSpeechRecognizer calls its
    /// handler on a background queue, and an isolation-inheriting closure
    /// traps there under Swift 6 the moment the user taps Allow.
    private static let systemPermissions: @Sendable () async -> Bool = {
        let speechGranted = await SpeechRecognizer.bridgeAuthorization { done in
            SFSpeechRecognizer.requestAuthorization { status in
                done(status == .authorized)
            }
        }
        let micGranted = await AVAudioApplication.requestRecordPermission()
        return speechGranted && micGranted
    }

    func acknowledge() {
        finishedTranscript = nil
    }

    func start() async {
        guard state != .listening, !isStarting else { return }
        isStarting = true
        startCancelled = false
        defer { isStarting = false }
        session = DictationTranscript()
        publish()
        level = 0
        levels = Array(repeating: 0, count: Self.waveformSamples)
        isPausing = false
        heardSpeech = false
        restartCount = 0
        finishedTranscript = nil

        #if DEBUG
        // Scripted sessions — no engine, no permission prompts,
        // deterministic timing.
        if let scenario = scenarioOverride ?? SpeechMockScenario.fromDefaults() {
            switch scenario {
            case .denied: state = .denied
            case .unavailable: state = .unavailable
            case .scripted, .continuity:
                begin(ScriptedDictationEngine(steps: scenario.steps), name: "scripted")
            }
            return
        }
        #endif

        let granted = await requestPermissions()
        // The sheet may have been dismissed while the alert was up. Bail
        // before touching the audio session.
        if startCancelled { return }
        guard granted else {
            state = .denied
            return
        }
        let locale = Locale(identifier: "en-US")
        var chosen: (engine: any DictationEngine, name: String)?
        if #available(iOS 26, *), let analyzer = await AnalyzerDictationEngine.make(locale: locale) {
            chosen = (analyzer, "analyzer")
        } else if let legacy = LegacyDictationEngine(locale: locale) {
            chosen = (legacy, "legacy")
        }
        if startCancelled { return }
        guard let chosen else {
            state = .unavailable
            return
        }
        begin(chosen.engine, name: chosen.name)
    }

    private func begin(_ engine: any DictationEngine, name: String) {
        self.engine = engine
        engineName = name
        do {
            try engine.start { [weak self] event in self?.handle(event) }
        } catch {
            // start() tears its own half-built audio down on a throw.
            self.engine = nil
            state = .unavailable
            return
        }
        state = .listening
        startedAt = Date()
        lastActivityAt = Date()
        startSilenceWatchdog()
    }

    // MARK: - Off-main framework callbacks

    /// Bridges a callback-style permission ask into async. `nonisolated`
    /// with `@Sendable` closures on purpose: the framework may invoke the
    /// handler on any queue, and a non-Sendable closure formed inside this
    /// @MainActor class inherits main-actor isolation — under Swift 6 that
    /// traps when called off-main (reproduced twice on device with
    /// SFSpeechRecognizer.requestAuthorization). Kept generic so the unit
    /// test can fire the callback from a background queue.
    nonisolated static func bridgeAuthorization(
        _ request: @escaping @Sendable (@escaping @Sendable (Bool) -> Void) -> Void
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            request { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    /// Stop listening (mic tap, the pause limit, or the sheet closing);
    /// the words are handed off via `finishedTranscript`, never sent.
    func stop() {
        // A stop during startup has no session to tear down yet — mark it
        // so start() aborts at its next resume point instead of bringing
        // up a mic nobody is watching.
        if isStarting { startCancelled = true }
        guard state == .listening else { return }
        let text = tearDown()
        if !text.isEmpty {
            finishedTranscript = text
        }
    }

    /// Send while dictating: stop, and return the words for the message at
    /// once — no hand-off through `finishedTranscript` (that would append
    /// them to the field a second time).
    func finish() -> String {
        guard state == .listening else { return "" }
        return tearDown()
    }

    private func tearDown() -> String {
        silenceWatchdog?.cancel()
        silenceWatchdog = nil
        engine?.stop()
        engine = nil
        session.taskEnded()
        publish()
        level = 0
        isPausing = false
        startedAt = nil
        state = .idle
        return session.text
    }

    /// Denied/unavailable notices offer a retry path: clear back to idle.
    func resetAvailability() {
        if state == .denied || state == .unavailable {
            state = .idle
        }
    }

    // MARK: - Events

    private func handle(_ event: DictationEvent) {
        guard state == .listening else { return }
        switch event {
        case .partial(let text):
            let before = session.text
            session.apply(partial: text)
            noteSpeech(changed: session.text != before)
        case .final(let text):
            let before = session.text
            session.apply(final: text)
            noteSpeech(changed: session.text != before)
        case .level(let newLevel):
            // Fast attack, slow release, so the pulse feels tied to the voice.
            level = newLevel > level ? newLevel : level * 0.82 + newLevel * 0.18
            levels.removeFirst()
            levels.append(newLevel)
            if newLevel > 0.35 { lastActivityAt = Date() }
        case .ended:
            // iOS ended the recognition task (a pause, its time limit, an
            // error): keep every word and start another on the same audio.
            session.taskEnded()
            publish()
            restartEngine()
        }
    }

    private func noteSpeech(changed: Bool) {
        guard changed else { return }
        publish()
        heardSpeech = heardSpeech || !session.isEmpty
        lastActivityAt = Date()
        isPausing = false
    }

    private func restartEngine() {
        guard let engine, restartCount < Self.maxRestarts else {
            stop()
            return
        }
        restartCount += 1
        do {
            try engine.restart()
        } catch {
            stop()
        }
    }

    private func publish() {
        transcript = session.text
        words = transcript
            .split(separator: " ", omittingEmptySubsequences: true)
            .enumerated()
            .map { Word(id: $0.offset, text: String($0.element)) }
    }

    // MARK: - Pauses

    private func startSilenceWatchdog() {
        silenceWatchdog?.cancel()
        silenceWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, self.state == .listening else { return }
                self.tickSilence()
            }
        }
    }

    private func tickSilence() {
        let silence = Date().timeIntervalSince(lastActivityAt)
        guard heardSpeech else {
            // Nothing said yet: a longer wait for the first word, then a
            // quiet stop with nothing to hand off.
            if silence >= initialSilenceLimit { stop() }
            return
        }
        isPausing = silence >= Self.pausingAfter
        if silence >= pauseTolerance { stop() }
    }
}

/// What a recognition engine reports, on the main actor.
enum DictationEvent: Sendable {
    /// The current segment's best guess so far (replaces the last guess).
    case partial(String)
    /// The current segment is done.
    case final(String)
    /// Input level 0…1 (the waveform and the pause detector).
    case level(Double)
    /// The recognition task ended while audio still flows; restart it.
    case ended
}

/// Where an engine reports: the dictation, on the main actor.
typealias DictationSink = @MainActor @Sendable (DictationEvent) -> Void

/// A speech engine the dictation drives: start once, restart a task when
/// one ends (same audio session), stop once.
@MainActor
protocol DictationEngine: AnyObject {
    func start(onEvent: @escaping DictationSink) throws
    func restart() throws
    func stop()
}

// MARK: - SFSpeechRecognizer (every iOS)

/// The request a tap on the audio thread feeds — swapped for a new one on
/// every restart, so the same audio keeps flowing into the live task.
private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        defer { lock.unlock() }
        self.request = request
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let request = self.request
        lock.unlock()
        request?.append(buffer)
    }
}

/// RMS power → 0…1 against a speaking-voice dB window.
private func normalizedLevel(of buffer: AVAudioPCMBuffer) -> Double {
    guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    let frames = Int(buffer.frameLength)
    var sum: Float = 0
    for i in 0..<frames {
        sum += data[i] * data[i]
    }
    let rms = sqrt(sum / Float(frames))
    let db = 20 * log10(max(rms, .leastNormalMagnitude))
    // -50 dB (room tone) … -10 dB (speaking close to the mic).
    return Double(min(max((db + 50) / 40, 0), 1))
}

/// Puts the .record session up; the engines share it.
private func activateRecordSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: .duckOthers)
    try session.setActive(true, options: .notifyOthersOnDeactivation)
}

private func deactivateRecordSession() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
}

@MainActor
final class LegacyDictationEngine: DictationEngine {
    private let recognizer: SFSpeechRecognizer
    private let audioEngine = AVAudioEngine()
    private let box = RequestBox()
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var onEvent: DictationSink?
    /// Callbacks from a task that's been replaced are ignored.
    private var generation = 0

    init?(locale: Locale) {
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            return nil
        }
        self.recognizer = recognizer
    }

    func start(onEvent: @escaping DictationSink) throws {
        self.onEvent = onEvent
        do {
            try activateRecordSession()
            // The tap block runs on a realtime audio thread — installed via
            // the nonisolated helper so it never inherits main-actor
            // isolation (same trap class as the authorization handler).
            Self.installTap(on: audioEngine.inputNode, box: box) { level in
                Task { @MainActor in onEvent(.level(level)) }
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            // A half-set-up engine must be torn down here: leaving the tap
            // installed makes the user-invited retry crash on the second
            // installTap, and leaving the .record session active keeps
            // other apps' audio ducked.
            stop()
            throw error
        }
        beginTask()
    }

    func restart() throws {
        task?.cancel()
        beginTask()
    }

    private func beginTask() {
        generation += 1
        let current = generation
        let request = SFSpeechAudioBufferRecognitionRequest()
        // On-device when the hardware can: dictation stays on the phone.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        request.shouldReportPartialResults = true
        // Punctuation at every pause would split the message ("at
        // Seaport. At 7 PM"); the joiner handles sentences.
        request.addsPunctuation = false
        box.set(request)
        task = Self.startRecognition(recognizer: recognizer, request: request) { [weak self] text, segmentDone, taskEnded in
            Task { @MainActor [weak self] in
                guard let self, self.generation == current, let onEvent = self.onEvent else { return }
                if let text {
                    onEvent(segmentDone ? .final(text) : .partial(text))
                }
                if taskEnded { onEvent(.ended) }
            }
        }
    }

    func stop() {
        generation += 1
        task?.finish()
        task = nil
        box.set(nil)
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        deactivateRecordSession()
        onEvent = nil
    }

    private nonisolated static func installTap(
        on input: AVAudioInputNode,
        box: RequestBox,
        onLevel: @escaping @Sendable (Double) -> Void
    ) {
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            box.append(buffer)
            onLevel(normalizedLevel(of: buffer))
        }
    }

    /// Starts the recognition task from a nonisolated context; only the
    /// (Sendable) text and two flags cross back. A result carrying
    /// `speechRecognitionMetadata` ends a segment (the recognizer saw a
    /// pause) even when the task carries on; `isFinal` or an error ends
    /// the task itself.
    private nonisolated static func startRecognition(
        recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest,
        onUpdate: @escaping @Sendable (String?, Bool, Bool) -> Void
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            let final = result?.isFinal ?? false
            onUpdate(
                result.map { $0.bestTranscription.formattedString },
                final || result?.speechRecognitionMetadata != nil,
                final || error != nil
            )
        }
    }
}

// MARK: - SpeechAnalyzer (iOS 26)

/// Converts the mic's buffers to the analyzer's format on the audio
/// thread and hands them to the analyzer's input stream.
@available(iOS 26, *)
private final class AnalyzerFeed: @unchecked Sendable {
    private let converter: AVAudioConverter?
    private let format: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    init(from input: AVAudioFormat, to format: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation) {
        self.converter = input == format ? nil : AVAudioConverter(from: input, to: format)
        self.format = format
        self.continuation = continuation
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let converter else {
            continuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil, out.frameLength > 0 {
            continuation.yield(AnalyzerInput(buffer: out))
        }
    }

    func finish() {
        continuation.finish()
    }
}

@available(iOS 26, *)
@MainActor
final class AnalyzerDictationEngine: DictationEngine {
    private let locale: Locale
    /// The format the transcriber wants, asked once when the engine is made.
    private let targetFormat: AVAudioFormat?
    private let audioEngine = AVAudioEngine()
    private var tapInstalled = false
    private var analyzer: SpeechAnalyzer?
    private var feed: AnalyzerFeed?
    private var results: Task<Void, Never>?
    private var onEvent: DictationSink?
    private var generation = 0

    private init(locale: Locale, targetFormat: AVAudioFormat?) {
        self.locale = locale
        self.targetFormat = targetFormat
    }

    /// An engine when this device can transcribe `locale` on SpeechAnalyzer
    /// with its model already installed; nil → the fallback. A missing
    /// model starts downloading in the background instead of holding the
    /// mic tap hostage — this dictation runs on the fallback, a later one
    /// on SpeechAnalyzer.
    static func make(locale: Locale) async -> AnalyzerDictationEngine? {
        guard SpeechTranscriber.isAvailable,
              let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
        else { return nil }
        let probe = SpeechTranscriber(
            locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: []
        )
        do {
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
                Task.detached(priority: .utility) { try? await install.downloadAndInstall() }
                return nil
            }
        } catch {
            return nil
        }
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe])
        return AnalyzerDictationEngine(locale: supported, targetFormat: format)
    }

    func start(onEvent: @escaping DictationSink) throws {
        self.onEvent = onEvent
        do {
            try activateRecordSession()
            startAnalysis()
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            stop()
            throw error
        }
    }

    /// A new transcriber and analyzer on the running audio (the old ones'
    /// results stream ended).
    func restart() throws {
        results?.cancel()
        feed?.finish()
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        startAnalysis()
    }

    private func startAnalysis() {
        generation += 1
        let current = generation
        let transcriber = SpeechTranscriber(
            locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: []
        )
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let input = audioEngine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        let feed = AnalyzerFeed(from: inputFormat, to: targetFormat ?? inputFormat, continuation: continuation)
        self.feed = feed
        Self.installTap(on: input, feed: feed) { [weak self] level in
            Task { @MainActor [weak self] in self?.onEvent?(.level(level)) }
        }
        tapInstalled = true
        // Analysis and its results run side by side: the results stream is
        // read from the first word, whatever start() does while it runs.
        let started = Task {
            try await analyzer.start(inputSequence: stream)
        }
        results = Task { [weak self] in
            do {
                // Volatile results replace each other; a final one closes
                // its stretch of audio — DictationTranscript appends them.
                for try await result in transcriber.results {
                    guard let self, self.generation == current else { return }
                    let text = String(result.text.characters)
                    self.onEvent?(result.isFinal ? .final(text) : .partial(text))
                }
                // The stream ended without an error: if start() failed, that
                // is why.
                _ = try await started.value
            } catch {
                // Falls through to "ended": the dictation restarts it.
            }
            guard let self, self.generation == current else { return }
            self.onEvent?(.ended)
        }
    }

    func stop() {
        generation += 1
        results?.cancel()
        results = nil
        feed?.finish()
        feed = nil
        if let analyzer {
            Task { await analyzer.cancelAndFinishNow() }
        }
        analyzer = nil
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        deactivateRecordSession()
        onEvent = nil
    }

    private nonisolated static func installTap(
        on input: AVAudioInputNode,
        feed: AnalyzerFeed,
        onLevel: @escaping @Sendable (Double) -> Void
    ) {
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            feed.feed(buffer)
            onLevel(normalizedLevel(of: buffer))
        }
    }
}

// MARK: - Scripted sessions (tests only)

#if DEBUG
/// Plays a scripted dictation through the SAME event path as the real
/// engines — so the tests exercise the transcript, restart, and pause
/// rules, not a shortcut around them.
@MainActor
final class ScriptedDictationEngine: DictationEngine {
    enum Step {
        case partial(String)
        case final(String)
        /// The recognition task ends (the engine then expects a restart).
        case taskEnds
        /// Quiet input for this long.
        case silence(TimeInterval)
        /// Speech-level input for this long (background talk, a breath).
        case noise(TimeInterval)
        /// Keep sending speech-level input until stopped.
        case holdOpen
    }

    private let steps: [Step]
    private var run: Task<Void, Never>?
    private(set) var restarts = 0

    init(steps: [Step]) {
        self.steps = steps
    }

    func start(onEvent: @escaping DictationSink) throws {
        run = Task { @MainActor in
            for step in steps {
                if Task.isCancelled { return }
                switch step {
                case .partial(let text):
                    try? await Task.sleep(for: .milliseconds(140))
                    onEvent(.level(0.7))
                    onEvent(.partial(text))
                case .final(let text):
                    try? await Task.sleep(for: .milliseconds(140))
                    onEvent(.final(text))
                case .taskEnds:
                    onEvent(.ended)
                case .silence(let seconds):
                    await Self.levels(0.05, for: seconds, onEvent)
                case .noise(let seconds):
                    await Self.levels(0.6, for: seconds, onEvent)
                case .holdOpen:
                    while !Task.isCancelled { await Self.levels(0.6, for: 1, onEvent) }
                }
            }
            // The script ran out: quiet from here, so the pause rule decides.
            while !Task.isCancelled { await Self.levels(0.05, for: 1, onEvent) }
        }
    }

    func restart() throws {
        restarts += 1
    }

    func stop() {
        run?.cancel()
        run = nil
    }

    private static func levels(
        _ level: Double,
        for seconds: TimeInterval,
        _ onEvent: DictationSink
    ) async {
        let ticks = max(1, Int(seconds / 0.15))
        for _ in 0..<ticks {
            if Task.isCancelled { return }
            onEvent(.level(level))
            try? await Task.sleep(for: .milliseconds(150))
        }
    }
}

/// `-speechScenario <name>` launch override (see LaunchOverrides).
enum SpeechMockScenario: String {
    /// Words stream in, then a silence past the pause limit ends it.
    case scripted
    /// One continuous dictation across a finished segment, an ended task
    /// (restarted transparently), a pause inside the limit, fillers and a
    /// stutter, and a recognizer that silently starts a new segment — held
    /// open until the user taps the mic.
    case continuity
    case denied
    case unavailable

    static let defaultsKey = "speechScenario"

    /// What the continuity scenario ends up saying.
    static let continuityText = "Find me parking at Seaport at 7 PM near Lola 42 for three hours"

    var steps: [ScriptedDictationEngine.Step] {
        switch self {
        case .scripted:
            return "Park me near the MFA at 2 for two hours"
                .split(separator: " ")
                .reduce(into: [ScriptedDictationEngine.Step]()) { steps, word in
                    let prior: String = {
                        if case .partial(let text)? = steps.last { return text + " " }
                        return ""
                    }()
                    steps.append(.partial(prior + word))
                }
        case .continuity:
            return [
                .partial("Find"),
                .partial("Find me parking"),
                .partial("Find me parking at Seaport"),
                .final("Find me parking at Seaport."),
                // iOS ends the task at the pause; a new one picks up.
                .taskEnds,
                // A pause inside the default 3-second limit.
                .silence(2.0),
                .partial("Um"),
                .partial("Um, at 7 PM"),
                .partial("Um, at 7 PM near near Lola 42"),
                // A recognizer that starts over without a final.
                .partial("For three"),
                .partial("For three hours"),
                .holdOpen,
            ]
        case .denied, .unavailable:
            return []
        }
    }

    /// UI-test launches only: the key persists in UserDefaults after a
    /// test run, and unlike the other scenario keys (consumed inside
    /// MockAPI) this one would rewire the REAL recognizer — so a normal
    /// launch must never read it.
    static func fromDefaults() -> SpeechMockScenario? {
        guard LaunchOverrides.uiTesting else { return nil }
        guard let raw = UserDefaults.standard.string(forKey: defaultsKey) else { return nil }
        return SpeechMockScenario(rawValue: raw)
    }
}
#endif
