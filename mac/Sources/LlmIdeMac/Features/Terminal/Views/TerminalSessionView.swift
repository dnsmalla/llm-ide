import SwiftUI
import AppKit
import SwiftTerm

/// Bridges a `TerminalSession`'s `LocalProcessTerminalView` into SwiftUI.
/// The terminal view is created once per session and never recreated — this
/// preserves the PTY process and full scrollback across tab switches. It is
/// hosted inside a plain container so the representable's own NSView can
/// exist before the session has spawned anything.
struct TerminalSessionView: NSViewRepresentable {
    let session: TerminalSession
    @EnvironmentObject private var theme: ThemeStore

    func makeNSView(context: Context) -> NSView {
        MainActor.assumeIsolated { makeContainer() }
    }

    /// `makeNSView` is always called on the main thread, so main-actor
    /// isolation is safe to assume there.
    @MainActor
    private func makeContainer() -> NSView {
        let container = NSView()
        container.wantsLayer = true
        // Never spawn HERE. `session.start()` writes observed state
        // (`termView`, `status`, `spawnError`), and mutating observed state
        // while SwiftUI is building the view is undefined behaviour ("Modifying
        // state during view update") that can drop or loop the update. An
        // already-running session (the view was rebuilt) is only re-parented,
        // which touches no observed state.
        if session.termView != nil {
            embed(in: container)
        } else {
            DispatchQueue.main.async {
                session.startIfNeeded()
                embed(in: container)
            }
        }
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        // Re-apply theme colors so a light/dark palette switch updates the
        // live terminal (SwiftTerm otherwise keeps its default dark palette).
        MainActor.assumeIsolated {
            if let tv = session.termView, tv.superview === nsView {
                applyTheme(to: tv)
            }
        }
    }

    // MARK: - Private

    /// Put the session's terminal (or its spawn error) into `container`.
    /// Idempotent: a terminal already hosted there is left alone, and one
    /// hosted by a previous container is moved (AppKit removes it from the
    /// old superview on `addSubview`).
    @MainActor
    private func embed(in container: NSView) {
        guard let tv = session.termView else {
            // Spawn failed (or has not happened) — show the error inline.
            guard container.subviews.isEmpty else { return }
            let error = errorView(session.spawnError ?? "Failed to start terminal.")
            error.frame = container.bounds
            error.autoresizingMask = [.width, .height]
            container.addSubview(error)
            return
        }
        guard tv.superview !== container else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        tv.frame = container.bounds
        tv.autoresizingMask = [.width, .height]
        container.addSubview(tv)
        applyTheme(to: tv)
    }

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
