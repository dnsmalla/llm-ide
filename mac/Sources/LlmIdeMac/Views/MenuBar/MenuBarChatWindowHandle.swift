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
            window = view.window
        }
    }
}

enum MenuBarChatWindow {
    /// Hide the menu-bar chat popover without quitting the app.
    @MainActor
    static func orderOut(_ window: NSWindow?) {
        window?.orderOut(nil)
    }
}
