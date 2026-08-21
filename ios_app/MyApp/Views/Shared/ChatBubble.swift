import SwiftUI
import UIKit

/// One chat bubble in a transcript. Renders the user/assistant turn, the
/// "Thinking…" placeholder for an in-flight assistant turn, and an optional
/// image thumbnail above the text (used by the llm-ide surface; explorer
/// messages never carry `imageData` so the `if let` is a clean no-op there).
///
/// Factored from `LlmIdeControlView.bubble(_:)` and `ExplorerChatView.bubble(_:)`,
/// which were identical modulo the image branch. Quirks preserved:
/// - User bubble tints with `Colors.primary`; assistant uses `Colors.surface`
///   with a hairline `Colors.border` stroke.
/// - 40pt min-length spacers push each bubble to its side.
/// - `cornerRadiusM` + 10pt vertical / `Spacing.md` horizontal padding.
struct ChatBubble: View {
    let message: ChatMessage
    /// True while this turn is still streaming. Markdown segmentation +
    /// `AttributedString` parsing run inside `body`, so formatting a partial
    /// reply re-parses the whole thing on every chunk — O(n²) on the main
    /// actor, competing with the animated scroll-to-bottom. Stream as plain
    /// text and format once the turn completes.
    var isStreaming: Bool = false

    private var isUser: Bool { message.role == .user }
    private var isThinking: Bool { !isUser && message.text.isEmpty }

    /// Assistant replies carry markdown. `Text` only parses markdown from
    /// string LITERALS, so a runtime string rendered `**bold**`, backticks and
    /// ``` fences verbatim — the Mac formats the same payload. Selectable
    /// because a reply is something users copy out.
    @ViewBuilder
    private var assistantBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Keyed by offset: segment CONTENT repeats legitimately (before/
            // after snippets, the same command twice), and a content-derived id
            // would make ForEach render one and drop the rest.
            ForEach(Array(ChatMarkdown.segments(from: message.text).enumerated()),
                    id: \.offset) { _, segment in
                switch segment {
                case .prose(let text):
                    Text(Self.inlineMarkdown(text))
                        .font(.system(size: DesignSystem.Typography.body))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                        .textSelection(.enabled)
                case .code(let language, let body):
                    VStack(alignment: .leading, spacing: 4) {
                        if let language {
                            Text(language)
                                .font(.system(size: DesignSystem.Typography.caption, weight: .semibold))
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        // Code must not reflow: scroll it instead of wrapping
                        // mid-identifier. The row scrolls, never the page.
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(body)
                                .font(.system(size: DesignSystem.Typography.footnote, design: .monospaced))
                                .foregroundColor(DesignSystem.Colors.textPrimary)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(DesignSystem.Spacing.sm)
                    // Deliberately greedy: a code block claims the available
                    // width so lines stay readable, unlike prose bubbles which
                    // size to content. A horizontal ScrollView has no
                    // intrinsic width anyway.
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(DesignSystem.Colors.surfaceSecondary,
                                in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    /// Inline-only parsing (bold/italic/code/links) with whitespace preserved.
    /// Full-syntax parsing would flatten block structure into one paragraph,
    /// and `ChatMarkdown` has already folded the block markers we care about.
    static func inlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            Group {
                if isThinking {
                    HStack(spacing: 8) {
                        ProgressView().scaleEffect(0.8)
                        Text("Thinking…")
                            .font(.system(size: DesignSystem.Typography.body))
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                    }
                } else {
                    VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                        if let data = message.imageData, let ui = UIImage(data: data) {
                            Image(uiImage: ui)
                                .resizable().scaledToFit()
                                .frame(maxWidth: 200, maxHeight: 200)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        if !message.text.isEmpty {
                            if isUser {
                                // User input is literal — never re-interpret it
                                // as markup.
                                Text(message.text)
                                    .font(.system(size: DesignSystem.Typography.body))
                                    .foregroundColor(.white)
                                    .textSelection(.enabled)
                            } else if isStreaming {
                                Text(message.text)
                                    .font(.system(size: DesignSystem.Typography.body))
                                    .foregroundColor(DesignSystem.Colors.textPrimary)
                                    .textSelection(.enabled)
                            } else {
                                assistantBody
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, DesignSystem.Spacing.md)
            .padding(.vertical, 10)
            .background(isUser ? DesignSystem.Colors.primary : DesignSystem.Colors.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
                    .stroke(isUser ? Color.clear : DesignSystem.Colors.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM))
            if !isUser { Spacer(minLength: 40) }
        }
    }
}
