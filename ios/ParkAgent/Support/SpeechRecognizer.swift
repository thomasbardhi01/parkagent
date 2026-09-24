import AVFoundation
import Foundation
import Observation
import Speech

/// Live dictation for the assistant sheet. Partial results stream in as the
/// user speaks (word list for the per-word fade), the input level drives the
/// mic pulse, and a silence watchdog auto-stops with a visible countdown.
/// On-device recognition when the hardware supports it (nothing leaves the
/// phone); Apple's server recognition otherwise. Stopping — by tap or by
/// silence — hands the transcript to the input field for editing; nothing
/// is ever sent on the user's behalf.
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
    /// as partial results grow, so only new words fade in.
    struct Word: Identifiable, Equatable {
        let id: Int
        let text: String
    }

    private(set) var state: State = .idle
    private(set) var transcript = ""
    private(set) var words: [Word] = []
    /// Smoothed input level, 0…1 — the mic pulse.
    private(set) var level: Double = 0
    /// Seconds left before silence auto-stops (3, 2, 1), nil while speaking.
    private(set) var silenceCountdown: Int?
    /// Set when listening ends with words captured; the sheet moves it into
    /// the input field (editable before send) and calls `acknowledge()`.
    private(set) var finishedTranscript: String?

    /// Silence this long starts the visible countdown…
    private static let silenceGrace: TimeInterval = 1.5
    /// …which runs this many seconds before stopping.
    private static let countdownSeconds = 3

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var task: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var lastActivityAt = Date()
    private var silenceWatchdog: Task<Void, Never>?
    private var scriptedRun: Task<Void, Never>?
    /// True from the moment start() is entered until it resolves — the
    /// permission awaits suspend with state still .idle, and a second mic
    /// tap in that window must not double-install the audio tap (an
    /// uncatchable AVFoundation exception).
    private var isStarting = false
    /// Tests inject a scenario directly; the UserDefaults path is for UI
    /// tests only and is gated on the -uiTesting launch flag.
    private let scenarioOverride: SpeechMockScenario?

    init(scenarioOverride: SpeechMockScenario? = nil) {
        self.scenarioOverride = scenarioOverride
    }

    func acknowledge() {
        finishedTranscript = nil
    }

    func start() async {
        guard state != .listening, !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        transcript = ""
        words = []
        level = 0
        silenceCountdown = nil
        finishedTranscript = nil

        // Scripted sessions — no engine, no permission prompts,
        // deterministic timing.
        if let scenario = scenarioOverride ?? SpeechMockScenario.fromDefaults() {
            startScripted(scenario)
            return
        }

        // Through the nonisolated bridge, never a closure formed in this
        // @MainActor context: SFSpeechRecognizer calls its handler on a
        // background queue, and an isolation-inheriting closure traps there
        // under Swift 6 the moment the user taps Allow.
        let speechGranted = await Self.bridgeAuthorization { done in
            SFSpeechRecognizer.requestAuthorization { status in
                done(status == .authorized)
            }
        }
        let micGranted = await AVAudioApplication.requestRecordPermission()
        guard speechGranted, micGranted else {
            state = .denied
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            state = .unavailable
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        // On-device when the hardware can: dictation stays on the phone.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        request.shouldReportPartialResults = true

        var tapInstalled = false
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = audioEngine.inputNode
            // The tap block runs on a realtime audio thread — installed via
            // the nonisolated helper so it never inherits main-actor
            // isolation (same trap class as the authorization handler).
            Self.installLevelTap(on: input, request: request) { [weak self] level in
                Task { @MainActor [weak self] in self?.ingest(level: level) }
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            // A half-set-up engine must be torn down here: leaving the tap
            // installed makes the user-invited retry crash on the second
            // installTap, and leaving the .record session active keeps
            // other apps' audio ducked.
            if tapInstalled {
                audioEngine.inputNode.removeTap(onBus: 0)
            }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            state = .unavailable
            return
        }

        state = .listening
        lastActivityAt = Date()
        startSilenceWatchdog()
        // Result handler arrives on a Speech-framework queue — same
        // nonisolated treatment; only Sendable strings hop to the actor.
        task = Self.startRecognition(recognizer: recognizer, request: request) { [weak self] transcript, finished in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let transcript {
                    self.ingest(transcript: transcript)
                }
                if finished {
                    self.stop()
                }
            }
        }
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

    /// Installs the level/feed tap from a nonisolated context so the block
    /// carries no actor isolation onto the realtime audio thread.
    private nonisolated static func installLevelTap(
        on input: AVAudioInputNode,
        request: SFSpeechAudioBufferRecognitionRequest,
        onLevel: @escaping @Sendable (Double) -> Void
    ) {
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
            onLevel(normalizedLevel(of: buffer))
        }
    }

    /// Starts the recognition task from a nonisolated context; only the
    /// (Sendable) transcript string and a finished flag cross back.
    private nonisolated static func startRecognition(
        recognizer: SFSpeechRecognizer,
        request: SFSpeechAudioBufferRecognitionRequest,
        onUpdate: @escaping @Sendable (String?, Bool) -> Void
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            onUpdate(
                result.map { $0.bestTranscription.formattedString },
                error != nil || (result?.isFinal ?? false)
            )
        }
    }

    /// Stop listening (tap or watchdog); the transcript is handed off via
    /// `finishedTranscript`, never sent.
    func stop() {
        guard state == .listening else { return }
        scriptedRun?.cancel()
        scriptedRun = nil
        silenceWatchdog?.cancel()
        silenceWatchdog = nil
        task?.finish()
        task = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        level = 0
        silenceCountdown = nil
        state = .idle
        if !transcript.isEmpty {
            finishedTranscript = transcript
        }
    }

    /// Denied/unavailable notices offer a retry path: clear back to idle.
    func resetAvailability() {
        if state == .denied || state == .unavailable {
            state = .idle
        }
    }

    // MARK: - Ingest

    private func ingest(transcript newTranscript: String) {
        guard state == .listening else { return }
        if newTranscript != transcript {
            lastActivityAt = Date()
        }
        transcript = newTranscript
        words = newTranscript
            .split(separator: " ", omittingEmptySubsequences: true)
            .enumerated()
            .map { Word(id: $0.offset, text: String($0.element)) }
    }

    private func ingest(level newLevel: Double) {
        guard state == .listening else { return }
        // Fast attack, slow release, so the pulse feels tied to the voice.
        level = newLevel > level ? newLevel : level * 0.82 + newLevel * 0.18
        if newLevel > 0.35 {
            lastActivityAt = Date()
        }
    }

    /// RMS power → 0…1 against a speaking-voice dB window.
    private nonisolated static func normalizedLevel(of buffer: AVAudioPCMBuffer) -> Double {
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

    // MARK: - Silence watchdog

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
        guard silence >= Self.silenceGrace else {
            silenceCountdown = nil
            return
        }
        let remaining = Double(Self.countdownSeconds) - (silence - Self.silenceGrace)
        if remaining <= 0 {
            stop()
        } else {
            silenceCountdown = Int(remaining.rounded(.up))
        }
    }

    // MARK: - Scripted sessions (UI tests)

    private func startScripted(_ scenario: SpeechMockScenario) {
        switch scenario {
        case .denied:
            state = .denied
        case .unavailable:
            state = .unavailable
        case .scripted:
            state = .listening
            scriptedRun = Task { [weak self] in
                let script = "Park me near the MFA at 2 for two hours"
                for (index, word) in script.split(separator: " ").enumerated() {
                    try? await Task.sleep(for: .milliseconds(140))
                    guard let self, !Task.isCancelled else { return }
                    self.level = index.isMultiple(of: 2) ? 0.7 : 0.4
                    self.ingest(transcript: self.transcript.isEmpty ? String(word) : self.transcript + " " + word)
                }
                // Silence: near-real countdown pacing, slow enough that the
                // test runner reliably sees each state.
                for remaining in stride(from: SpeechRecognizer.countdownSeconds, through: 1, by: -1) {
                    guard let self, !Task.isCancelled else { return }
                    self.level = 0.05
                    self.silenceCountdown = remaining
                    try? await Task.sleep(for: .milliseconds(900))
                }
                guard let self, !Task.isCancelled else { return }
                self.stop()
            }
        }
    }
}

/// `-speechScenario <name>` launch override (see LaunchOverrides).
enum SpeechMockScenario: String {
    case scripted
    case denied
    case unavailable

    static let defaultsKey = "speechScenario"

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
