import SwiftUI
import AppKit

/// VSCode-style tab strip for the bottom dock: Problems · Output · Debug
/// Console · Terminal · Ports · GitLens. Selecting a tab switches the dock
/// content; only Terminal is live. The right side carries the Terminal's
/// "new session" control (when active) and a close-panel button.
struct BottomDockTabBar: View {
    @Environment(TerminalPanelState.self) private var state
    @EnvironmentObject var theme: ThemeStore
    let projectDirectory: URL

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(BottomDockTab.allCases) { tab in
                        tabButton(tab)
                    }
                }
                .padding(.horizontal, 6)
            }

            Spacer(minLength: 0)

            HStack(spacing: 2) {
                if state.activeDockTab == .terminal {
                    iconButton("plus", help: "New Terminal") {
                        state.addTab(in: projectDirectory)
                    }
                }
                iconButton("xmark", help: "Close Panel") {
                    state.isOpen = false
                }
            }
            .padding(.horizontal, 6)
        }
        .frame(height: 32)
        .background(theme.current.surface)
    }

    private func tabButton(_ tab: BottomDockTab) -> some View {
        let isActive = state.activeDockTab == tab
        return Button {
            state.activeDockTab = tab
        } label: {
            // Title-case, normal-weight labels (VS Code / Cursor style) — not
            // the old uppercased + letter-spaced chips. Active tab is darker
            // with a thin accent underline.
            Text(tab.title)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(isActive ? theme.current.text : theme.current.textMuted)
                .padding(.horizontal, 10)
                .frame(height: 32)
                .overlay(alignment: .bottom) {
                    if isActive {
                        Rectangle()
                            .frame(height: 1.5)
                            .foregroundStyle(theme.current.accent)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tab.title)
    }

    private func iconButton(_ name: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(theme.current.textMuted)
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// Muted placeholder shown for the non-functional dock tabs (Problems,
/// Output, Debug Console, Ports, GitLens). Theme-aware to match the rest
/// of the app chrome.
struct BottomDockPlaceholder: View {
    @EnvironmentObject var theme: ThemeStore
    let tab: BottomDockTab

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: tab.systemImage)
                .font(.system(size: 24, weight: .thin))
                .foregroundStyle(theme.current.textMuted)
            Text(tab.placeholder)
                .font(.system(size: 12))
                .foregroundStyle(theme.current.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.current.body)
    }
}
