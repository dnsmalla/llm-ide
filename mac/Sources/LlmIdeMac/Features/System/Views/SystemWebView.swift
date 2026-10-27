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
/// The page has no network access of its own. Its origin is file://, which the
/// server refuses, and the token never enters JavaScript. Every server call goes
/// through the bridge: native checks it against `SystemAllowedCall`, makes it with
/// the authenticated `LlmIdeAPIClient`, and answers. The change feed is opened
/// here too, on the page's `subscribe`, and its events are forwarded to the page.
///
/// Bridge contract: see `SystemBridgeInbound` and the header of `ui/os-view/src/bridge.ts`.
struct SystemWebView: NSViewRepresentable {
    static let messageHandlerName = "llmide"

    let api: LlmIdeAPIClient
    let session: SessionStore
    let theme: Theme
    let projectName: String?
    /// The active project's folder, for the native graph call. nil when no project is open.
    let projectRoot: URL?
    /// The active project's id, for the native routines call (custom tasks are per project).
    let projectId: String?
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
        /// Timeout for one bridged call. Kept under the page's own 15 s, so a
        /// slow call fails here with a reply rather than on the page's timer.
        private static let requestTimeout: TimeInterval = 12

        private var parent: SystemWebView
        private weak var webView: WKWebView?
        private var indexURL: URL?
        /// The page has posted `ready` (and has not since reloaded).
        private var pageReady = false
        /// The configuration last handed to the page. Re-sent only when it changes.
        private var lastConfig: SystemBridgeConfig?
        private var sessionCancellable: AnyCancellable?
        /// Whether a session was present at the last check. A change restarts or stops the feed.
        private var hadSession = false
        /// The change feed, present while the page is subscribed (one per view).
        private var feed: SystemEventStream?

        init(_ parent: SystemWebView) {
            self.parent = parent
        }

        /// Whether the native change feed exists (it is created on the page's `subscribe`).
        var hasFeed: Bool { feed != nil }

        /// Internal, not private, so the teardown test can drive the page without a window.
        @MainActor
        func attach(_ web: WKWebView, indexURL: URL?) {
            webView = web
            self.indexURL = indexURL
            hadSession = parent.session.accessToken != nil
            // The published value is emitted before it is stored, so the check is
            // deferred one main-actor hop, which then reads the stored value.
            sessionCancellable = parent.session.$accessToken.dropFirst().sink { [weak self] _ in
                Task { @MainActor in self?.sessionChanged() }
            }
            loadPage()
        }

        /// Called from `dismantleNSView`. Stops the native change feed first (its
        /// `/kb/os/stream` connection is what the server caps at 4 per user), then
        /// stops the page: no more loads, no delegate, and about:blank so the old
        /// document's scripts stop running.
        @MainActor
        func detach() {
            feed?.stop()
            feed = nil
            sessionCancellable = nil
            pageReady = false
            if let web = webView {
                web.stopLoading()
                web.navigationDelegate = nil
                if let blank = URL(string: "about:blank") {
                    web.load(URLRequest(url: blank))
                }
            }
            webView = nil
        }

        /// Called from `updateNSView` on every SwiftUI pass: picks up a new
        /// theme or project and pushes it if it changed. A name change restarts
        /// the change feed; a root or id change with the same name reloads the
        /// page, because the page's controller sees only the name.
        @MainActor
        fileprivate func update(_ newParent: SystemWebView) {
            let change = SystemBridge.projectChange(
                fromName: parent.projectName, fromRoot: parent.projectRoot, fromId: parent.projectId,
                toName: newParent.projectName, toRoot: newParent.projectRoot, toId: newParent.projectId)
            parent = newParent
            switch change {
            case .none:
                pushConfigure()
            case .renamed:
                pushConfigure()
                feed?.restart()
            case .reloadPage:
                loadPage()
            }
        }

        @MainActor
        private func loadPage() {
            guard let web = webView, let indexURL else { return }
            feed?.stop()
            feed = nil
            pageReady = false
            lastConfig = nil
            web.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }

        /// Signing in restarts the feed with the new session; signing out stops it.
        @MainActor
        private func sessionChanged() {
            let signedIn = parent.session.accessToken != nil
            guard signedIn != hadSession else { return }
            hadSession = signedIn
            if signedIn {
                feed?.restart()
            } else {
                feed?.stop()
                sendStatus("stopped", "Sign in to LLM-IDE again")
            }
        }

        /// Builds the config from the current app state and evaluates it in the
        /// page. A no-op until the page is ready, and when nothing changed
        /// (unless `force`).
        @MainActor
        private func pushConfigure(force: Bool = false) {
            guard pageReady, let web = webView else { return }
            let config = SystemBridgeConfig(theme: parent.theme.id, projectName: parent.projectName)
            if !force, config == lastConfig { return }
            guard let script = SystemBridge.configureScript(config) else { return }
            lastConfig = config
            web.evaluateJavaScript(script, completionHandler: nil)
        }

