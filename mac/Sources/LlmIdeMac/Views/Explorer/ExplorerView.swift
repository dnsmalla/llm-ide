import SwiftUI
import AppKit

/// Project file browser. Left pane is a lazy filesystem tree rooted at the
/// active project's local folder; right pane opens tapped files into
/// closable editor tabs (the same EditorTabBar + FileDetailView the Review
/// Code tab uses).
struct ExplorerView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject private var projectStore: ProjectStore
    @EnvironmentObject private var config: AppConfig

    // Lazy tree state: which folders are expanded, and a cache of each
    // expanded folder's children (filled on first expand so repeated
    // toggles don't re-hit the filesystem).
    @State private var expanded: Set<String> = []
    @State private var childrenCache: [String: [FileSystemTree.Node]] = [:]

    // Editor tabs.
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?

    // Git status decorations for the file tree (VS Code-style coloring).
    @State private var decorations = GitStatusStore()
    @Environment(\.controlActiveState) private var controlActiveState

    // Bottom terminal dock (shared, rendered at AppShell level) — toggled
    // from this view's toolbar.
    @Environment(TerminalPanelState.self) private var terminalState
    @Environment(ShellState.self) private var shell

    // Cursor/VSCode-style panel visibility. Tree shows by default; the AI
    // chat panel's open-state lives on ShellState (app-session scope) so it
    // survives navigating away and back — see shell.exploreChatVisible.
    @State private var treeVisible = true
    /// Persisted chat-panel width (HSplitView has no width binding — read it
    /// back via GeometryReader, same pattern as ReviewView).
    @AppStorage("EXPLORER_CHAT_PANEL_WIDTH") private var chatPanelWidth: Double = 180

    /// The Explorer is the code-browsing pane, so it roots at the active
    /// project's `code/` folder (where repos clone to) — not the whole project
    /// (source/data/notes are managed in the Library). Falls back to the
    /// resolved workspace root when no project is open (repo-only/legacy use).
    private var root: URL? {
        if let code = projectStore.activeProjectCodeDir { return code }
        return WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }

    /// cwd for the embedded terminal dock — mirrors AppShell.projectDirectory
    /// (active repo / project folder, home as last resort).
    private var projectDirectory: URL {
        WorkspaceRoot.resolveOrHome(config: config, projectStore: projectStore)
    }

    var body: some View {
        VStack(spacing: 0) {
            explorerControlBar
            Divider()
            // The file tree is a FIXED-width column OUTSIDE the HSplitView.
            // HSplitView doesn't reliably honor a leading child's
            // idealWidth/maxWidth (it let the tree balloon past its cap), so
            // pinning the width here is the only dependable way to keep the
            // first panel minimal. HSplitView still drives the editor ↔ chat
            // split, which resizes correctly.
            HStack(spacing: 0) {
                if treeVisible {
                    treePane
                        .frame(width: 240)
                        .transition(.move(edge: .leading))
                    Divider()
                }
                // Editor + chat split, with the shared terminal dock BELOW
                // just this column — so the terminal sits to the RIGHT of the
                // file tree (VS Code / Cursor layout), never spanning under it.
                VStack(spacing: 0) {
                    HSplitView {
                        editorArea
                            .frame(minWidth: 360, maxWidth: .infinity)

                        if shell.exploreChatVisible {
                            CodeAssistantPanel(api: api,
                                               initialURL: activeTab,
                                               showFileAttachButtons: true,
                                               showModelPicker: true)
                                .persistedPanelWidth($chatPanelWidth, minWidth: 180, floor: 220)
                                .transition(.move(edge: .trailing))
                        }
                    }
                    TerminalPanelView(projectDirectory: projectDirectory)
                }
            }
        // Reset all per-project state when the active project changes, so the
        // tree, cache, and open tabs never show a previous project's files
        // (and the cache can't grow unbounded across switches).
        .onChange(of: root?.path) { _, _ in
            expanded.removeAll()
            childrenCache.removeAll()
            tabs.removeAll()
            activeTab = nil
        }
        // Refresh decorations when the project root changes / on appear.
        .task(id: root?.path) { await decorations.refresh(root: root) }
        // Re-check git status when the window regains key focus (VS Code does
        // the same — picks up edits made via terminal/other tools).
        .onChange(of: controlActiveState) { _, state in
            if state == .key { Task { await decorations.refresh(root: root) } }
        }
        }
    }

    // MARK: - Inline panel toggles (tree · chat)
    // Kept inside the section (not the window title bar) so every section's
    // header stays identical. Terminal has its own toggle in the status bar.

    private var explorerControlBar: some View {
        HStack(spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { treeVisible.toggle() }
            } label: {
                Image(systemName: "sidebar.left")
                    .symbolVariant(treeVisible ? .fill : .none)
            }
            .buttonStyle(.borderless)
            .help(treeVisible ? "Hide Files" : "Show Files")
            // Explorer ⇄ Source Control switcher, right after the panel toggle.
            PanelSectionTabs()
            Spacer(minLength: 0)
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { shell.exploreChatVisible.toggle() }
            } label: {
                Image(systemName: "sidebar.right")
                    .symbolVariant(shell.exploreChatVisible ? .fill : .none)
            }
            .buttonStyle(.borderless)
            .help(shell.exploreChatVisible ? "Hide Chat" : "Show Chat")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.bar)
    }

    // MARK: - Tree pane

    @ViewBuilder
    private var treePane: some View {
        if let root {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(children(of: root)) { node in
                        treeRow(node, depth: 0)
                    }
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(NSColor.windowBackgroundColor))
        } else {
            emptyState
        }
    }

    /// Recursive row: a folder toggles expansion (and renders its children
    /// when expanded); a file opens a tab on tap. Returns AnyView so the
    /// opaque return type isn't defined in terms of itself (the recursive
    /// child call would otherwise be self-referential).
    private func treeRow(_ node: FileSystemTree.Node, depth: Int) -> AnyView {
        if node.isDirectory {
            let isExpanded = expanded.contains(node.id)
            return AnyView(
                VStack(alignment: .leading, spacing: 0) {
                    folderRow(node, depth: depth, expanded: isExpanded)
                    if isExpanded {
                        ForEach(children(of: node.url)) { child in
                            treeRow(child, depth: depth + 1)
                        }
                    }
                }
            )
        } else {
            return AnyView(fileRow(node, depth: depth))
        }
    }

    private func folderRow(_ node: FileSystemTree.Node, depth: Int, expanded isExpanded: Bool) -> some View {
        let deco = root.flatMap {
            decorations.decoration(forAbsolute: node.url, root: $0, isDirectory: true)
        }
        return Button {
            toggle(node)
        } label: {
            TreeRowLabel(name: node.name, isFolder: true, isExpanded: isExpanded,
                         depth: depth, isSelected: false, gitStatus: deco)
        }
        .buttonStyle(.plain)
        .help(node.name)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
    }

    private func fileRow(_ node: FileSystemTree.Node, depth: Int) -> some View {
        let ext = node.url.pathExtension.lowercased()
        let selected = activeTab == node.url
        let deco = root.flatMap {
            decorations.decoration(forAbsolute: node.url, root: $0, isDirectory: false)
        }
        return Button {
            open(node.url)
        } label: {
            TreeRowLabel(name: node.name, isFolder: false, isExpanded: false,
                         depth: depth, isSelected: selected, fileExtension: ext, gitStatus: deco)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(selected ? Color.accentColor.opacity(0.22) : Color.clear)
        )
        .help(node.name)
        .contextMenu {
            Button("Reveal in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([node.url])
            }
        }
    }

    // MARK: - Editor area

    @ViewBuilder
    private var editorArea: some View {
        VStack(spacing: 0) {
            if !tabs.isEmpty {
                EditorTabBar(tabs: $tabs, activeTab: $activeTab)
                Divider()
            }
            if let url = activeTab {
                FileDetailView(url: url)
                    .id(url)
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "folder")
                        .font(.system(size: 40, weight: .thin))
                        .foregroundStyle(.quaternary)
                    Text("Select a file to view")
                        .font(Typography.emptyTitle)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
            }
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "folder")
                .font(.system(size: 40, weight: .thin))
                .foregroundStyle(.quaternary)
            Text("Open a project or activate a repo to browse files.")
                .font(Typography.emptyTitle)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }

    // MARK: - Behavior

    /// Lazily resolved children of a directory, cached by path so repeated
    /// renders/toggles don't re-enumerate.
    private func children(of dir: URL) -> [FileSystemTree.Node] {
        if let cached = childrenCache[dir.path] { return cached }
        let nodes = FileSystemTree.children(of: dir)
        childrenCache[dir.path] = nodes
        return nodes
    }

    private func toggle(_ node: FileSystemTree.Node) {
        if expanded.contains(node.id) {
            expanded.remove(node.id)
        } else {
            // Warm the cache on first expand.
            if childrenCache[node.url.path] == nil {
                childrenCache[node.url.path] = FileSystemTree.children(of: node.url)
            }
            expanded.insert(node.id)
        }
    }

    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }
}
