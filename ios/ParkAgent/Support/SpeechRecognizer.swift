import AVFoundation
import Foundation
import Observation
import Speech

/// Push-to-talk dictation for the assistant sheet. On-device recognition
/// when the device supports it (nothing leaves the phone); Apple's server
/// recognition otherwise. Stopping hands the transcript back.
@MainActor
@Observable
final class SpeechRecognizer {
    enum State: Equatable {
        case idle
        case listening
        case denied
        case unavailable
    }

    private(set) var state: State = .idle
    private(set) var transcript = ""

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var task: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    var available: Bool {
        recognizer?.isAvailable ?? false
    }

    func start() async {
        guard state != .listening else { return }
        transcript = ""
        let speechGranted = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
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

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            state = .unavailable
            return
        }

        state = .listening
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || (result?.isFinal ?? false) {
                    self.stopEngine()
                }
            }
        }
    }

    /// Stop listening; the accumulated transcript stays readable.
    func stop() {
        task?.finish()
        stopEngine()
    }

    private func stopEngine() {
        guard state == .listening else { return }
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        task = nil
        state = .idle
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
