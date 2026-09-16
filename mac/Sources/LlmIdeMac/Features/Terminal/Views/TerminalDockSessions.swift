import Foundation
import Observation

/// Terminal-only bottom panel. Other VSCode-style tabs removed as placeholders.
enum BottomDockTab: String, CaseIterable, Identifiable {
    case terminal
    var id: String { rawValue }

    var title: String {
        switch self {
        case .terminal:     return "Terminal"
        }
    }

    var systemImage: String {
        switch self {
        case .terminal:     return "chevron.left.forwardslash.chevron.right"
        }
    }

    var placeholder: String {
        switch self {
        case .terminal:     return ""
        }
    }
}

/// Feature-owned complement to `TerminalPanelState` (core): owns the tab
/// sessions (`TerminalSession`, which imports SwiftTerm — only linked when
/// `terminal` is selected, see Package.swift) and the active dock tab.
///
/// Installed onto a `TerminalPanelState` via
/// `FeatureCatalog.installTerminalHooks(on:)` and injected into the
/// terminal panel's environment by `FeatureCatalog.terminalPanel(projectDirectory:)`
/// — those two functions are the only place the Terminal build flag is
/// tested for this feature; this type itself has none because the whole file is
/// already excluded from a Terminal-off build (see `libExcludes` in
/// Package.swift).
@Observable
@MainActor
final class TerminalDockSessions {

    /// Which VSCode-style dock tab is showing. `.terminal` is the only live
    /// one; the rest render placeholder content.
    var activeDockTab: BottomDockTab = .terminal

    /// All tab sessions. Sessions remain alive even when the panel is closed
    /// so PTY processes and scrollback are preserved across toggle cycles.
    var sessions: [TerminalSession] = []
    var activeIndex: Int = 0

    /// Monotonically incrementing counter — never resets when tabs close,
    /// so tab titles stay unique (no "zsh 2" appearing twice in a session).
    private var nextTabNumber: Int = 1

    // MARK: - Actions

    /// Reacts to a toggle request forwarded from `TerminalPanelState`:
    /// opens the panel (creating a first session if none exist) or closes
    /// it. Wired in as `TerminalPanelState.onToggleRequested`.
    func handleToggle(_ state: TerminalPanelState, projectDirectory: URL) {
        if state.isOpen {
            state.isOpen = false
        } else {
            if sessions.isEmpty {
                _addTab(in: projectDirectory)
            }
            activeDockTab = .terminal
            state.isOpen = true
        }
    }

    /// Open a new tab and activate it. Also opens the panel if closed.
    func addTab(_ state: TerminalPanelState, in directory: URL) {
        _addTab(in: directory)
        state.isOpen = true
    }

    /// Terminate a session and remove its tab.
    /// Closes the panel automatically when the last tab is removed.
    func closeTab(_ state: TerminalPanelState, at index: Int) {
        guard index >= 0, index < sessions.count else { return }
        sessions[index].terminate()
        sessions.remove(at: index)
        if sessions.isEmpty {
            state.isOpen = false
            activeIndex = 0
        } else {
            activeIndex = min(activeIndex, sessions.count - 1)
        }
    }

    // MARK: - Private

    private func _addTab(in directory: URL) {
        let session = TerminalSession(number: nextTabNumber, workingDirectory: directory)
        nextTabNumber += 1
        sessions.append(session)
        activeIndex = sessions.count - 1
    }
}
