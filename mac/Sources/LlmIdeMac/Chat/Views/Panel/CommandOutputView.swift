import SwiftUI

/// Display-only value for a bash-result chat turn's four rendered fields.
/// Until Task 10 this was built by re-parsing the
/// `"(bash result - exit code: N)\n$ <command>\n<output>"` convention (and its
/// `"(bash failed - ...)"` / `"(bash blocked - ...)"` variants) out of the
/// message's raw string on every render pass (`BashResultDisplay.parse`,
/// deleted here). That parsing now lives in exactly one place —
/// `ChatMessage.ToolResultPayload.parse` — and runs once, when the ack enters
/// the transcript; this struct just carries the already-typed fields off the
/// message's `toolResult` payload (see `CommandOutputView.init(message:)`).
struct BashResultDisplay {
    let exitCode: Int?
    let isFailure: Bool
    let command: String?
    let output: String
}

/// Collapsible command-output block: always shows the command line and a
/// status glyph; output collapses to the first few lines with a "Show full
/// output" toggle, so a long build/test log doesn't dominate the transcript.
struct CommandOutputView: View {
    let display: BashResultDisplay
    @EnvironmentObject var theme: ThemeStore
    @State private var expanded = false

    private let collapsedLineCount = 6

    /// Builds directly from a `.toolResult` message's typed payload — no
    /// string parsing involved. `message.toolResult` is expected to be a
    /// `.bash` payload (the only caller, `ChatMessageList`, already checks
    /// `payload.kind == .bash` before constructing this view); a nil/missing
    /// payload degrades to an empty, non-failing, command-less block rather
    /// than crashing, since a view initializer must not throw.
    init(message: ChatMessage) {
        let payload = message.toolResult
        self.display = BashResultDisplay(
            exitCode: payload?.exitCode,
            isFailure: payload?.isFailure ?? false,
            command: payload?.command,
            output: payload?.output ?? ""
        )
    }

    private var outputLines: [String] {
        display.output.components(separatedBy: "\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let command = display.command {
                Text("$ \(command)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(theme.current.text)
                    .textSelection(.enabled)
            }
            HStack(spacing: 4) {
                Image(systemName: display.isFailure ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(display.isFailure ? theme.current.danger : theme.current.success)
                Text(display.exitCode.map { "exit \($0)" } ?? (display.isFailure ? "failed" : "done"))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
            }
            if !display.output.isEmpty {
                let shown = expanded ? outputLines : Array(outputLines.prefix(collapsedLineCount))
                Text(shown.joined(separator: "\n"))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                    .textSelection(.enabled)
                if outputLines.count > collapsedLineCount {
                    Button(expanded ? "Show less" : "Show full output") { expanded.toggle() }
                        .buttonStyle(.plain)
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.accent)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: 720, alignment: .leading)
        .background(theme.current.surface2)
        .cornerRadius(6)
    }
}
