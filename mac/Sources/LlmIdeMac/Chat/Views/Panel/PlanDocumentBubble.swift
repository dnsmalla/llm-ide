import SwiftUI

/// The one-line stand-in for an assistant reply that IS a plan document —
/// the reply to "Write full plan" (see `PlanTranscriptPolicy`).
///
/// A plan document is thousands of words. Rendered as a normal assistant
/// bubble it stands up a WKWebView and re-measures it on every streamed
/// chunk, which is what made a plan-write turn jerk the transcript around
/// for a minute straight — and once the document is saved, the PlanSavedCard
/// directly below shows the same text again with the buttons that act on it.
/// So the bubble collapses to this: a row saying a document is being written,
/// with the size, and a disclosure for anyone who wants to read it here
/// anyway (expanding hands the turn back to the normal markdown renderer via
/// `expandedTurns`).
struct PlanDocumentBubble: View {
    let content: String
    /// True while the document is still streaming in.
    let isStreaming: Bool
    /// Reveals the full markdown render — adds the turn to `expandedTurns`.
    let onExpand: () -> Void

    @EnvironmentObject var theme: ThemeStore

    private var lineCount: Int {
        content.isEmpty ? 0 : content.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    /// The plan's own title, when it already has one — a streaming document
    /// usually gets its `# Heading` out in the first chunk, so this labels
    /// the row with the real plan name almost immediately.
    private var title: String? {
        for line in content.split(separator: "\n").prefix(6) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("#") {
                let stripped = t.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                if !stripped.isEmpty { return stripped }
            }
        }
        return nil
    }

    private var caption: String {
        if isStreaming {
            return lineCount > 0 ? "Writing… \(lineCount) lines so far" : "Writing…"
        }
        return "\(lineCount) lines · saved to the plan file below"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if isStreaming {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 14, height: 14)
            } else {
                Image(systemName: "doc.text")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.accent)
                    .frame(width: 14, height: 14)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title ?? "Implementation plan")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(theme.current.text)
                    .lineLimit(2)
                Text(caption)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer(minLength: 8)
            // Offered even mid-stream: someone who wants to watch it being
            // written can, they just opt into the cost.
            Button(action: onExpand) {
                Label("Show document", systemImage: "chevron.down")
                    .font(.system(size: 11))
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.plain)
            .foregroundStyle(theme.current.accent)
            .help("Render the full plan here as well as in the card below")
        }
        .padding(10)
        .frame(maxWidth: 720, alignment: .leading)
        .background(theme.current.surface2)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.current.border, lineWidth: 1))
        .cornerRadius(8)
    }
}
