import SwiftUI

/// Parsed view of a bash-result chat turn, produced by
/// `CodeAssistant+Bash.swift`'s `"(bash result - exit code: N)\n$ <command>\n<output>"`
/// convention (also matches the `"(bash failed - ...)"` / `"(bash blocked - ...)"`
/// variants). Returns nil for anything that isn't a bash-result turn, so
/// `ChatMessageList` can fall back to the generic tool-notice capsule.
struct BashResultDisplay {
    let exitCode: Int?
    let isFailure: Bool
    let command: String?
    let output: String

    static func parse(_ content: String) -> BashResultDisplay? {
        guard content.hasPrefix("(bash ") else { return nil }
        var lines = content.components(separatedBy: "\n")
        guard !lines.isEmpty else { return nil }
        let header = lines.removeFirst()
        let isFailure = header.contains("failed") || header.contains("blocked")
        var exitCode: Int?
        if let range = header.range(of: "exit code: ") {
            let digits = header[range.upperBound...].prefix { $0.isNumber || $0 == "-" }
            exitCode = Int(digits)
        }
        var command: String?
        if let first = lines.first, first.hasPrefix("$ ") {
            command = String(first.dropFirst(2))
            lines.removeFirst()
        }
        return BashResultDisplay(exitCode: exitCode, isFailure: isFailure, command: command, output: lines.joined(separator: "\n"))
    }
}

/// Collapsible command-output block: always shows the command line and a
/// status glyph; output collapses to the first few lines with a "Show full
/// output" toggle, so a long build/test log doesn't dominate the transcript.
struct CommandOutputView: View {
    let display: BashResultDisplay
    @EnvironmentObject var theme: ThemeStore
    @State private var expanded = false

    private let collapsedLineCount = 6

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
