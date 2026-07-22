import Foundation
import Speech
import AVFoundation

/// On-device speech-to-text for voice control. Publishes a live transcript
/// while listening; the caller takes the final transcript on finish().
@MainActor
final class SpeechRecognizer: ObservableObject {
    @Published var transcript: String = ""
    @Published var isListening: Bool = false
    @Published var errorMessage: String?

    private let recognizer = SFSpeechRecognizer()
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func start() {
        transcript = ""
        errorMessage = nil
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard status == .authorized else {
                    self?.errorMessage = "Speech recognition not allowed. Enable it in Settings → LLM IDE."
                    return
                }
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    Task { @MainActor in
                        guard granted else {
                            self?.errorMessage = "Microphone access needed. Enable it in Settings → LLM IDE."
                            return
                        }
                        self?.beginSession()
                    }
                }
            }
        }
    }

    /// Stop listening and keep the current transcript for the caller.
    func finish() {
        request?.endAudio()
        tearDown()
    }

    /// Stop listening and discard the transcript.
    func cancel() {
        transcript = ""
        tearDown()
    }

    private func beginSession() {
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognition is not available on this device."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                request.requiresOnDeviceRecognition = true
            }

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()

            audioEngine = engine
            self.request = request
            isListening = true

            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in
                    if let result {
                        self?.transcript = result.bestTranscription.formattedString
                    }
                    if error != nil, self?.isListening == true {
                        self?.tearDown()
                    }
                }
            }
        } catch {
            errorMessage = "Could not start the microphone: \(error.localizedDescription)"
            tearDown()
        }
    }

    private func tearDown() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil
        task?.cancel()
        task = nil
        request = nil
        isListening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
