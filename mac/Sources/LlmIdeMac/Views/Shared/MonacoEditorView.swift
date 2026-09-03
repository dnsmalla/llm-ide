import SwiftUI

/// Pure decision core for `MonacoEditorView`'s `MonacoHost.onMessage`
/// callback — pulled out so it's unit-testable without a live `WKWebView`,
/// mirroring `WorkspaceRoot.pickGitRoot`'s "pure core, separated for tests"
/// pattern. `MonacoEditorView` applies the returned `Effect`; this function
/// touches no state itself.
enum MonacoEditorMessageHandler {
    enum Effect: Equatable {
        case updateContent(String)
        case requestSave
        /// `.ready` (handled by `MonacoHost.onReady`, not here),
        /// `.cursorMoved`/`.gutterAction`/`.diffHunkAction` (P2/P3) — no
        /// action in P1. Kept as an explicit case, not an unhandled default,
        /// so the switch below stays exhaustive as new message cases arrive.
        case none
    }

    static func effect(for message: MonacoOutboundMessage) -> Effect {
        switch message {
        case .contentChanged(let text):
            return .updateContent(text)
        case .requestSave:
            return .requestSave
        case .ready, .cursorMoved, .gutterAction, .diffHunkAction:
            return .none
        }
    }
}

/// The owning view `MonacoHost`'s own doc comment anticipated: computes
/// `content`/`decorations`/`theme`/`revealRequest`/`readOnly` from its own
/// state and passes them straight into a declarative `MonacoHost(...)` — no
/// coordinator plumbing, the same way a caller already uses
/// `SelfSizingMarkdownView(markdown:isDark:onHeight:)`.
///
/// Content flows two ways but never fights itself: Swift sets `content` on
/// `MonacoHost` only when it actually changes (new file, or an external
/// revert); every keystroke instead arrives as a `.contentChanged` message,
/// which updates `$content` directly. The updated value then round-trips
/// back into `MonacoHost(content: content, ...)` on the next render, but
/// `MonacoHost.Coordinator.applyPendingChanges` only calls `setContent` when
/// its own `lastContent` differs from the incoming value. That no-op
/// guarantee depends on `Coordinator` tracking `lastContent` for BOTH
/// directions, not just outbound pushes: `userContentController(_:didReceive:)`
/// also records `lastContent = text` the moment a `.contentChanged` message
/// arrives (`MonacoHost.swift`), so by the time the round-tripped value comes
/// back through here, `lastContent` already matches it and the diff is a
/// no-op. The bridge only ever pushes a full `setContent` for a genuine
/// external change, never as an echo of what Monaco itself just reported.
///
/// Per design §8: if Monaco doesn't signal `.ready` within 2 seconds
/// (WebView init failure, missing bundled assets), this view falls back to
/// the existing plain `TextEditor` — the pre-P1 implementation becomes the
/// safety net rather than being deleted.
struct MonacoEditorView: View {
    @Binding var content: String
    var language: String = "plaintext"
    var decorations: [Int: GitGutter.Mark] = [:]
    var revealRequest: MonacoRevealRequest? = nil
    var readOnly: Bool = false
    /// Fired when Monaco's Cmd+S command posts `.requestSave` — the caller
    /// owns actually saving (disk I/O, dirty-state bookkeeping), matching
    /// how `EditableTextDetailView.save()` already works.
    var onRequestSave: (() -> Void)? = nil

    @EnvironmentObject private var theme: ThemeStore
    @State private var loadFailed = false
    @State private var didBecomeReady = false
    @State private var readyTimeoutTask: Task<Void, Never>?

    var body: some View {
        Group {
            if loadFailed {
                fallbackEditor
            } else {
                MonacoHost(
                    content: content,
                    language: language,
                    decorations: decorations,
                    theme: theme.current,
                    revealRequest: revealRequest,
                    readOnly: readOnly,
                    onReady: handleReady,
                    onMessage: handleMessage
                )
                .onAppear(perform: startReadyTimeout)
                .onDisappear { readyTimeoutTask?.cancel() }
            }
        }
    }

    /// The pre-P1 implementation, preserved verbatim as the fallback
    /// `MonacoHost`'s own doc comment (design §8) calls for. `readOnly`
    /// still applies here — a failed-to-load preview must not become
    /// silently editable.
    private var fallbackEditor: some View {
        TextEditor(text: $content)
            .font(.system(size: 13, design: .monospaced))
            .textEditorStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(nsColor: .textBackgroundColor))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .disabled(readOnly)
    }

    /// Only ever starts a fresh timeout for a load that hasn't already
    /// succeeded — `onAppear` can re-fire after Monaco is already ready
    /// (navigation, tab switching, SwiftUI re-composition), and since
    /// `.ready` is a one-time event (`MonacoHost` loads its WKWebView once
    /// and never reloads it), a naive restart here would eventually flip
    /// `loadFailed` on a perfectly working editor with no way to recover.
    private func startReadyTimeout() {
        guard !didBecomeReady else { return }
        readyTimeoutTask?.cancel()
        readyTimeoutTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled, !didBecomeReady else { return }
            loadFailed = true
        }
    }

    private func handleReady() {
        didBecomeReady = true
        readyTimeoutTask?.cancel()
    }

    private func handleMessage(_ message: MonacoOutboundMessage) {
        switch MonacoEditorMessageHandler.effect(for: message) {
        case .updateContent(let text):
            content = text
        case .requestSave:
            onRequestSave?()
        case .none:
            break
        }
    }
}
