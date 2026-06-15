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
            projectInfo
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

    @ViewBuilder
    private var projectInfo: some View {
        let t = theme.current
        if let active = projectStore.activeProject {
            let abbreviatedPath = (active.localPath as NSString).abbreviatingWithTildeInPath
            let linkedSuffix = active.bundle.settings.linkedRepo
                .map { ", linked to \($0.remoteId)" } ?? ""
            let a11yLabel = "Project \(active.bundle.displayName), path \(abbreviatedPath)\(linkedSuffix)"

            HStack(spacing: 12) {
                Image(systemName: "folder.fill")
                    .foregroundStyle(t.accent)
                Text(active.bundle.displayName).font(Typography.caption.bold())
                Text(abbreviatedPath)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.textMuted)
                    .lineLimit(1).truncationMode(.middle)
                if let linked = active.bundle.settings.linkedRepo {
                    Spacer().frame(width: 8)
                    Image(systemName: linked.kind == .github ? "circle.dashed" : "g.square")
                        .foregroundStyle(t.textMuted)
                    Text(linked.remoteId).font(.system(size: 11))
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(a11yLabel)
        } else {
            Text("No project")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
        }
    }
}
