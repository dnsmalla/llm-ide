import Foundation
import AppKit
import Combine
import os.log

/// Routes incoming `llmide://` URLs to the right tab and brings the
/// app to the front.  ContentView observes `pendingTab` and switches
/// the visible tab when it changes; the value is `nil` between events
/// so the same deep-link clicked twice still fires.
@MainActor
final class DeepLinkRouter: ObservableObject {
    /// Pending tab selection. Identified by an incrementing event id
    /// so identical successive deep links (same `tab`) still produce
    /// distinct values — SwiftUI's .onChange only fires on inequality,
    /// and the previous "set nil then set value on next runloop"
    /// pattern relied on SwiftUI NOT coalescing the two publishes,
    /// which isn't guaranteed.
    struct Event: Equatable {
        let id: UInt64
        let tab: String
        let session: String?
    }

    /// Set by `handle(_:)` and consumed by ContentView via .onChange.
    @Published var pendingEvent: Event?

    /// Back-compat shim — callers that only need the tab string keep
    /// reading `pendingTab`. READ-ONLY: writing through pendingTab
    /// would silently drop the `session` field of the current Event
    /// (since the setter has no way to know what session a non-nil
    /// caller intends), losing a fresh deep link's session subscription.
    /// Callers that want to clear should write `pendingEvent = nil`
    /// directly.
    var pendingTab: String? { pendingEvent?.tab }

    private var lastEventId: UInt64 = 0
    private func nextEventId() -> UInt64 {
        lastEventId &+= 1
        return lastEventId
    }

    /// Callback that asks SwiftUI to (re-)show the main window.
    /// ContentView wires this on .onAppear via the
    /// `@Environment(\.openWindow)` action.  Required because with
    /// the singular `Window` scene, a window closed via Cmd-W stays
    /// closed on URL arrival until something explicitly calls
    /// `openWindow(id: "main")`.
    var openMainWindow: (() -> Void)?

    private let log = Logger(subsystem: "com.llmide.macapp", category: "DeepLink")

    func handle(_ url: URL) {
        // Accept the new scheme plus the legacy `meetnotes://` so links shared
        // before the rebrand still resolve.
        let scheme = url.scheme?.lowercased()
        guard scheme == "llmide" || scheme == "meetnotes" else {
            log.warning("ignoring non-llmide URL: \(url, privacy: .public)")
            return
        }

        // Bring the app to the foreground.  Deep-link arrival from the
        // extension is the user's explicit "show me this now" intent —
        // they expect focus to switch.  Cover every window state:
        //
        //   - app hidden via Cmd-H        → unhide()
        //   - window minimized to dock    → deminiaturize()
        //   - window closed (red X)       → ask SwiftUI to reopen the
        //                                   main window via openWindow
        //   - window already visible      → makeKeyAndOrderFront brings
        //                                   it to the active space
        //
        // Without this, a second click on the extension's ↗ button
        // looked like "the app opened a second time" because SwiftUI's
        // WindowGroup created a new window when no window was visible.
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)

        var hadAVisibleWindow = false
        for window in NSApp.windows {
            // Skip the menu-bar's invisible status item window — its
            // class name varies by macOS version but it's never the
            // user-facing main window.
            guard window.canBecomeMain || window.isVisible else { continue }
            if window.isMiniaturized {
                window.deminiaturize(nil)
            }
            window.makeKeyAndOrderFront(nil)
            hadAVisibleWindow = hadAVisibleWindow || window.isVisible
        }

        // If every main window was closed (Cmd-W), ask SwiftUI to
        // reopen the singular `Window(id: "main")` scene.  This is the
        // ONLY path that works for `Window` (vs `WindowGroup`); the
        // AppDelegate's `applicationShouldHandleReopen` covers dock
        // clicks, but URL events need this explicit reopen.
        if !hadAVisibleWindow, let open = openMainWindow {
            DispatchQueue.main.async { open() }
        }

        // Tab is the first segment.  llmide://transcript / -plan /
        // -review / -history / -settings.  Anything else falls back
        // to transcript (the most common reason to deep-link from the
        // extension is "show me what I'm capturing right now").
        let host = url.host?.lowercased() ?? "transcript"
        let allowed: Set<String> = ["transcript", "plan", "review", "history", "settings"]
        let tab = allowed.contains(host) ? host : "transcript"

        // Optional session subscription.  Constrained to a safe ID
        // shape — alphanumerics, dashes, underscores, max 128 chars —
        // because the value flows straight into API URLs and view
        // state.  An unvalidated value from a hostile llmide://
        // link (any process on the box can call `open`) could be e.g.
        // "../../etc/passwd" or carry CRLF for header injection.
        let rawSession = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "session" })?
            .value
        let session: String? = {
            guard let s = rawSession, !s.isEmpty, s.count <= 128 else { return nil }
            let allowed = CharacterSet(charactersIn:
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
            return s.unicodeScalars.allSatisfy(allowed.contains) ? s : nil
        }()
        if rawSession != nil && session == nil {
            log.warning("rejected malformed session id from deep link")
        }

        log.info("deep link: tab=\(tab, privacy: .public) session=\(session ?? "-", privacy: .public)")

        // Publish an Event with a unique id. Equatable Event ensures
        // SwiftUI's .onChange fires even when (tab, session) match the
        // previous click — no nil-then-set dance required.
        pendingEvent = Event(id: nextEventId(), tab: tab, session: session)
    }
}
