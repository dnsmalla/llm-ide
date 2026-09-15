import SwiftUI
import WebKit

/// One request to scroll the plain editor to a line. Carries an `id` (not
/// just the line number) so setting `revealRequest` to the SAME line twice
/// in a row — e.g. clicking the same search result again — still triggers a
/// fresh call: a bare `Int` would look unchanged to `Coordinator.sync`'s
/// diff the second time.
///
/// Callers MUST hold this value in `@State` (or equivalent) and only
/// construct a fresh one in response to an actual reveal intent (e.g. a
/// user clicking a search result) — never inline inside `body`. Since `id`
/// defaults to a fresh `UUID()` on every construction, an inline
/// `MonacoRevealRequest(line:)` in `body` produces a new id on every
/// SwiftUI re-render, which `Coordinator.sync` reads as a fresh reveal
/// request and causes the editor to unexpectedly re-scroll on every
/// re-render.
struct MonacoRevealRequest: Equatable {
    let line: Int
    let id = UUID()
}

/// One request to show Monaco's diff editor instead of the plain editor.
/// Equatable on its full value (not an id) — showing the identical diff
/// twice is a legitimate no-op, unlike `MonacoRevealRequest`.
struct MonacoDiffRequest: Equatable {
    let original: String
    let modified: String
    let language: String
}

/// Hosts the vendored Monaco editor in a `WKWebView`, loaded ONCE via
/// `loadFileURL` (Monaco is a multi-file asset tree — `loader.js` fetches
/// sibling files by relative path, which `loadHTMLString`'s `baseURL: nil`
/// cannot resolve; `HljsWebView`'s single-inlined-string approach doesn't
/// apply here).
///
/// Purely declarative from the caller's side, exactly like
/// `SelfSizingMarkdownView(markdown:isDark:onHeight:)`: set `content`/
/// `decorations`/`theme`/etc. and SwiftUI's normal re-render cycle applies
/// the change. `Coordinator.sync` diffs each property against what was last
/// actually SENT to Monaco (mirroring `SelfSizingMarkdownView.Coordinator`'s
/// `lastMarkdown`/`lastDark`) and calls only the bridge method for what
/// changed — never a page reload. The bridge methods themselves
/// (`setContent`/`setDecorations`/etc., Task 13) are `private` on
/// `Coordinator`: nothing outside this file calls them directly.
struct MonacoHost: NSViewRepresentable {
    var content: String?
    var language: String = "plaintext"
    var decorations: [Int: GitGutter.Mark] = [:]
    var theme: Theme
    var revealRequest: MonacoRevealRequest?
    var diffRequest: MonacoDiffRequest?
    var readOnly: Bool = false
    /// Fired once, when Monaco has finished loading and `window.__llmide` is
    /// ready to receive calls (mirrors `SelfSizingMarkdownView`'s
    /// `documentReady` gate).
    var onReady: (() -> Void)?
    /// Fired for every message Monaco's bootstrap script posts.
    var onMessage: ((MonacoOutboundMessage) -> Void)?

