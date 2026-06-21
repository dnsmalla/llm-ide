import SwiftUI

/// The full terminal panel: drag handle → tab bar → terminal views.
///
/// **Important:** The ZStack of `TerminalSessionView`s is always present in
/// the view hierarchy (just zero-height when closed).  This keeps every
/// `LocalProcessTerminalView` alive — PTY processes keep running and
/// scrollback is fully preserved across open/close toggle cycles, exactly
/// like Cursor's behaviour.
struct TerminalPanelView: View {
    @Environment(TerminalPanelState.self) private var state
    @EnvironmentObject var theme: ThemeStore

    let projectDirectory: URL

    /// `nil` when no drag is in progress; set to the height at drag-start
    /// so we can compute delta correctly.  Using Optional avoids the 0.0
    /// sentinel anti-pattern and correctly handles a panel snapped to 0.
    @State private var dragStartHeight: CGFloat? = nil
    /// Populated by the window-level GeometryReader in AppShell, injected
    /// via preference key so we don't corrupt our own layout.
    @State private var windowHeight: CGFloat = 800
    /// Tracks whether the cursor was pushed so pop() is always balanced.
    @State private var cursorPushed = false

    var body: some View {
        // ── Window-height probe ──────────────────────────────────────────
        // We read it via a preference key set by a full-window GeometryReader
        // in AppShell so we don't accidentally constrain our own height to 0.
        Color.clear
            .frame(height: 0)
            .onPreferenceChange(WindowHeightKey.self) { h in
                if h > 0 { windowHeight = h }
            }

        // ── Bottom dock — present whenever open OR a session is alive ─────
        // Keeping the session NSViews in the hierarchy is what preserves PTYs
        // and scrollback across open/close toggles (Ctrl+`). The dock renders
        // even with no sessions so the placeholder tabs (Problems/Output/…)
        // can show.
        if state.isOpen || !state.sessions.isEmpty {
            VStack(spacing: 0) {
                if state.isOpen {
                    resizeHandle
                    // VSCode-style dock tab strip (Problems/Output/…/Terminal).
                    BottomDockTabBar(projectDirectory: projectDirectory)
                    Divider()
                    // Terminal's own session pills, only under the Terminal tab.
                    if state.activeDockTab == .terminal {
                        TerminalTabBar(projectDirectory: projectDirectory)
                        Divider()
                    }
                }
                dockContent
            }
            // When closed: collapse to zero height so layout is undisturbed.
            .frame(height: state.isOpen ? state.panelHeight : 0)
            .clipped()
            .overlay(state.isOpen ? Divider() : nil, alignment: .top)
        }
    }

    // MARK: - Dock content

    /// The terminal session ZStack stays mounted (PTYs alive) but is hidden
    /// when a non-terminal dock tab is selected; the placeholder is overlaid
    /// for those tabs.
    private var dockContent: some View {
        ZStack {
            ZStack {
                ForEach(Array(state.sessions.enumerated()), id: \.element.id) { idx, session in
                    TerminalSessionView(session: session)
                        .opacity(idx == state.activeIndex ? 1 : 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.current.body)   // follow the theme (was hardcoded black)
            .opacity(state.activeDockTab == .terminal ? 1 : 0)
            .allowsHitTesting(state.activeDockTab == .terminal)

            if state.activeDockTab != .terminal {
                BottomDockPlaceholder(tab: state.activeDockTab)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Resize Handle

    private var resizeHandle: some View {
        Rectangle()
            .fill(theme.current.border)
            .frame(height: 4)
            .frame(maxWidth: .infinity)
            .onHover { inside in
                if inside {
                    if !cursorPushed {
                        NSCursor.resizeUpDown.push()
                        cursorPushed = true
                    }
                } else {
                    if cursorPushed {
                        NSCursor.pop()
                        cursorPushed = false
                    }
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if dragStartHeight == nil {
                            dragStartHeight = state.panelHeight
                        }
                        // Dragging up (negative translation) increases height.
                        let newH = (dragStartHeight ?? state.panelHeight) - value.translation.height
                        state.panelHeight = state.clampedHeight(newH, windowHeight: windowHeight)
                    }
                    .onEnded { _ in
                        dragStartHeight = nil
                        // Ensure cursor is restored if drag ended outside hover area.
                        if cursorPushed {
                            NSCursor.pop()
                            cursorPushed = false
                        }
                    }
            )
    }
}

// MARK: - Window Height Preference Key

/// Lets AppShell broadcast its height down to TerminalPanelView without
/// polluting TerminalPanelView's own layout.
struct WindowHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
