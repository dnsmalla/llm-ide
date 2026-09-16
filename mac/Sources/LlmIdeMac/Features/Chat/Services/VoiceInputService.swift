import Foundation
import Speech
import AVFoundation
import os.log

/// Freeform voice-to-text via Apple's Speech framework (`SFSpeechRecognizer`)
/// + `AVAudioEngine` mic tap. Replaces the earlier `NSSpeechRecognizer`
/// wrapper — that API is for discrete spoken *commands*, returns `nil` when
/// Enhanced Dictation language packs aren't installed, and never delivered
/// freeform transcripts into the chat composer.
@MainActor
final class VoiceInputService: NSObject {

    /// Final transcript when recognition completes or the user stops.
    var onFinalResult: ((String) -> Void)?
    /// Partial transcript while the user is still speaking.
    var onPartialResult: ((String) -> Void)?
    /// Called when recognition / mic / permission fails.
    var onError: ((String) -> Void)?

    private let log = Logger(subsystem: "com.llmide.macapp", category: "VoiceInput")
    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var isListening = false
    /// Last non-empty transcript seen this session — emitted as final on stop.
    private var latestTranscript = ""

    override init() {
        super.init()
        recognizer = SFSpeechRecognizer()
    }

    /// Current listening state.
    var isActive: Bool { isListening }

    /// Request mic + speech permissions (if needed), then start recognition.
    /// Returns `true` only when the audio engine is running.
    func startListening() async -> Bool {
        guard !isListening else {
            onError?("Already listening")
            return false
        }

        let speechOk = await ensureSpeechAuthorized()
        guard speechOk else { return false }

        let micOk = await ensureMicrophoneAuthorized()
        guard micOk else { return false }

        guard let recognizer, recognizer.isAvailable else {
            onError?("Speech recognition is unavailable for this locale. Enable Dictation in System Settings → Keyboard.")
            return false
        }

        do {
            try beginRecognition(with: recognizer)
            isListening = true
            return true
        } catch {
            log.error("voice_start_failed err=\(error.localizedDescription, privacy: .public)")
            teardown()
            onError?("Failed to start voice input: \(error.localizedDescription)")
            return false
        }
    }

    /// Stop listening and deliver the latest transcript as final (if any).
    func stopListening() {
        guard isListening else { return }
        let text = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        teardown()
        if !text.isEmpty {
            onFinalResult?(text)
        }
    }

    /// Cancel without delivering a final result.
    func cancel() {
        teardown()
    }

    // MARK: - Permissions

    private func ensureSpeechAuthorized() async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        switch status {
        case .authorized:
            return true
        case .denied, .restricted:
            onError?("Speech recognition is denied. Enable it in System Settings → Privacy & Security → Speech Recognition.")
            return false
        case .notDetermined:
            let granted = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                SFSpeechRecognizer.requestAuthorization { newStatus in
                    cont.resume(returning: newStatus == .authorized)
                }
            }
            if !granted {
                onError?("Speech recognition permission was not granted.")
            }
            return granted
        @unknown default:
            onError?("Speech recognition status unknown.")
            return false
        }
    }

    private func ensureMicrophoneAuthorized() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .denied, .restricted:
            onError?("Microphone access is denied. Enable it in System Settings → Privacy & Security → Microphone.")
            return false
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            if !granted {
                onError?("Microphone permission was not granted.")
            }
            return granted
        @unknown default:
            onError?("Microphone status unknown.")
            return false
        }
    }

    // MARK: - Engine

    private func beginRecognition(with recognizer: SFSpeechRecognizer) throws {
        teardownEngineOnly()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = false
        recognitionRequest = request
        latestTranscript = ""

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw VoiceInputError.invalidAudioFormat
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            // Capture `request` (not `self`) — tap runs off the main actor.
            request.append(buffer)
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    self.latestTranscript = text
                    if result.isFinal {
                        // stopListening() may already have delivered + torn down.
                        guard self.isListening else { return }
                        let finalText = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        self.teardown()
                        if !finalText.isEmpty {
                            self.onFinalResult?(finalText)
                        }
                    } else if self.isListening {
                        self.onPartialResult?(text)
                    }
                }
                if let error, self.isListening {
                    let ns = error as NSError
                    // Ignore expected cancellation after stopListening.
                    if ns.domain == "kAFAssistantErrorDomain", ns.code == 216 { return }
                    if ns.code == 1 { return }
                    self.log.error("voice_recognition_error err=\(error.localizedDescription, privacy: .public)")
                    self.teardown()
                    self.onError?("Voice recognition failed: \(error.localizedDescription)")
                }
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
    }

    private func teardown() {
        isListening = false
        teardownEngineOnly()
        latestTranscript = ""
    }

    private func teardownEngineOnly() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }
}

enum VoiceInputError: LocalizedError {
    case invalidAudioFormat

    var errorDescription: String? {
        switch self {
        case .invalidAudioFormat:
            return "No usable microphone input format. Check that a mic is connected and permitted."
        }
    }
}
