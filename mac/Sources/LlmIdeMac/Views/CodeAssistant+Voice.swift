import SwiftUI

/// Voice input UI extension for CodeAssistantPanel.
/// Adds voice button, keyboard shortcuts, and voice-to-text integration.
extension CodeAssistantPanel {

    /// Voice control button for input bar — microphone icon when idle, waveform when recording.
    @ViewBuilder
    var voiceControlButton: some View {
        Button(action: { toggleVoiceInput() }) {
            HStack(spacing: 4) {
                if voiceState.isRecording {
                    // Recording state: animated waveform
                    Label("Recording", systemImage: "waveform")
                        .symbolEffect(.pulse, options: .speed(1.5))
                        .foregroundColor(.red)
                } else {
                    // Idle state: microphone icon
                    Image(systemName: "mic.fill")
                        .foregroundColor(.gray)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .help("Start voice input (Cmd+M)")
        }
        .disabled(busy)
        .keyboardShortcut("m", modifiers: .command)
    }

    /// Voice recording indicator bar — slides in when actively recording.
    @ViewBuilder
    var recordingIndicator: some View {
        if voiceState.isRecording {
            HStack {
                Image(systemName: "waveform")
                    .symbolEffect(.variableColor.iterative.reversing, options: .speed(1.5))
                    .foregroundColor(.red)
                Text("Listening... (Cmd+M to stop)")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding(8)
            .background(Color(.controlBackgroundColor))
            .cornerRadius(6)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// Interim text display while user is speaking — shows real-time transcript.
    @ViewBuilder
    var interimTextDisplay: some View {
        if !voiceState.interimText.isEmpty {
            HStack {
                Text(voiceState.interimText)
                    .font(.body)
                    .foregroundColor(.secondary)
                    .italic()
                Text("|")
                    .foregroundColor(.blue)
                    .opacity(0.6)
                    .animation(.easeInOut(duration: 0.5).repeatForever(), value: voiceState.interimText)
                Spacer()
            }
            .padding(8)
            .background(Color(.controlBackgroundColor))
            .cornerRadius(6)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// Error banner if voice input failed.
    @ViewBuilder
    var voiceErrorBanner: some View {
        if let error = voiceState.error {
            HStack {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundColor(.orange)
                Text(error)
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
                Button(action: { voiceState.error = nil }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.gray)
                }
                .buttonStyle(.plain)
            }
            .padding(8)
            .background(Color(.controlBackgroundColor))
            .cornerRadius(6)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    // MARK: - Voice Input Logic

    /// Toggle voice input recording on/off. Cmd+M keyboard shortcut.
    func toggleVoiceInput() {
        if voiceState.isRecording {
            // Stop listening
            voiceState.setRecording(false)
            voiceService.stopListening()
        } else {
            // Start listening
            voiceState.setRecording(true)
            let started = voiceService.startListening()
            if !started {
                voiceState.setError("Failed to start voice input")
            }
        }
    }

    // MARK: - Keyboard Shortcuts

    /// Register keyboard shortcuts: Cmd+M for voice, Alt+arrows for mobile.
    func setupKeyboardShortcuts() {
        // Note: SwiftUI's .keyboardShortcut modifier is used on buttons (see voiceControlButton).
        // For modifier combinations (Alt+arrows), we need NSEvent monitoring in the sheet/panel.
        // This is handled via the parent view's event handlers in CodeAssistantPanel.
    }

    /// Handle Alt+arrow keyboard shortcuts for mobile navigation.
    func handleMobileKeyboardShortcut(_ key: String, modifiers: NSEvent.ModifierFlags) {
        guard modifiers.contains(.option) else { return }

        Task {
            switch key {
            case "Up", "↑":
                await mobileRouter?.scrollUp()
            case "Down", "↓":
                await mobileRouter?.scrollDown()
            case "Delete", "⌫":
                // Alt+Backspace = go back
                await mobileRouter?.goBack()
            default:
                break
            }
        }
    }
}
