import Foundation
import Observation

/// Shared state for voice input UI in chat panel.
/// Tracks recording state, interim text, and animations.
@Observable
final class ChatVoiceState {
    /// Currently recording voice input.
    var isRecording: Bool = false
    /// Interim (partial) transcript while user is speaking, like OpenAI's interface.
    var interimText: String = ""
    /// Error message if recognition failed.
    var error: String?
    /// Time elapsed during recording (for potential UI animations).
    var recordingDuration: TimeInterval = 0

    /// Reset all voice state (called after final result processed).
    func reset() {
        isRecording = false
        interimText = ""
        error = nil
        recordingDuration = 0
    }

    /// Set recording state and clear error.
    func setRecording(_ recording: Bool) {
        isRecording = recording
        if recording {
            error = nil
            recordingDuration = 0
            interimText = ""
        }
    }

    /// Update interim text while listening.
    func updateInterimText(_ text: String) {
        interimText = text
    }

    /// Record an error.
    func setError(_ message: String) {
        error = message
        isRecording = false
    }
}
