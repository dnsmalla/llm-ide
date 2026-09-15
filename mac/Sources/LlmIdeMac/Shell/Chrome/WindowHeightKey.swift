import SwiftUI

/// Lets AppShell broadcast its content height down to any panel that needs
/// it without polluting that panel's own layout.
///
/// NOTE: lives in Views/Shell (a core, always-compiled folder), not
/// Views/Terminal, even though today's only consumer is
/// `TerminalPanelView` — AppShell publishes it unconditionally (it has no
/// `FEATURE_TERMINAL` gate around the `.preference(key: WindowHeightKey.self, …)`
/// call), so the type must stay compiled regardless of the terminal
/// feature's inclusion. Moved out of `TerminalPanelView.swift` during
/// Phase 2b Task 3 when a lite build (`terminal` excluded) failed with
/// "cannot find 'WindowHeightKey' in scope" at the AppShell call site.
struct WindowHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
