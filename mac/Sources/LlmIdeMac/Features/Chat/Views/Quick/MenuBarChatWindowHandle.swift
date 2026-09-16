import AppKit
import SwiftUI

/// Captures the `NSWindow` backing a `MenuBarExtra` `.window` popover.
/// SwiftUI's `@Environment(\\.dismiss)` closes that window (often unintentionally
/// from sheets/alerts) and does not give callers a reliable "minimize chat" hook,
/// so the menu-bar chat uses this accessor instead.
struct MenuBarChatWindowAccessor: NSViewRepresentable {
    @Binding var window: NSWindow?

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        bindWindow(from: view)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        bindWindow(from: nsView)
    }

    private func bindWindow(from view: NSView) {
        DispatchQueue.main.async {
            guard let captured = view.window else { return }
            // SwiftUI owns this window's lifecycle; make `close()` (the
            // dismissal below) provably safe even though AppKit's NSPanel
            // default would be releasedWhenClosed = true.
            captured.isReleasedWhenClosed = false
            window = captured
        }
    }
}

enum MenuBarChatWindow {
    /// Hide the menu-bar chat popover without quitting the app.
    ///
    /// `close()`, deliberately NOT `orderOut(nil)`: orderOut hides the
    /// window without posting `willClose`, so MenuBarExtra's internal
    /// presented-state bookkeeping still believes the popover is open —
    /// the NEXT status-item click then toggles that stale state (a no-op
    /// against an already-hidden window) and only the click after that
    /// reopens it. That out-of-step first click is exactly the "popover
    /// won't open/close right" complaint. close() runs the notification
    /// path SwiftUI observes, and the accessor pins
    /// `isReleasedWhenClosed = false` so the panel instance survives to be
    /// re-presented.
    @MainActor
    static func orderOut(_ window: NSWindow?) {
        window?.close()
    }
}
