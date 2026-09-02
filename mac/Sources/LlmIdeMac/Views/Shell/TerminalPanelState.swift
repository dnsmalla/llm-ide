import Foundation
import Observation
import SwiftUI

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

/// Panel-level state: open/closed, height, and (when `FEATURE_TERMINAL` is
/// compiled in) the list of tab sessions. Created as `@State` in `AppShell`,
/// propagated via `.environment()`.
///
/// This type stays in Views/Shell (core, always compiled) because AppShell,
/// StatusBar, and ExplorerView all reference `isOpen`/`toggle(projectDirectory:)`
/// unconditionally, regardless of whether the Terminal feature is selected.
/// Everything that needs the concrete `TerminalSession` type — itself
/// feature-owned in Views/Terminal because it imports SwiftTerm, which is
/// only linked when `terminal` is selected (see Package.swift) — is gated
/// behind `#if FEATURE_TERMINAL` below rather than moved: it is genuinely
/// core *state* (own by the shell), just with a feature-only *session list*.
@Observable
@MainActor
final class TerminalPanelState {

    // MARK: - State

    var isOpen: Bool = false

    #if FEATURE_TERMINAL
    /// Which VSCode-style dock tab is showing. `.terminal` is the only live
    /// one; the rest render placeholder content.
    var activeDockTab: BottomDockTab = .terminal
    #endif

    /// Panel height in points. Persisted across app launches.
    var panelHeight: CGFloat {
        didSet {
            UserDefaults.standard.set(Double(panelHeight), forKey: "terminalPanelHeight")
        }
    }

    #if FEATURE_TERMINAL
    /// All tab sessions. Sessions remain alive even when the panel is closed
    /// so PTY processes and scrollback are preserved across toggle cycles.
    var sessions: [TerminalSession] = []
    var activeIndex: Int = 0

    /// Monotonically incrementing counter — never resets when tabs close,
    /// so tab titles stay unique (no "zsh 2" appearing twice in a session).
    private var nextTabNumber: Int = 1
    #endif

    // MARK: - Init

    init() {
        let saved = UserDefaults.standard.double(forKey: "terminalPanelHeight")
        self.panelHeight = saved > 0 ? CGFloat(saved) : 260
    }

    // MARK: - Actions

    /// Toggle panel open/closed. Opening focuses the Terminal tab (Ctrl+`
    /// is terminal-centric) and creates a first session if none exist.
    func toggle(projectDirectory: URL) {
        #if FEATURE_TERMINAL
        if isOpen {
            isOpen = false
        } else {
            if sessions.isEmpty {
                _addTab(in: projectDirectory)
            }
            activeDockTab = .terminal
            isOpen = true
        }
        #else
        // No sessions to manage in a Terminal-excluded build — the dock
        // itself (TerminalPanelView) is compiled out, so this is inert.
        isOpen.toggle()
        #endif
    }

    #if FEATURE_TERMINAL
    /// Open a new tab and activate it. Also opens the panel if closed.
    func addTab(in directory: URL) {
        _addTab(in: directory)
        isOpen = true
    }

    /// Terminate a session and remove its tab.
    /// Closes the panel automatically when the last tab is removed.
    func closeTab(at index: Int) {
        guard index >= 0, index < sessions.count else { return }
        sessions[index].terminate()
        sessions.remove(at: index)
        if sessions.isEmpty {
            isOpen = false
            activeIndex = 0
        } else {
            activeIndex = min(activeIndex, sessions.count - 1)
        }
    }
    #endif

    /// Clamp `height` to the allowed range [120, windowHeight × 0.6].
    func clampedHeight(_ height: CGFloat, windowHeight: CGFloat) -> CGFloat {
        guard windowHeight > 0 else { return max(height, 120) }
        let maxH = windowHeight * 0.6
        return min(max(height, 120), maxH)
    }

    // MARK: - Private

    #if FEATURE_TERMINAL
    private func _addTab(in directory: URL) {
        let session = TerminalSession(number: nextTabNumber, workingDirectory: directory)
        nextTabNumber += 1
        sessions.append(session)
        activeIndex = sessions.count - 1
    }
    #endif
}
