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

    @State private var showProjectPaths = false

    // Lazy tree state: which folders are expanded, and a cache of each
    // expanded folder's children (filled on first expand so repeated
    // toggles don't re-hit the filesystem).
    @State private var expanded: Set<String> = []
    @State private var childrenCache: [String: [FileSystemTree.Node]] = [:]

    // Selected tree row (folder or file) — VS Code/Cursor-style: distinct
    // from expand/collapse and from the open editor tab. The toolbar's New
    // File / New Folder buttons target this (or its parent, for a selected
    // file) instead of always creating at the workspace root.
    @State private var selectedURL: URL?

    // Editor tabs.
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?

    // File-op prompt state: a create/rename sheet, a delete confirmation, and
    // an inline error for the sheet / an alert for delete failures.
    @State private var filePrompt: FilePrompt?
    @State private var fileOpError: String?
    @State private var pendingDelete: URL?
    @State private var deleteError: String?

    // Git status decorations for the file tree (VS Code-style coloring).
    @State private var decorations = GitStatusStore()
    @Environment(\.controlActiveState) private var controlActiveState

    // Bottom terminal dock (shared, rendered at AppShell level) — toggled
    // from this view's toolbar.
    @Environment(TerminalPanelState.self) private var terminalState

    // Cursor/VSCode-style panel visibility. Tree shows by default; the AI
    // chat panel's open-state is persisted (default open) so the chat reads
    // as the primary surface everywhere — same pattern as Review / Visual /
    // DocGen. A manual close sticks across launches.
    @State private var treeVisible = true
    @AppStorage("EXPLORER_CHAT_VISIBLE") private var chatVisible = true
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

                        if chatVisible {
                            CodeAssistantPanel(api: api,
                                               scope: .explorer,
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
            selectedURL = nil
        }
        // Refresh decorations when the project root changes / on appear.
        .task(id: root?.path) { await decorations.refresh(root: root) }
        // Re-check git status when the window regains key focus (VS Code does
        // the same — picks up edits made via terminal/other tools).
        .onChange(of: controlActiveState) { _, state in
            if state == .key { Task { await decorations.refresh(root: root) } }
        }
        .firstLaunchOpenChat(flagKey: "DID_AUTO_OPEN_EXPLORE_CHAT_V1",
                             width: $chatPanelWidth, visible: $chatVisible)
        .sheet(item: $filePrompt) { prompt in
            FileNamePromptSheet(mode: prompt.mode, initialName: prompt.initialName,
                                error: $fileOpError) { name in
                do {
                    try performFileOp(prompt, name)
                    filePrompt = nil
                    fileOpError = nil
                } catch {
                    fileOpError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
                }
            } onCancel: {
                filePrompt = nil
                fileOpError = nil
            }
        }
        .confirmationDialog(
            pendingDelete.map { "Move “\($0.lastPathComponent)” to the Trash?" } ?? "",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Move to Trash", role: .destructive) {
                if let url = pendingDelete { delete(url) }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("You can undo this in Finder.")
        }
        .alert("Couldn’t complete the operation",
               isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })) {
            Button("OK", role: .cancel) { deleteError = nil }
        } message: {
            Text(deleteError ?? "")
        }
        .sheet(isPresented: $showProjectPaths) {
            ProjectPathsSheet()
        }
        }
    }

    // MARK: - Inline panel toggles (tree · chat)
    // Kept inside the section (not the window title bar) so every section's
    // header stays identical. Terminal has its own toggle in the status bar.

    private var explorerControlBar: some View {
        SectionChromeBar(
            toggles: [
                SectionToggle(icon: "sidebar.left", isOn: treeVisible,
                              helpOn: "Hide Files", helpOff: "Show Files") {
                    withAnimation(.easeInOut(duration: 0.2)) { treeVisible.toggle() }
                }
            ],
            // Explorer ⇄ Source Control switcher, right after the panel toggle.
            leading: { PanelSectionTabs() }
        ) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { chatVisible.toggle() }
            } label: {
                Image(systemName: "sidebar.right").symbolVariant(chatVisible ? .fill : .none)
            }
            .buttonStyle(.borderless)
            .help(chatVisible ? "Hide Chat" : "Show Chat")
        }
    }

    // MARK: - Tree pane

    @ViewBuilder
    private var treePane: some View {
        if let root {
            // When the workspace root's only child is a single folder (the
            // common single-repo case — root is the project's code/
            // container, its one child is the cloned repo), display AT that
            // folder instead of wrapping it in an extra collapsible row.
            // Mirrors VS Code/Cursor opening a folder directly: the folder's
            // name becomes the fixed header, its contents are the top-level
            // rows. A multi-repo project (2+ children under code/) keeps
            // each repo as its own top-level collapsible row, unchanged.
            let displayRoot = effectiveDisplayRoot(root)
            VStack(spacing: 0) {
                treeToolbar(root: root, displayRoot: displayRoot)
                Divider()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(children(of: displayRoot)) { node in
                            treeRow(node, depth: 0)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Color(NSColor.windowBackgroundColor))
            }
        } else {
            emptyState
        }
    }

    /// See `treePane` doc comment. Pure function of already-loaded children
    /// so it doesn't trigger extra filesystem work beyond the normal
    /// top-level `children(of:)` call the tree already makes.
    private func effectiveDisplayRoot(_ root: URL) -> URL {
        let kids = children(of: root)
        if kids.count == 1, kids[0].isDirectory { return kids[0].url }
        return root
    }

    /// Where the toolbar's New File / New Folder buttons create — the
    /// selected folder, the parent of a selected file, or `displayRoot`
    /// when nothing is selected. VS Code/Cursor: toolbar actions target the
    /// current tree selection, not always the workspace root — previously
    /// these buttons always created at `root`, silently ignoring whatever
    /// folder the user had clicked.
    private func toolbarTargetDir(displayRoot: URL) -> URL {
        guard let selectedURL else { return displayRoot }
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: selectedURL.path, isDirectory: &isDir)
        return (exists && isDir.boolValue) ? selectedURL : selectedURL.deletingLastPathComponent()
    }

    private func treeToolbar(root: URL, displayRoot: URL) -> some View {
        let targetDir = toolbarTargetDir(displayRoot: displayRoot)
        return HStack(spacing: 2) {
            Text(displayRoot == root
                 ? (projectStore.activeProject?.bundle.displayName ?? displayRoot.lastPathComponent)
                 : displayRoot.lastPathComponent)
                .font(Typography.filename.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .contextMenu {
                    Button("New File") { filePrompt = .newFile(in: displayRoot) }
                    Button("New Folder") { filePrompt = .newFolder(in: displayRoot) }
                    // Only offered when displayRoot is a real folder we
                    // auto-descended into (single-repo case) — it's no
                    // longer rendered as its own tree row, so this is the
                    // only place left to reach Rename/Delete for it. When
                    // displayRoot == root it's the code/ container itself,
                    // not a renameable/deletable entity.
                    if displayRoot != root {
                        Button("Rename") { filePrompt = .rename(url: displayRoot) }
                        Button("Delete") { pendingDelete = displayRoot }
                    }
                    Divider()
                    Button("Reveal in Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([displayRoot])
                    }
                }
            Spacer(minLength: 4)
            if projectStore.activeProject != nil {
                Button { showProjectPaths = true } label: {
                    Image(systemName: "folder.badge.gearshape")
                }
                .buttonStyle(.borderless)
                .help("Project folders")
            }
            Button { filePrompt = .newFile(in: targetDir) } label: {
                Image(systemName: "doc.badge.plus")
            }
            .buttonStyle(.borderless).help("New File")
            Button { filePrompt = .newFolder(in: targetDir) } label: {
                Image(systemName: "folder.badge.plus")
            }
            .buttonStyle(.borderless).help("New Folder")
            Button { refreshAll() } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless).help("Refresh")
            Button { collapseAll() } label: {
                Image(systemName: "rectangle.compress.vertical")
            }
            .buttonStyle(.borderless).help("Collapse All")
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
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
        let isSelected = selectedURL == node.url
        return Button {
            selectedURL = node.url
            toggle(node)
        } label: {
            TreeRowLabel(name: node.name, isFolder: true, isExpanded: isExpanded,
                         depth: depth, isSelected: isSelected, gitStatus: deco)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(isSelected ? Color.accentColor.opacity(0.22) : Color.clear)
        )
        .help(node.name)
        .contextMenu {
            Button("New File") { filePrompt = .newFile(in: node.url) }
            Button("New Folder") { filePrompt = .newFolder(in: node.url) }
            Button("Rename") { filePrompt = .rename(url: node.url) }
            Button("Delete") { pendingDelete = node.url }
            Divider()
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
            selectedURL = node.url
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
            Button("New File") { filePrompt = .newFile(in: node.url.deletingLastPathComponent()) }
            Button("New Folder") { filePrompt = .newFolder(in: node.url.deletingLastPathComponent()) }
            Button("Rename") { filePrompt = .rename(url: node.url) }
            Button("Delete") { pendingDelete = node.url }
            Divider()
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
        EmptyStateView(
            icon: "folder",
            title: "No files to browse yet",
            message: "Open a project, or use Explorer → Project folders to inspect the folder layout.",
            actionLabel: "Open Settings",
            action: { NotificationCenter.default.post(name: .openSection, object: "settings") }
        )
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

    /// Run a create/rename op, then refresh the affected folder + git
    /// decorations. Throws up to the sheet handler so a bad name surfaces inline.
    private func performFileOp(_ prompt: FilePrompt, _ name: String) throws {
        switch prompt.mode {
        case .newFile:
            let url = try ExplorerFileOps.createFile(in: prompt.dir, name: name)
            invalidate(prompt.dir); expand(prompt.dir); open(url)
            selectedURL = url
        case .newFolder:
            let url = try ExplorerFileOps.createFolder(in: prompt.dir, name: name)
            invalidate(prompt.dir); expand(prompt.dir)
            selectedURL = url
        case .rename:
            guard let url = prompt.url else { return }
            let new = try ExplorerFileOps.rename(url, to: name)
            invalidate(url.deletingLastPathComponent())
            tabs = tabs.map { $0 == url ? new : $0 }
            if activeTab == url { activeTab = new }
            if selectedURL == url { selectedURL = new }
        }
        Task { await decorations.refresh(root: root) }
    }

    /// Delete (trash) a file/folder, close tabs under it, refresh.
    private func delete(_ url: URL) {
        do {
            try ExplorerFileOps.trash(url)
            invalidate(url.deletingLastPathComponent())
            tabs.removeAll { $0 == url || $0.path.hasPrefix(url.path + "/") }
            if let active = activeTab, active == url || active.path.hasPrefix(url.path + "/") {
                activeTab = tabs.last
            }
            if let selected = selectedURL, selected == url || selected.path.hasPrefix(url.path + "/") {
                selectedURL = nil
            }
            Task { await decorations.refresh(root: root) }
        } catch {
            deleteError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Drop the cached children of `dir` so the next render re-enumerates.
    private func invalidate(_ dir: URL) {
        childrenCache.removeValue(forKey: dir.path)
    }

    /// Ensure `dir` is expanded and its children are loaded.
    private func expand(_ dir: URL) {
        if childrenCache[dir.path] == nil {
            childrenCache[dir.path] = FileSystemTree.children(of: dir)
        }
        expanded.insert(dir.path)
    }

    /// Full tree + git refresh (toolbar Refresh).
    private func refreshAll() {
        childrenCache.removeAll()
        Task { await decorations.refresh(root: root) }
    }

    /// Collapse every expanded folder (toolbar Collapse All), VS Code-style.
    private func collapseAll() {
        expanded.removeAll()
    }

    private struct FilePrompt: Identifiable {
        // Alias the sheet's Mode so prompt.mode is directly assignable to
        // FileNamePromptSheet(mode:) — same cases, single source of truth.
        typealias Mode = FileNamePromptSheet.Mode
        let mode: Mode
        let dir: URL
        let url: URL?
        let initialName: String
        var id: String { "\(mode):\(url?.path ?? dir.path)" }

        static func newFile(in dir: URL) -> FilePrompt {
            FilePrompt(mode: .newFile, dir: dir, url: nil, initialName: "")
        }
        static func newFolder(in dir: URL) -> FilePrompt {
            FilePrompt(mode: .newFolder, dir: dir, url: nil, initialName: "")
        }
        static func rename(url: URL) -> FilePrompt {
            FilePrompt(mode: .rename, dir: url.deletingLastPathComponent(), url: url, initialName: url.lastPathComponent)
        }
    }
}
