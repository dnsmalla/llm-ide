import Foundation
import Observation
import SwiftUI

/// VSCode-style bottom-panel tabs. Only `.terminal` is functional; the others
/// are placeholders so the dock reads like VSCode's panel at a glance.
enum BottomDockTab: String, CaseIterable, Identifiable {
    case problems, output, debugConsole, terminal, ports, gitlens
    var id: String { rawValue }

    var title: String {
        switch self {
        case .problems:     return "Problems"
        case .output:       return "Output"
        case .debugConsole: return "Debug Console"
        case .terminal:     return "Terminal"
        case .ports:        return "Ports"
        case .gitlens:      return "GitLens"
        }
    }

    var systemImage: String {
        switch self {
        case .problems:     return "exclamationmark.triangle"
        case .output:       return "text.alignleft"
        case .debugConsole: return "terminal"
        case .terminal:     return "chevron.left.forwardslash.chevron.right"
        case .ports:        return "antenna.radiowaves.left.and.right"
        case .gitlens:      return "arrow.triangle.branch"
        }
    }

    /// Muted placeholder copy for the non-functional tabs.
    var placeholder: String {
        switch self {
        case .problems:     return "No problems have been detected in the workspace."
        case .output:       return "No output to show yet."
        case .debugConsole: return "The debug console is not active."
        case .ports:        return "No forwarded ports.\nRun a server to see ports here."
        case .gitlens:      return "GitLens insights are not configured."
        case .terminal:     return ""
        }
    }
}

/// Panel-level state: open/closed, height, and the list of tab sessions.
/// Created as `@State` in `AppShell`, propagated via `.environment()`.
@Observable
@MainActor
final class TerminalPanelState {

    // MARK: - State

    var isOpen: Bool = false

    /// Which VSCode-style dock tab is showing. `.terminal` is the only live
    /// one; the rest render placeholder content.
    var activeDockTab: BottomDockTab = .terminal

    /// Panel height in points. Persisted across app launches.
    var panelHeight: CGFloat {
        didSet {
            UserDefaults.standard.set(Double(panelHeight), forKey: "terminalPanelHeight")
        }
    }

    /// All tab sessions. Sessions remain alive even when the panel is closed
    /// so PTY processes and scrollback are preserved across toggle cycles.
    var sessions: [TerminalSession] = []
    var activeIndex: Int = 0

    /// Monotonically incrementing counter — never resets when tabs close,
    /// so tab titles stay unique (no "zsh 2" appearing twice in a session).
    private var nextTabNumber: Int = 1

    // MARK: - Init

    init() {
        let saved = UserDefaults.standard.double(forKey: "terminalPanelHeight")
        self.panelHeight = saved > 0 ? CGFloat(saved) : 260
    }

    // MARK: - Actions

    /// Toggle panel open/closed. Opening focuses the Terminal tab (Ctrl+`
    /// is terminal-centric) and creates a first session if none exist.
    func toggle(projectDirectory: URL) {
        if isOpen {
            isOpen = false
        } else {
            if sessions.isEmpty {
                _addTab(in: projectDirectory)
            }
            activeDockTab = .terminal
            isOpen = true
        }
    }

    /// Open a new tab and activate it. Also opens the panel if closed.
    func addTab(in directory: URL) {
        _addTab(in: directory)
        isOpen = true
    }

    /// Open a remote SSH session for `host` and reveal the terminal panel.
    /// The PTY (`ssh -t <alias>`) starts when the session view mounts.
    func connectRemote(host: RemoteHost) {
        let session = TerminalSession(
            number: nextTabNumber,
            workingDirectory: FileManager.default.homeDirectoryForCurrentUser,
            remoteAlias: host.alias)
        nextTabNumber += 1
        sessions.append(session)
        activeIndex = sessions.count - 1
        activeDockTab = .terminal
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

    /// Clamp `height` to the allowed range [120, windowHeight × 0.6].
    func clampedHeight(_ height: CGFloat, windowHeight: CGFloat) -> CGFloat {
        guard windowHeight > 0 else { return max(height, 120) }
        let maxH = windowHeight * 0.6
        return min(max(height, 120), maxH)
    }

    // MARK: - Private

    private func _addTab(in directory: URL) {
        let session = TerminalSession(number: nextTabNumber, workingDirectory: directory)
        nextTabNumber += 1
        sessions.append(session)
        activeIndex = sessions.count - 1
    }
}