    /// `Resources/monaco/index.html`, resolved across BOTH places it can
    /// live — mirrors `SourceConnectorManifest.bundledResourceDirectories()`
    /// (`SourceConnectorManifest.swift:158-187`) exactly, because a plain
    /// `Bundle.main.url(...)` (what `Hljs.bundled` does) is confirmed to
    /// silently fail under `swift test` — see that file's doc comment
    /// (lines 110-132) for the full reasoning:
    ///   * Shipped app — `Scripts/build.sh` rsyncs `Resources/` into
    ///     `Contents/Resources/`, so `Bundle.main` finds it directly.
    ///   * `swift test` — `Bundle.main` is the xctest runner and finds
    ///     nothing; the SwiftPM resource bundle
    ///     (`LlmIdeMac_LlmIdeMacLib.bundle`) sits next to the test bundle
    ///     instead, opened here by URL (`Bundle(url:)` returns nil rather
    ///     than trapping, unlike the generated `Bundle.module` accessor —
    ///     never reference `Bundle.module` in this file).
    static func indexURL() -> URL? {
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "monaco") {
            return url
        }
        let bundleName = "LlmIdeMac_LlmIdeMacLib.bundle"
        let owning = Bundle(for: MonacoBundleLocator.self)
        var roots: [URL] = []
        for base in [owning.bundleURL, Bundle.main.bundleURL] {
            roots.append(base)
            roots.append(base.deletingLastPathComponent())
        }
        if let r = owning.resourceURL { roots.append(r) }
        if let r = Bundle.main.resourceURL { roots.append(r) }
        for root in roots {
            guard let bundle = Bundle(url: root.appendingPathComponent(bundleName)) else { continue }
            if let url = bundle.url(forResource: "index", withExtension: "html", subdirectory: "monaco") {
                return url
            }
        }
        return nil
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "monacoBridge")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = web
        if let indexURL = Self.indexURL() {
            web.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.sync(self)
    }

    /// Called by SwiftUI just before the WKWebView is removed from the view
    /// hierarchy. `WKUserContentController` holds a STRONG reference to any
    /// registered script message handler, and `Coordinator` holds a strong
    /// `webView` back-reference — without breaking that cycle here, every
    /// `MonacoHost` teardown would leak the WKWebView (and its loaded Monaco
    /// instance + WebContent process). Mirrors `FileDetailView`'s
    /// `QLPreviewDetailView.dismantleNSView`.
    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        nsView.configuration.userContentController.removeScriptMessageHandler(forName: "monacoBridge")
        coordinator.webView = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        fileprivate var webView: WKWebView?
        private var parent: MonacoHost
        /// Monaco's bootstrap script has posted "ready" — before this, every
        /// bridge call would hit an undefined `window.__llmide`, so
        /// `applyPendingChanges` is skipped and re-run once `didReceive`
        /// sees `.ready` (picking up whatever `parent` was last set to).
        private var documentReady = false
        private var lastContent: String?
        private var lastDecorations: [Int: GitGutter.Mark] = [:]
        private var lastTheme: Theme?
        private var lastRevealRequestId: UUID?
        private var lastDiffRequest: MonacoDiffRequest?
        private var lastReadOnly = false

        init(_ parent: MonacoHost) { self.parent = parent }

        /// Called from `updateNSView` on every SwiftUI re-render.
        func sync(_ newParent: MonacoHost) {
            parent = newParent
            applyPendingChanges()
        }

        private func applyPendingChanges() {
            guard documentReady else { return }
            if let content = parent.content, content != lastContent {
                setContent(content, language: parent.language)
                lastContent = content
            }
            if parent.decorations != lastDecorations {
                setDecorations(parent.decorations)
                lastDecorations = parent.decorations
            }
            if parent.theme != lastTheme {
                setTheme(parent.theme)
                lastTheme = parent.theme
            }
            if let request = parent.revealRequest, request.id != lastRevealRequestId {
                reveal(line: request.line)
                lastRevealRequestId = request.id
            }
            if let diff = parent.diffRequest, diff != lastDiffRequest {
                showDiff(original: diff.original, modified: diff.modified, language: diff.language)
                lastDiffRequest = diff
            }
            if parent.readOnly != lastReadOnly {
                setReadOnly(parent.readOnly)
                lastReadOnly = parent.readOnly
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Monaco's own `require(['vs/editor/editor.main'], ...)` callback
            // posts the "ready" message once the editor module has actually
            // loaded — `didFinish` only means the HTML document loaded, which
            // is earlier. `documentReady` flips on that "ready" message in
            // `userContentController` below, not here.
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let dict = message.body as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: dict),
                  let decoded = try? JSONDecoder().decode(MonacoOutboundMessage.self, from: data) else {
                return
            }
            if case .ready = decoded {
                documentReady = true
                applyPendingChanges()   // apply whatever `parent` already held before load finished
                parent.onReady?()
            }
            // Monaco already holds `text` at this point (it just reported it), so record it as
            // `lastContent` here too — mirroring the bookkeeping `applyPendingChanges` does after
            // an outbound `setContent` push. Without this, a caller that round-trips this text
            // straight back into `content` (the expected pattern — see `MonacoEditorView`) would
            // see the next `applyPendingChanges` diff it against a stale `lastContent` and fire a
            // redundant `setContent`, resetting Monaco's cursor/selection on every keystroke.
            if case .contentChanged(let text) = decoded {
                lastContent = text
            }
            parent.onMessage?(decoded)
        }

        // MARK: - Bridge calls (Task 13)
        //
        // Private: `applyPendingChanges` above is their only caller.
        // `MonacoHost`'s declarative properties are the public surface, not
        // these methods.

        private func setContent(_ text: String, language: String) {
            webView?.callAsyncJavaScript(
                "window.__llmide.setContent(text, language);",
                arguments: ["text": text, "language": language],
                in: nil, in: .page, completionHandler: nil)
        }

        private func setDecorations(_ marks: [Int: GitGutter.Mark]) {
            // MonacoDecoration.decorations(from:) does the typed, tested
            // Mark -> wire-kind mapping (Task 10); this just reshapes that
            // into the plist-compatible [String: Any] array
            // callAsyncJavaScript's `arguments` requires (a custom Codable
            // struct can't cross that boundary directly).
            let decorations = MonacoDecoration.decorations(from: marks).map {
                ["line": $0.line, "kind": $0.kind] as [String: Any]
            }
            webView?.callAsyncJavaScript(
                "window.__llmide.setDecorations(decorations);",
                arguments: ["decorations": decorations],
                in: nil, in: .page, completionHandler: nil)
        }

        private func setTheme(_ theme: Theme) {
            webView?.callAsyncJavaScript(
                "window.__llmide.setTheme(themeJSON);",
                arguments: ["themeJSON": theme.monacoThemeJSON()],
                in: nil, in: .page, completionHandler: nil)
        }

        private func reveal(line: Int) {
            webView?.callAsyncJavaScript(
                "window.__llmide.reveal(line);",
                arguments: ["line": line],
                in: nil, in: .page, completionHandler: nil)
        }

        private func showDiff(original: String, modified: String, language: String) {
            webView?.callAsyncJavaScript(
                "window.__llmide.showDiff(original, modified, language);",
                arguments: ["original": original, "modified": modified, "language": language],
                in: nil, in: .page, completionHandler: nil)
        }

        private func setReadOnly(_ readOnly: Bool) {
            webView?.callAsyncJavaScript(
                "window.__llmide.setReadOnly(readOnly);",
                arguments: ["readOnly": readOnly],
                in: nil, in: .page, completionHandler: nil)
        }
    }
}

/// Anchor used only with `Bundle(for:)` to find the image `MonacoHost` was
/// loaded from. Deliberately not `Bundle.module` — see `indexURL()`'s doc
/// comment and `SourceConnectorManifest.swift`'s `BundleLocator`, which this
/// mirrors.
private final class MonacoBundleLocator {}
