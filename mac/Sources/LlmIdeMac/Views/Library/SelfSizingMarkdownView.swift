import SwiftUI
import WebKit
import AppKit

/// A `WKWebView` that renders markdown via `MarkdownRenderer` and reports its
/// rendered content height back to SwiftUI, so it can be embedded in a
/// vertically-sized chat bubble inside a scroll view (where a plain web view
/// would have no intrinsic height). Links open in the user's browser rather
/// than navigating the embedded view.
struct SelfSizingMarkdownView: NSViewRepresentable {
    let markdown: String
    let isDark: Bool
    /// Called on the main actor whenever the measured content height changes.
    let onHeight: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        // No internal scrolling — the view is sized to its content.
        web.enclosingScrollView?.hasVerticalScroller = false
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
        context.coordinator.load(into: web, markdown: markdown, isDark: isDark)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let parent: SelfSizingMarkdownView
        private(set) var lastMarkdown = ""
        private(set) var lastDark = false
        private var lastReportedHeight: CGFloat = 0

        init(_ parent: SelfSizingMarkdownView) { self.parent = parent }

        func load(into web: WKWebView, markdown: String, isDark: Bool) {
            lastMarkdown = markdown
            lastDark = isDark
            web.loadHTMLString(
                MarkdownRenderer.html(for: markdown, isDark: isDark, compact: true),
                baseURL: nil
            )
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            measure(webView)
            // Re-measure once after layout settles (web fonts / wrapping).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak webView] in
                guard let webView else { return }
                self?.measure(webView)
            }
        }

        func measure(_ web: WKWebView) {
            web.evaluateJavaScript("document.body.scrollHeight") { [weak self] result, _ in
                guard let self else { return }
                let raw = (result as? CGFloat) ?? CGFloat((result as? NSNumber)?.doubleValue ?? 0)
                let h = raw.rounded(.up)
                guard h > 0, abs(h - self.lastReportedHeight) >= 1 else { return }
                self.lastReportedHeight = h
                self.parent.onHeight(h)
            }
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