        /// Internal for the coordinator tests; the script-message path is the only caller in the app.
        @MainActor
        func handle(_ inbound: SystemBridgeInbound) {
            switch inbound {
            case .ready:
                pageReady = true
                lastConfig = nil
                pushConfigure(force: true)
            case .open(let target):
                guard let section = SystemBridge.section(forOpenTarget: target) else { return }
                parent.onOpen(section)
            case .request(let request):
                perform(request)
            case .native(let request):
                performNative(request)
            case .subscribe:
                if feed == nil {
                    feed = SystemEventStream(
                        client: parent.api,
                        onStatus: { [weak self] status, detail in self?.sendStatus(status, detail) },
                        onEvent: { [weak self] event in self?.sendEvent(event) })
                }
                feed?.start()
            case .unsubscribe:
                feed?.stop()
                feed = nil
            }
        }

        /// Makes one allowlisted call with the authenticated client and replies to the page.
        @MainActor
        private func perform(_ request: SystemBridgeRequest) {
            guard let call = request.call else {
                reply(id: request.id, status: 400, body: nil, error: "not_allowed")
                return
            }
            let client = parent.api
            let id = request.id
            let timeout = Self.requestTimeout
            Task { @MainActor [weak self] in
                do {
                    let (status, data) = try await client.sendReturningStatus(
                        path: call.path, method: call.method, body: call.body, timeout: timeout)
                    let error: String? = (200..<300).contains(status) ? nil : "HTTP \(status)"
                    // The skill library's local paths never reach the page.
                    var body: Data? = data
                    if case .skillLibrary = call, (200..<300).contains(status) {
                        body = SystemBridge.sanitizeSkillLibrary(data)
                    }
                    self?.reply(id: id, status: status, body: body, error: error)
                } catch APIError.noSession {
                    self?.reply(id: id, status: 401, body: nil, error: "signed_out")
                } catch {
                    self?.reply(id: id, status: 0, body: nil, error: "unreachable")
                }
            }
        }

        /// Answers a native-only data call. The graph is the Graph feature's cached
        /// graph when one exists, else the project's graph.json; both are encoded off
        /// the main thread. Routines come from the installed `RoutinesRegistry`.
        @MainActor
        private func performNative(_ request: SystemBridgeNativeRequest) {
            guard let call = request.call else {
                reply(id: request.id, status: 400, body: nil, error: "not_allowed")
                return
            }
            let id = request.id
            switch call {
            case .projectGraph:
                let root = parent.projectRoot
                Task { @MainActor [weak self] in
                    // The provider runs on the main actor (it reads the Graph view's
                    // cache); the file read and the encoding run off it.
                    let provided: Data?
                    if let root {
                        provided = await ProjectGraphRegistry.shared.graph(forProjectRoot: root)
                    } else {
                        provided = nil
                    }
                    let reply = await Task.detached(priority: .utility) {
                        SystemBridge.projectGraphReply(provided: provided, loadFile: {
                            root.flatMap { ProjectGraphFile.load(projectRoot: $0) }
                        })
                    }.value
                    self?.replyRaw(id: id, reply: reply)
                }
            case .routines:
                let routines = RoutinesRegistry.shared.routines(projectId: parent.projectId)
                Task { @MainActor [weak self] in
                    let body = await Task.detached(priority: .utility) {
                        SystemBridge.routinesBodyJSON(routines)
                    }.value
                    self?.replyRaw(id: id, reply: SystemBridge.NativeReply(status: 200, bodyJSON: body, error: nil))
                }
            }
        }

        /// Replies with a body that is already JSON text.
        @MainActor
        private func replyRaw(id: String, reply: SystemBridge.NativeReply) {
            guard let web = webView,
                  let script = SystemBridge.responseScript(id: id, status: reply.status,
                                                           bodyJSON: reply.bodyJSON, error: reply.error) else { return }
            web.evaluateJavaScript(script, completionHandler: nil)
        }

        @MainActor
        private func reply(id: String, status: Int, body: Data?, error: String?) {
            guard let web = webView,
                  let script = SystemBridge.responseScript(id: id, status: status, body: body, error: error) else { return }
            web.evaluateJavaScript(script, completionHandler: nil)
        }

        @MainActor
        private func sendEvent(_ event: SystemFeedEvent) {
            guard pageReady, let web = webView, let script = SystemBridge.eventScript(event) else { return }
            web.evaluateJavaScript(script, completionHandler: nil)
        }

        @MainActor
        private func sendStatus(_ status: String, _ detail: String?) {
            guard pageReady, let web = webView,
                  let script = SystemBridge.statusScript(status: status, detail: detail) else { return }
            web.evaluateJavaScript(script, completionHandler: nil)
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
