import SwiftUI
import AppKit

/// Chat card for a saved plan (`ToolResultPayload.kind == .plan`): title,
/// where the file landed, a collapsible markdown preview of the plan body,
/// and the two follow-up actions the flow ends in — Execute (switch to
/// Execute mode with the plan attached) and Edit (keep refining in chat).
/// Replaces the bare "(saved plan to …)" capsule, which told the user a file
/// existed somewhere without ever showing the plan.
///
/// Renders entirely from the persisted payload, so a card reloaded from a
/// saved session is identical to one that just arrived live.
struct PlanSavedCard: View {
    let payload: ChatMessage.ToolResultPayload
    /// Wraps `CodeAssistantPanel.executeSavedPlan(_:)`.
    let onExecute: () -> Void
    /// Wraps `CodeAssistantPanel.editSavedPlanInChat()`.
    let onEdit: () -> Void

    @EnvironmentObject var theme: ThemeStore
    @State private var expanded = false
    /// Measured height of the expanded markdown web view (same self-sizing
    /// pattern as the assistant bubble, but state-local — this card doesn't
    /// need the engine's shared height store).
    @State private var markdownHeight: CGFloat = 24

    private static let collapsedLineCount = 12

    private var content: String { payload.planContent ?? "" }

    private var contentLines: [Substring] {
        content.split(separator: "\n", omittingEmptySubsequences: false)
    }

    private var isTruncatable: Bool {
        contentLines.count > Self.collapsedLineCount
    }

    /// "(saved plan to X)" → "X"; falls back to the raw summary if the ack
    /// ever changes shape, so the card never shows an empty caption.
    private var pathCaption: String {
        var s = payload.summary
        if s.hasPrefix("(saved plan to "), s.hasSuffix(")") {
            s.removeFirst("(saved plan to ".count)
            s.removeLast()
        }
        return s
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !content.isEmpty { preview }
            actions
        }
        .padding(12)
        .frame(maxWidth: 720, alignment: .leading)
        .background(theme.current.surface2)
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(theme.current.border, lineWidth: 1)
        )
        .cornerRadius(10)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "list.bullet.clipboard")
                .font(.system(size: 12))
                .foregroundStyle(theme.current.success)
            VStack(alignment: .leading, spacing: 2) {
                Text(payload.planTitle ?? "Plan saved")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                Text(pathCaption)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
            if let path = payload.url {
                Button {
                    NSWorkspace.shared.open(URL(fileURLWithPath: path))
                } label: {
                    Image(systemName: "arrow.up.forward.square")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.current.textMuted)
                .help("Open the saved plan file")
            }
        }
    }

    @ViewBuilder
    private var preview: some View {
        if expanded {
            // Full plan, rendered as real markdown — the same web renderer
            // the assistant bubble uses.
            SelfSizingMarkdownView(markdown: content, isDark: theme.current.isDark) { h in
                if markdownHeight != h { markdownHeight = h }
            }
            .frame(height: max(markdownHeight, 24))
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            // Collapsed: the first lines as plain text — cheap, and enough to
            // recognise the plan without a web view per card in the list.
            Text(contentLines.prefix(Self.collapsedLineCount).joined(separator: "\n"))
                .font(.system(size: 12))
                .foregroundStyle(theme.current.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        // The toggle is offered for EVERY non-empty plan, not just truncated
        // ones: expansion is also what switches from cheap plain text to the
        // real markdown render, and a short plan is exactly where that render
        // is cheapest.
        Button {
            withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
        } label: {
            Label(expanded ? "Show less" : (isTruncatable ? "Show full plan" : "Show formatted"),
                  systemImage: expanded ? "chevron.up" : "chevron.down")
                .font(.system(size: 11))
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.current.accent)
    }

    private var actions: some View {
        HStack(spacing: 8) {
            Button(action: onExecute) {
                Label("Execute plan", systemImage: "bolt.fill")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .help("Switch to Execute mode with this plan attached")
            Button(action: onEdit) {
                Label("Edit in chat", systemImage: "pencil")
                    .font(.system(size: 12))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Keep refining the plan in this chat")
            Spacer(minLength: 0)
        }
    }
}
