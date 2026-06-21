import SwiftUI
import AppKit
import SwiftTerm

/// Bridges a `TerminalSession`'s `LocalProcessTerminalView` into SwiftUI.
/// The NSView is created once (in `makeNSView`) and never recreated —
/// this preserves the PTY process and full scrollback across tab switches.
struct TerminalSessionView: NSViewRepresentable {
    let session: TerminalSession
    @EnvironmentObject private var theme: ThemeStore

    func makeNSView(context: Context) -> NSView {
        // makeNSView is always called on the main thread, so we can safely
        // assume @MainActor isolation here.
        MainActor.assumeIsolated {
            // Start the PTY the first time this view enters the hierarchy.
            if session.termView == nil {
                session.start()
            }

            if let tv = session.termView {
                applyTheme(to: tv)
                return tv
            }

            // Spawn failed — show the error inline.
            return errorView(session.spawnError ?? "Failed to start terminal.")
        }
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Re-apply theme colors so a light/dark palette switch updates the
        // live terminal (SwiftTerm otherwise keeps its default dark palette).
        if let tv = nsView as? LocalProcessTerminalView {
            applyTheme(to: tv)
        }
    }

    // MARK: - Private

    /// Drive the terminal's background / foreground / caret from the active
    /// app theme so the terminal isn't always dark (VS Code follows the theme).
    /// The ANSI 16-colour palette is left at SwiftTerm's defaults — only the
    /// base surface + default text follow the theme.
    private func applyTheme(to tv: LocalProcessTerminalView) {
        let t = theme.current
        tv.nativeBackgroundColor = NSColor(t.body)
        tv.nativeForegroundColor = NSColor(t.text)
        tv.caretColor = NSColor(t.accent)
    }

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
