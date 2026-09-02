import Foundation
import Observation
import SwiftUI

/// Panel-level state: open/closed and height. Created as `@State` in
/// `AppShell`, propagated via `.environment()`.
///
/// This type stays in Views/Shell (core, always compiled) because AppShell,
/// StatusBar, and ExplorerView all reference `isOpen`/`toggle(projectDirectory:)`
/// unconditionally, regardless of whether the Terminal feature is selected.
///
/// Session management — the tab list, the active dock tab, and the concrete
/// `TerminalSession` type (feature-owned in Views/Terminal because it
/// imports SwiftTerm, which is only linked when `terminal` is selected, see
/// Package.swift) — lives in `TerminalDockSessions`
/// (`Views/Terminal/TerminalDockSessions.swift`) and plugs into `toggle()`
/// via the `onToggleRequested` hook. `FeatureCatalog.installTerminalHooks(on:)`
/// is the ONLY place that installs it, and the ONLY place in the app that
/// tests the Terminal build flag for this state — this file has none.
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

    /// Installed by `FeatureCatalog.installTerminalHooks(on:)` when
    /// `FEATURE_TERMINAL` is compiled in — reacts to a toggle by creating/
    /// focusing a session tab. `nil` in a Terminal-excluded build, where
    /// `toggle()` falls back to a plain open/close flip; harmless, since
    /// `TerminalPanelView` (the only renderer of the dock) is itself
    /// excluded from that build.
    var onToggleRequested: ((TerminalPanelState, URL) -> Void)?

    // MARK: - Init

    init() {
        let saved = UserDefaults.standard.double(forKey: "terminalPanelHeight")
        self.panelHeight = saved > 0 ? CGFloat(saved) : 260
    }

    // MARK: - Actions

    /// Toggle panel open/closed. Opening focuses the Terminal tab (Ctrl+`
    /// is terminal-centric) and creates a first session if none exist — see
    /// `TerminalDockSessions.handleToggle(_:projectDirectory:)`, wired in as
    /// `onToggleRequested`.
    func toggle(projectDirectory: URL) {
        if let onToggleRequested {
            onToggleRequested(self, projectDirectory)
        } else {
            isOpen.toggle()
        }
    }

    /// Clamp `height` to the allowed range [120, windowHeight × 0.6].
    func clampedHeight(_ height: CGFloat, windowHeight: CGFloat) -> CGFloat {
        guard windowHeight > 0 else { return max(height, 120) }
        let maxH = windowHeight * 0.6
        return min(max(height, 120), maxH)
    }
}
