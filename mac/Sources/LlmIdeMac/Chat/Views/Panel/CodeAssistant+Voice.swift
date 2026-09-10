import SwiftUI

/// Voice input UI extension for CodeAssistantPanel.
/// Adds voice button, keyboard shortcuts, and voice-to-text integration.
extension CodeAssistantPanel {

    /// Voice control button for input bar — microphone icon when idle,
    /// pulsing waveform when recording. Icon-only at the same 24×24 footprint
    /// as its `sendButton`/`contextButton` row siblings — no text label and
    /// no oversized tap target, so it reads as one more inline control
    /// instead of a separate block sitting below the row.
    @ViewBuilder
    var voiceControlButton: some View {
        Button(action: { toggleVoiceInput() }) {
            Image(systemName: voiceState.isRecording ? "waveform" : "mic.fill")
                .font(.system(size: 12, weight: .medium))
                .symbolEffect(.pulse, options: .speed(1.5), isActive: voiceState.isRecording)
                // Dim explicitly while disabled: `.plain` conveys disabled state
                // only by desaturating an INHERITED foreground style, and the
                // explicit color below wins over it — so without this the mic
                // reads fully live mid-turn while click and ⌘M both no-op.
                .foregroundColor(engine.busy
                    ? theme.current.textMuted.opacity(0.4)
                    : (voiceState.isRecording ? theme.current.danger : theme.current.textMuted))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(engine.busy)
        .keyboardShortcut("m", modifiers: .command)
        .help(voiceState.isRecording ? "Stop voice input (Cmd+M)" : "Start voice input (Cmd+M)")
        .accessibilityLabel(voiceState.isRecording ? "Recording" : "Start voice input")
    }

    /// Voice recording indicator bar — slides in when actively recording.
    @ViewBuilder
    var recordingIndicator: some View {
        if voiceState.isRecording {
            HStack {
                Image(systemName: "waveform")
                    .symbolEffect(.variableColor.iterative.reversing, options: .speed(1.5))
                    .foregroundColor(theme.current.danger)
                Text("Listening... (Cmd+M to stop)")
                    .font(Typography.caption)
                    .foregroundColor(theme.current.textMuted)
                Spacer()
            }
            .card(padding: Spacing.sm, radius: Radius.sm)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// Interim text display while user is speaking — shows real-time transcript.
    @ViewBuilder
    var interimTextDisplay: some View {
        if !voiceState.interimText.isEmpty {
            HStack {
                Text(voiceState.interimText)
                    .font(Typography.body)
                    .foregroundColor(theme.current.textMuted)
                    .italic()
                Text("|")
                    .foregroundColor(theme.current.accent)
                    .opacity(0.6)
                    .animation(.easeInOut(duration: 0.5).repeatForever(), value: voiceState.interimText)
                Spacer()
            }
            .card(padding: Spacing.sm, radius: Radius.sm)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// Error banner if voice input failed.
    @ViewBuilder
    var voiceErrorBanner: some View {
        if let error = voiceState.error {
            HStack {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundColor(theme.current.danger)
                Text(error)
                    .font(Typography.caption)
                    .foregroundColor(theme.current.textMuted)
                Spacer()
                Button(action: { voiceState.error = nil }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(theme.current.textMuted)
                }
                .buttonStyle(.plain)
            }
            .card(padding: Spacing.sm, radius: Radius.sm)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    // MARK: - Voice Input Logic

    /// Toggle voice input recording on/off. Cmd+M keyboard shortcut.
    func toggleVoiceInput() {
        if voiceState.isRecording {
            voiceState.setRecording(false)
            voiceService.stopListening()
            return
        }
        Task { @MainActor in
            let started = await voiceService.startListening()
            if started {
                voiceState.setRecording(true)
            } else if voiceState.error == nil {
                // Service already called onError for specific permission / locale
                // failures; only set a generic fallback when nothing else landed.
                voiceState.setError("Failed to start voice input")
            }
        }
    }
}
