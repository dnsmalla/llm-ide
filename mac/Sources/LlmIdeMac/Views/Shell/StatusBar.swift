import SwiftUI

struct StatusBar: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var config: AppConfig
    @Environment(TerminalPanelState.self) private var terminalState

    /// Working directory for the terminal — mirrors AppShell.projectDirectory:
    /// prefer the active SCM repo, then the project folder, then home.
    private var terminalCwd: URL {
        WorkspaceRoot.resolveOrHome(config: config, projectStore: projectStore)
    }

    var body: some View {
        // The bar is always visible IF the user is signed in — the
        // agent badge needs to be reachable from any screen
        // (including Welcome, where there's no active project).
        // Pre-login (LoginView) we hide it; the chrome would just
        // be empty noise next to a centered auth form.
        if session.accessToken != nil {
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        let t = theme.current
        HStack(spacing: 12) {
            ProjectSwitcher()
            Spacer()
            terminalToggleButton
            AgentStatusBadge(api: api)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(t.surface)
        .frame(maxWidth: .infinity, minHeight: 24)
        .overlay(Divider(), alignment: .top)
    }

    @ViewBuilder
    private var terminalToggleButton: some View {
        Button {
            terminalState.toggle(projectDirectory: terminalCwd)
        } label: {
            Image(systemName: "terminal")
                .font(.system(size: 11))
                .foregroundStyle(
                    terminalState.isOpen
                        ? theme.current.accent
                        : theme.current.textMuted
                )
        }
        .buttonStyle(.plain)
        .help("Toggle Terminal  (⌃`)")
    }

}
