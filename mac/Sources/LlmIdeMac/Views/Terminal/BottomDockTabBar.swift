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
        .background(Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.13, alpha: 1)))
    }

    private func tabButton(_ tab: BottomDockTab) -> some View {
        let isActive = state.activeDockTab == tab
        return Button {
            state.activeDockTab = tab
        } label: {
            Text(tab.title.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(isActive ? Color.white : Color(nsColor: .systemGray))
                .padding(.horizontal, 9)
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
                .foregroundStyle(Color(nsColor: .lightGray))
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// Muted placeholder shown for the non-functional dock tabs (Problems,
/// Output, Debug Console, Ports, GitLens). Matches the dark terminal chrome.
struct BottomDockPlaceholder: View {
    let tab: BottomDockTab

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: tab.systemImage)
                .font(.system(size: 24, weight: .thin))
                .foregroundStyle(Color(nsColor: .systemGray))
            Text(tab.placeholder)
                .font(.system(size: 12))
                .foregroundStyle(Color(nsColor: .systemGray))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: NSColor(red: 0.1, green: 0.1, blue: 0.11, alpha: 1)))
    }
}
