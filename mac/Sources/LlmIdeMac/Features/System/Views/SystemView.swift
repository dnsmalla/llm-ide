import SwiftUI

/// The OS view: graph-kit's bundled page. It is the Graph section's default
/// page (Shell's `GraphSectionView`) and the standalone Home fallback when the
/// Graph section is hidden or compiled out (`ShellSection.resolveHome`). Not a
/// menu item of its own.
///
/// Takes its session, theme and project from the environment and passes plain
/// values down to `SystemWebView`. The shell is reached only through `onOpen`,
/// so this feature never names Shell.
struct SystemView: View {
    let api: LlmIdeAPIClient
    /// Shows a section the page asked for (`open` message). Shell wires it.
    let onOpen: (ShellSection) -> Void
    /// Opens a file the page asked for in Explorer (`openFile` message). Shell wires it.
    let onOpenFile: (URL, Int?) -> Void

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
            onOpen: onOpen,
            onOpenFile: onOpenFile)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
