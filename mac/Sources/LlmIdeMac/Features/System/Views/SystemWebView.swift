import SwiftUI
import WebKit
import Combine

/// Hosts the bundled OS page (`Resources/os-view/index.html`) in a `WKWebView`.
///
/// Loaded with `loadFileURL` from the bundle, the same way `MonacoHost` loads
/// Monaco: the page is a multi-file asset tree, so a single inlined HTML string
/// would not resolve its siblings. No remote content may load here. The
/// navigation delegate allows only file URLs inside the bundled page's own
/// directory, and the view opens no windows.
///
/// Bridge (contract in `SystemBridgeInbound`): the page posts to the `llmide`
/// handler; Swift answers by evaluating `window.llmideConfigure({...})`. The
/// access token travels only as a JSON-encoded argument to
/// `evaluateJavaScript`. It is never placed in a URL, a file, or a log.
struct SystemWebView: NSViewRepresentable {
    static let messageHandlerName = "llmide"

    let api: LlmIdeAPIClient
    let session: SessionStore
    let theme: Theme
    let projectName: String?
    /// Called with a section the page asked to open (already checked against
    /// the feature registry). The shell decides how to show it.
    let onOpen: (ShellSection) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Nothing the page stores should outlive the view, and the bundled
        // page needs no persisted origin data.
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: Self.messageHandlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.setValue(false, forKey: "drawsBackground")
        context.coordinator.attach(web, indexURL: BundledWebResources.indexURL(subdirectory: "os-view"))
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        context.coordinator.update(self)
    }

    /// Called just before the view leaves the hierarchy. `WKUserContentController`
    /// holds its script handler strongly, so the handler is removed here to
    /// break the handler ↔ web view cycle (same as `MonacoHost`).
    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) {
        nsView.configuration.userContentController.removeScriptMessageHandler(forName: messageHandlerName)
        coordinator.detach()
    }

    /// Mirrors `MonacoHost.Coordinator`: the delegate callbacks arrive on the
    /// main thread, and anything that touches the session or the web view is
    /// main-actor code reached through `Task { @MainActor in … }`.
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private var parent: SystemWebView
        private weak var webView: WKWebView?
        private var indexURL: URL?
        /// The page has posted `ready` (and has not since reloaded).
        private var pageReady = false
        /// The configuration last handed to the page. Re-sent only when it
        /// changes (theme, project, or token rotation).
        private var lastConfig: SystemBridgeConfig?
        private var tokenCancellable: AnyCancellable?

        init(_ parent: SystemWebView) {
            self.parent = parent
        }

        @MainActor
        fileprivate func attach(_ web: WKWebView, indexURL: URL?) {
            webView = web
            self.indexURL = indexURL
            // Re-send when the session token rotates. The published value is
            // emitted before it is stored, so the push is deferred one main-actor
            // hop, which then reads the stored value.
            tokenCancellable = parent.session.$accessToken.dropFirst().sink { [weak self] _ in
                Task { @MainActor in self?.pushConfigure() }
            }
            loadPage()
        }

        @MainActor
        fileprivate func detach() {
            tokenCancellable = nil
            webView = nil
        }

        /// Called from `updateNSView` on every SwiftUI pass: picks up a new
        /// theme or project name and pushes it if it changed.
        @MainActor
        fileprivate func update(_ newParent: SystemWebView) {
            parent = newParent
            pushConfigure()
        }

        @MainActor
        private func loadPage() {
            guard let web = webView, let indexURL else { return }
            pageReady = false
            lastConfig = nil
            web.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }

        /// Builds the config from the current app state and evaluates it in the
        /// page. A no-op until the page is ready, and when nothing changed
        /// (unless `force`).
        @MainActor
        private func pushConfigure(force: Bool = false) {
            guard pageReady, let web = webView else { return }
            let config = SystemBridgeConfig(
                baseURL: parent.api.baseURL,
                token: parent.session.accessToken,
                theme: parent.theme.id,
                projectName: parent.projectName)
            if !force, config == lastConfig { return }
            guard let script = SystemBridge.configureScript(config) else { return }
            lastConfig = config
            web.evaluateJavaScript(script, completionHandler: nil)
        }

        @MainActor
        private func handle(_ inbound: SystemBridgeInbound) {
            switch inbound {
            case .ready:
                pageReady = true
                lastConfig = nil
                pushConfigure(force: true)
            case .needToken:
                let api = parent.api
                let session = parent.session
                Task { @MainActor [weak self] in
                    if session.accessToken == nil {
                        _ = await session.attemptRefresh(via: api)
                    }
                    self?.pushConfigure(force: true)
                }
            case .open(let target):
                guard let section = SystemBridge.section(forOpenTarget: target) else { return }
                parent.onOpen(section)
            }
        }

        // MARK: WKScriptMessageHandler

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let inbound = SystemBridgeInbound.decode(message.body) else { return }
            Task { @MainActor [weak self] in self?.handle(inbound) }
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allowed = SystemBridge.isLocalNavigation(
                navigationAction.request.url,
                bundleDirectory: indexURL?.deletingLastPathComponent())
            decisionHandler(allowed ? .allow : .cancel)
        }

        /// Reload after the system kills the content process under memory
        /// pressure; without it the view stays blank. Ready is re-armed by the
        /// page's next `ready` post.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            Task { @MainActor [weak self] in self?.loadPage() }
        }
    }
}
