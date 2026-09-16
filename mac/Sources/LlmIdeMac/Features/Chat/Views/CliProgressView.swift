import SwiftUI

/// Live progress UI for a running CLI invocation: elapsed counter,
/// scrolling log-tail viewer, and a Cancel button. Used by both the
/// guided CodeWorkflowSheet and the QuickFixSheet so the progress
/// surface is consistent.
struct CliProgressView: View {
    let elapsed: Int
    let logTail: String
    let onCancel: () -> Void

    private var elapsedLabel: String {
        let m = elapsed / 60
        let s = elapsed % 60
        return m > 0 ? "\(m)m \(s)s" : "\(s)s"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Generating changes — \(elapsedLabel)")
                    .foregroundStyle(.secondary)
                    .font(.callout)
                    .monospacedDigit()
                Spacer()
                Button("Cancel", role: .destructive) { onCancel() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    Text(logTail.isEmpty ? "(waiting for CLI output…)" : logTail)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .id("logTailBottom")
                }
                .frame(height: 120)
                .background(Color(.textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
                .onChange(of: logTail) { _, _ in
                    withAnimation(.linear(duration: 0.1)) {
                        proxy.scrollTo("logTailBottom", anchor: .bottom)
                    }
                }
            }
        }
    }
}
