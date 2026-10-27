import SwiftUI

/// The OS view: the bundled React page, shown as the Home landing when a
/// project is open (see `AppShell.effectiveHome()`). Not a menu item.
///
/// Takes its session, theme and project from the environment and passes plain
/// values down to `SystemWebView`. The shell is reached only through `onOpen`,
/// so this feature never names Shell.
struct SystemView: View {
    let api: LlmIdeAPIClient
    /// Shows a section the page asked for (`open` message). Shell wires it.
    let onOpen: (ShellSection) -> Void

    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var projectStore: ProjectStore

    var body: some View {
        SystemWebView(
            api: api,
            session: session,
            theme: theme.current,
            projectName: projectStore.activeProject?.bundle.displayName,
            projectRoot: projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath, isDirectory: true) },
            projectId: projectStore.activeProject?.bundle.id,
            onOpen: onOpen)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
