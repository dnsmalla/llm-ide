import Foundation
import AppKit

/// NSSpeechRecognizer wrapper for macOS voice input.
/// Handles macOS speech-to-text lifecycle, similar to extension's Web Speech API.
/// Note: macOS NSSpeechRecognizer is limited compared to iOS SpeechRecognition.
/// For production, consider using Whisper API via Claude CLI as fallback.
@MainActor
final class VoiceInputService: NSObject, NSSpeechRecognizerDelegate {

    /// Called with final transcribed text when user stops speaking.
    var onFinalResult: ((String) -> Void)?
    /// Called when error occurs (recognition failed, etc).
    var onError: ((String) -> Void)?

    private var recognizer: NSSpeechRecognizer?
    private var isListening = false

    override init() {
        super.init()
        setupRecognizer()
    }

    /// Initialize NSSpeechRecognizer with delegate.
    private func setupRecognizer() {
        recognizer = NSSpeechRecognizer()
        recognizer?.delegate = self
    }

    /// Start listening for speech. Returns true if started successfully.
    func startListening() -> Bool {
        guard !isListening else {
            onError?("Already listening")
            return false
        }

        guard let recognizer else {
            onError?("Speech recognizer not initialized")
            return false
        }

        // Attempt to start recognition
        recognizer.startListening()
        isListening = true
        return true
    }

    /// Stop listening and finalize any pending transcript.
    func stopListening() {
        recognizer?.stopListening()
        isListening = false
    }

    /// Cancel recognition without finalizing.
    func cancel() {
        recognizer?.stopListening()
        isListening = false
    }

    /// Current listening state.
    var isActive: Bool { isListening }

    // MARK: - NSSpeechRecognizerDelegate

    /// Called when a recognized command/phrase is detected.
    func speechRecognizer(_ sender: NSSpeechRecognizer, didRecognizeCommand command: String) {
        // macOS NSSpeechRecognizer primarily works with pre-defined command sets.
        // For freeform dictation, use Whisper API fallback.
    }

    /// Called when recognition completes — final transcribed text available.
    nonisolated func speechRecognizer(_ sender: NSSpeechRecognizer, didFinishRecognition: String) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.isListening = false
            if !didFinishRecognition.isEmpty {
                self.onFinalResult?(didFinishRecognition)
            }
        }
    }

    /// Called when recognition error occurs.
    nonisolated func speechRecognizer(_ sender: NSSpeechRecognizer, didFinishRecognitionWithCommand command: String) {
        // Fallback: treat as final result if available
        Task { @MainActor [weak self] in
            guard let self else { return }
            if !command.isEmpty {
                self.onFinalResult?(command)
            }
            self.isListening = false
        }
    }
}
