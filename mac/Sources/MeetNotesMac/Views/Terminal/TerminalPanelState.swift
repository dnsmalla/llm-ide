import Foundation
import Observation
import SwiftUI

/// Panel-level state: open/closed, height, and the list of tab sessions.
/// Created as `@State` in `AppShell`, propagated via `.environment()`.
@Observable
@MainActor
final class TerminalPanelState {

    // MARK: - State

    var isOpen: Bool = false

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

    /// Toggle panel open/closed. Creates a first tab if none exist yet.
    func toggle(projectDirectory: URL) {
        if isOpen {
            isOpen = false
        } else {
            if sessions.isEmpty {
                _addTab(in: projectDirectory)
            }
            isOpen = true
        }
    }

    /// Open a new tab and activate it. Also opens the panel if closed.
    func addTab(in directory: URL) {
        _addTab(in: directory)
        isOpen = true
    }

    /// Terminate a session and remove its tab.
    /// Closes the panel automatically when the last tab is removed.
    func closeTab(at index: Int) {
        guard index < sessions.count else { return }
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
