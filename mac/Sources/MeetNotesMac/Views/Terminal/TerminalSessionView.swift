import SwiftUI
import AppKit
import SwiftTerm

/// Bridges a `TerminalSession`'s `LocalProcessTerminalView` into SwiftUI.
/// The NSView is created once (in `makeNSView`) and never recreated —
/// this preserves the PTY process and full scrollback across tab switches.
struct TerminalSessionView: NSViewRepresentable {
    let session: TerminalSession

    func makeNSView(context: Context) -> NSView {
        // makeNSView is always called on the main thread, so we can safely
        // assume @MainActor isolation here.
        MainActor.assumeIsolated {
            // Start the PTY the first time this view enters the hierarchy.
            if session.termView == nil {
                session.start()
            }

            if let tv = session.termView {
                return tv
            }

            // Spawn failed — show the error inline.
            return errorView(session.spawnError ?? "Failed to start terminal.")
        }
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // SwiftTerm manages its own render loop — nothing to do.
    }

    // MARK: - Private

    private func errorView(_ message: String) -> NSView {
        let container = NSView()
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.black.cgColor

        let label = NSTextField(labelWithString: message)
        label.textColor = NSColor.systemRed
        label.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.cell?.wraps = true
        label.maximumNumberOfLines = 3

        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
        ])
        return container
    }
}
