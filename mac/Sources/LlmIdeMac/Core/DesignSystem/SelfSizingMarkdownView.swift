import SwiftUI
import WebKit
import AppKit

/// A `WKWebView` that renders markdown via `MarkdownRenderer` and reports its
/// rendered content height back to SwiftUI, so it can be embedded in a
/// vertically-sized chat bubble inside a scroll view (where a plain web view
/// would have no intrinsic height). Links open in the user's browser rather
/// than navigating the embedded view.
/// A `WKWebView` that forwards scroll-wheel events to its enclosing scroll
/// view instead of consuming them. The chat bubble web view is sized to its
/// content (no internal scrolling), but a stock `WKWebView` still captures the
/// scroll gesture — so scrolling with the cursor over a bubble would do nothing
/// and the conversation `ScrollView` wouldn't move. Forwarding to `nextResponder`
/// lets the parent SwiftUI `ScrollView` scroll normally.
final class PassthroughWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        nextResponder?.scrollWheel(with: event)
    }
}

struct SelfSizingMarkdownView: NSViewRepresentable {
    let markdown: String
    let isDark: Bool
    /// Called on the main actor whenever the measured content height changes.
    let onHeight: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // PassthroughWebView forwards scroll-wheel events to the enclosing
        // conversation ScrollView — the view is content-sized, so it must not
        // capture the scroll gesture (see PassthroughWebView above).
        let web = PassthroughWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        context.coordinator.load(into: web, markdown: markdown, isDark: isDark)
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        // Reload only when the inputs actually change, to avoid flicker and
        // height-report churn on unrelated SwiftUI re-renders. On other passes
        // (e.g. a panel-width change) re-measure so the height stays correct as
        // text rewraps — measure() is a no-op unless the height actually moved.
        guard context.coordinator.lastMarkdown != markdown
                || context.coordinator.lastDark != isDark else {
            context.coordinator.measure(web)
            return
        }
        // A THEME change has to rebuild the document (the palette is baked
        // into its <style>), but a pure text change — which is what every
        // streamed chunk is — re-renders in place instead.
        //
        // This is the difference between a chat that feels instant and one
        // that beachballs: `loadHTMLString` re-parses and re-evaluates the
        // ~122 KB of inlined highlight.js on every call, and the transcript
        // hands this view new text ~20 times a second while a reply streams.
        // `applyMarkdown` reuses the loaded document and only re-renders the
        // content element.
        if context.coordinator.lastDark != isDark {
            context.coordinator.load(into: web, markdown: markdown, isDark: isDark)
        } else {
            context.coordinator.applyMarkdown(markdown, to: web)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let parent: SelfSizingMarkdownView
        private(set) var lastMarkdown = ""
        private(set) var lastDark = false
        private var lastReportedHeight: CGFloat = 0
        /// The document has finished loading, so `window.__renderMarkdown`
        /// exists and in-place re-rendering is possible.
        private var documentReady = false
        /// Markdown handed to `applyMarkdown` before the document was ready.
        /// Applied once `didFinish` fires; only the newest one matters.
        private var deferredMarkdown: String?
        /// Set if an in-place render ever fails (a document from before this
        /// function existed, an eval error). From then on this view falls back
        /// to full reloads — correct, just slower, and it can't thrash: the
        /// flag is never cleared while the coordinator lives.
        private var incrementalUnavailable = false
        /// Whether the loaded document shipped the syntax highlighter. A
        /// reply that starts as prose loads without it; if a code fence
        /// later streams in, the document has to be rebuilt to get it.
        private var loadedWithHighlighting = false

        init(_ parent: SelfSizingMarkdownView) { self.parent = parent }

        func load(into web: WKWebView, markdown: String, isDark: Bool) {
            lastMarkdown = markdown
            lastDark = isDark
            documentReady = false
            deferredMarkdown = nil
            loadedWithHighlighting = MarkdownRenderer.needsHighlighting(markdown)
            web.loadHTMLString(
                MarkdownRenderer.html(for: markdown, isDark: isDark, compact: true),
                baseURL: nil
            )
        }

        /// Re-render `markdown` inside the already-loaded document and report
        /// the new height, without reloading the page.
        ///
        /// The text crosses into JavaScript as a `callAsyncJavaScript`
        /// ARGUMENT rather than being spliced into source, so no escaping
        /// question arises here at all — no quoting, no `</script>`, no
        /// template-literal interpolation.
        func applyMarkdown(_ markdown: String, to web: WKWebView) {
            lastMarkdown = markdown
            // A reply that has just grown its first code fence needs the
            // highlighter this document was loaded without — that's a
            // rebuild, not an in-place render. Happens at most once per turn.
            let needsHighlighter = MarkdownRenderer.needsHighlighting(markdown) && !loadedWithHighlighting
            guard !incrementalUnavailable, !needsHighlighter else {
                load(into: web, markdown: markdown, isDark: lastDark)
                return
            }
            guard documentReady else {
                // Still loading: remember the latest text and let didFinish
                // apply it. Intermediate values are dropped on purpose —
                // markdown is absolute, not a delta, so only the newest wins.
                deferredMarkdown = markdown
                return
            }
            web.callAsyncJavaScript(
                "return window.__renderMarkdown(md);",
                arguments: ["md": markdown],
                in: nil,
                in: .page
            ) { [weak self, weak web] result in
                guard let self else { return }
                switch result {
                case .success(let value):
                    self.report(height: value)
                case .failure:
                    // Older document, or the function is missing: fall back
                    // permanently and rebuild once so the user still sees the
                    // current text.
                    self.incrementalUnavailable = true
                    if let web { self.load(into: web, markdown: markdown, isDark: self.lastDark) }
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            documentReady = true
            if let deferred = deferredMarkdown {
                deferredMarkdown = nil
                applyMarkdown(deferred, to: webView)
                return
            }
            measure(webView)
            // Re-measure once after layout settles (web fonts / wrapping).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak webView] in
                guard let webView else { return }
                self?.measure(webView)
            }
        }

        func measure(_ web: WKWebView) {
            web.evaluateJavaScript("document.body.scrollHeight") { [weak self] result, _ in
                self?.report(height: result)
            }
        }

        /// Shared tail of `measure` and `applyMarkdown`: coerce whatever
        /// JavaScript returned into points and publish it if it moved.
        private func report(height value: Any?) {
            let raw = (value as? CGFloat) ?? CGFloat((value as? NSNumber)?.doubleValue ?? 0)
            let h = raw.rounded(.up)
            guard h > 0, abs(h - lastReportedHeight) >= 1 else { return }
            lastReportedHeight = h
            parent.onHeight(h)
        }

        // Keep the embedded document static: the initial loadHTMLString is
        // allowed; any user-initiated link click opens externally.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated,
               let url = navigationAction.request.url,
               url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
