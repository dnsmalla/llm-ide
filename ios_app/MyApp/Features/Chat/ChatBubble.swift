import SwiftUI
import SharedProtocol
import UIKit

/// One chat bubble in a transcript. Renders the user/assistant turn, the
/// "Thinking…" placeholder for an in-flight assistant turn, and an optional
/// image thumbnail above the text (used by the llm-ide surface; explorer
/// messages never carry `imageData` so the `if let` is a clean no-op there).
///
/// Quirks preserved:
/// - User bubble tints with `Colors.primary`; assistant uses `Colors.surface`
///   with a hairline `Colors.border` stroke.
/// - 40pt min-length spacers push each bubble to its side.
/// - `cornerRadiusL` + 10pt vertical / `Spacing.md` horizontal padding; the last bubble of a run of
///   same-sender turns gets a small "tail" corner on its sender's side.
/// - Consecutive turns by one sender are grouped (tight spacing, one tail) instead of each carrying a
///   "You" / "llm-agent" caption; VoiceOver still hears the sender.
struct ChatBubble: View {
    let message: ChatMessage
    /// First bubble of a same-sender run: gets the wider gap above it. Defaults keep a standalone bubble
    /// looking like a complete group.
    var isFirstInGroup: Bool = true
    /// Last bubble of the run: the only one that carries the tail corner.
    var isLastInGroup: Bool = true
    @Environment(\.displayScale) private var displayScale
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
                        .font(DesignSystem.Typography.bodyFont)
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                        .textSelection(.enabled)
                case .code(let language, let body):
                    CodeBlockView(language: language, code: body)
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
        var s = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        // Server-supplied links may carry any scheme (tel:, app schemes); only web links stay tappable.
        for run in s.runs {
            if let url = run.link, !["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                s[run.range].link = nil
            }
        }
        return s
    }

    /// Grouping lives in the bubble (not the parent's stack spacing) so every transcript that renders
    /// `ChatBubble` gets it without repeating the rule.
    var body: some View {
        bubbleRow
            .padding(.top, isFirstInGroup ? DesignSystem.Spacing.sm : 3)
            // The visual caption is gone, so keep attribution for VoiceOver.
            .accessibilityElement(children: .contain)
            .accessibilityLabel(isUser ? "You" : "llm-agent")
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var bubbleShape: BubbleShape {
        BubbleShape(tail: isLastInGroup ? (isUser ? .trailing : .leading) : nil)
    }

    private var bubbleRow: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            Group {
                if isThinking {
                    TypingIndicator()
                } else {
                    VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                        if let data = message.imageData, let ui = UIImage(data: data) {
                            Image(uiImage: ui)
                                .resizable().scaledToFit()
                                .frame(maxWidth: 200, maxHeight: 200)
                                .clipShape(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusS, style: .continuous))
                        }
                        if !message.text.isEmpty {
                            if isUser {
                                // User input is literal — never re-interpret it
                                // as markup.
                                Text(message.text)
                                    .font(DesignSystem.Typography.bodyFont)
                                    .foregroundColor(DesignSystem.Colors.onPrimary)
                                    .textSelection(.enabled)
                            } else if isStreaming {
                                Text(message.text)
                                    .font(DesignSystem.Typography.bodyFont)
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
                // Hairline: a 1pt stroke is 3 device pixels on a 3x screen and reads heavy on a bubble.
                bubbleShape.stroke(isUser ? Color.clear : DesignSystem.Colors.border,
                                   lineWidth: 1 / max(displayScale, 1))
            )
            .clipShape(bubbleShape)
            if !isUser { Spacer(minLength: 40) }
        }
    }
}

// MARK: — Pieces

/// Rounded bubble with one optionally tight corner (the "tail") at the bottom on the sender's side.
/// A custom `Shape` because `UnevenRoundedRectangle` needs iOS 17 and the deployment target is 16.
private struct BubbleShape: Shape {
    enum Tail { case leading, trailing }
    /// nil = all four corners fully round (a bubble in the middle of a group).
    var tail: Tail?

    /// Tail corner radius: tighter than any token on purpose, so the shape reads as a speech bubble.
    private let tailRadius: CGFloat = 5

    func path(in rect: CGRect) -> Path {
        let big = min(DesignSystem.Layout.cornerRadiusL, rect.height / 2, rect.width / 2)
        let small = min(tailRadius, big)
        let topLeft = big, topRight = big
        let bottomLeft = tail == .leading ? small : big
        let bottomRight = tail == .trailing ? small : big
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + topLeft, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - topRight, y: rect.minY))
        // SwiftUI paths are y-down, so `clockwise: false` is the visually clockwise sweep.
        path.addArc(center: CGPoint(x: rect.maxX - topRight, y: rect.minY + topRight), radius: topRight,
                    startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRight))
        path.addArc(center: CGPoint(x: rect.maxX - bottomRight, y: rect.maxY - bottomRight), radius: bottomRight,
                    startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX + bottomLeft, y: rect.maxY))
        path.addArc(center: CGPoint(x: rect.minX + bottomLeft, y: rect.maxY - bottomLeft), radius: bottomLeft,
                    startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + topLeft))
        path.addArc(center: CGPoint(x: rect.minX + topLeft, y: rect.minY + topLeft), radius: topLeft,
                    startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        path.closeSubpath()
        return path
    }
}

/// Three pulsing dots shown in the assistant bubble while a reply has not started streaming.
private struct TypingIndicator: View {
    @State private var animating = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private func pulse(forDot index: Int) -> Animation? {
        if reduceMotion { return nil }
        return Animation.easeInOut(duration: 0.55).repeatForever(autoreverses: true).delay(Double(index) * 0.18)
    }

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(DesignSystem.Colors.textTertiary)
                    .frame(width: 7, height: 7)
                    .scaleEffect(animating ? 1 : 0.55)
                    .opacity(animating ? 1 : 0.4)
                    // Staggered per dot so the pulse travels left to right.
                    .animation(pulse(forDot: index), value: animating)
            }
        }
        .frame(minHeight: 22)
        .onAppear { animating = true }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Thinking")
    }
}

/// A fenced code block with a language tag and a one-tap copy button.
private struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code")
                    .font(DesignSystem.Typography.captionFont.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.textTertiary)
                Spacer(minLength: 0)
                Button(action: copy) {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(DesignSystem.Typography.captionFont.weight(.semibold))
                        .foregroundColor(copied ? DesignSystem.Colors.success : DesignSystem.Colors.textSecondary)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            // Code must not reflow: scroll it instead of wrapping
            // mid-identifier. The row scrolls, never the page.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(DesignSystem.Typography.footnoteFont.monospaced())
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .textSelection(.enabled)
            }
            .padding(.bottom, DesignSystem.Spacing.xs)
        }
        .padding(.horizontal, DesignSystem.Spacing.sm)
        // Deliberately greedy: a code block claims the available
        // width so lines stay readable, unlike prose bubbles which
        // size to content. A horizontal ScrollView has no
        // intrinsic width anyway.
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignSystem.Colors.surfaceSecondary,
                    in: RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusXS, style: .continuous))
    }

    private func copy() {
        UIPasteboard.general.string = code
        copied = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

extension ChatBubble {
    /// Whether the turn at `index` starts / ends a run of same-sender turns.
    static func grouping(in messages: [ChatMessage], at index: Int) -> (isFirst: Bool, isLast: Bool) {
        let role = messages[index].role
        let isFirst = index == 0 || messages[index - 1].role != role
        let isLast = index == messages.count - 1 || messages[index + 1].role != role
        return (isFirst, isLast)
    }
}
