import SwiftUI

/// An assistant reply's markdown, capped so that one long answer cannot
/// stretch the whole transcript: past `maxHeight` the bubble scrolls its own
/// content instead of growing, and the conversation stays navigable.
///
/// The cap lives HERE rather than inside `SelfSizingMarkdownView`, which keeps
/// its one job — render markdown and report how tall it is. Two consequences
/// are the reason for that split:
///
///   * Scrolling still chains the way macOS expects. The web view forwards its
///     scroll wheel to the enclosing scroll view (`PassthroughWebView`), which
///     is now this bubble's own `ScrollView`; when that reaches its end AppKit
///     hands the rest to the transcript behind it. Letting the WEB VIEW scroll
///     its own overflow instead would swallow the gesture at the bubble's
///     edge, and a capped bubble covering half the panel would then be a dead
///     zone for scrolling the conversation.
///   * A reply that is still being written stays visible. A capped bubble is
///     pinned to its bottom while `isStreaming`, so streamed text scrolls into
///     view instead of accumulating below the fold — without the pin, capping
///     makes the live reply INVISIBLE, which is the opposite of what the cap
///     is for.
struct ChatMarkdownBubble: View {
    let markdown: String
    let isDark: Bool
    /// The reply is still being written — keeps a capped bubble pinned to its
    /// bottom so the newest text is the text on screen.
    var isStreaming: Bool = false
    var maxHeight: CGFloat = Self.defaultMaxHeight
    /// Measured content height, owned by the CALLER: the main transcript keeps
    /// it in `ChatEngine.bubbleHeights` keyed by turn, because a row SwiftUI
    /// recreates would otherwise lose it, re-measure from the 24pt floor, and
    /// collapse the bubble as the list scrolls.
    @Binding var contentHeight: CGFloat

    /// Roughly half a default panel — enough that most replies are unaffected,
    /// short enough that a long one doesn't bury the rest of the conversation.
    static let defaultMaxHeight: CGFloat = 400

    /// The height the bubble actually occupies: its content, floored so an
    /// unmeasured bubble still has a row, and capped so a long one scrolls.
    private var renderedHeight: CGFloat { min(max(contentHeight, 24), maxHeight) }

    private var isClipped: Bool { contentHeight > maxHeight }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                SelfSizingMarkdownView(markdown: markdown, isDark: isDark) { h in
                    if contentHeight != h { contentHeight = h }
                }
                .frame(height: max(contentHeight, 24))
                // Zero-height target for the streaming pin below. An anchor
                // rather than a scroll offset so it stays correct while the
                // content is still growing under it.
                Color.clear
                    .frame(height: 0)
                    .id(Self.bottomAnchor)
            }
            // Nothing to scroll when the reply fits: the wheel gesture then
            // passes straight through to the transcript, exactly as it did
            // before the cap existed.
            .scrollDisabled(!isClipped)
            .frame(height: renderedHeight)
            .onHover { isPointerInside = $0 }
            .onChange(of: contentHeight) { _, _ in pinToBottomWhileStreaming(proxy) }
            .onChange(of: markdown) { _, _ in pinToBottomWhileStreaming(proxy) }
        }
    }

    private static let bottomAnchor = "chat-markdown-bubble-bottom"

    /// The pointer is over the bubble — the only way to scroll a capped
    /// bubble on macOS, so it is the signal that the user may be reading
    /// back. Pinning on every chunk (~20×/s) used to undo their scroll the
    /// moment they made it; following resumes when the pointer leaves.
    @State private var isPointerInside = false

    private func pinToBottomWhileStreaming(_ proxy: ScrollViewProxy) {
        guard isStreaming, isClipped, !isPointerInside else { return }
        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
    }
}
