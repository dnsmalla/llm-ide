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

    /// The tree's model — children cache, expansion, and selection. Replaces
    /// the three `@State` properties that used to live here; `children(of:)`
    /// wrote into one of them from inside `body`, which SwiftUI forbids
    /// (design §3 finding #9).
    @State private var store = ExplorerTreeStore()

    /// `root` with its symlinks resolved, paired with the raw path it was
    /// resolved FROM so a stale value can be detected without re-resolving.
    ///
    /// Two reasons this is resolved once, in the `.task` below, and never per
    /// render. (1) `FileManager.contentsOfDirectory(at:)` fails `ENOTDIR` on a
    /// symlinked directory URL, so a symlinked workspace root enumerates empty
    /// — a `FileSystemTree` bug that predates this tree, routed around here at
    /// the boundary where the view hands a root to the store. (2) Every URL in
    /// the store is standardized on the way in, and `List(selection:)` matches
    /// rows by raw `URL` hashing, so the root must arrive in the same spelling
    /// or nothing would ever highlight. `ExplorerPaths.canonical(_:)` is a
    /// syscall — boundary-only, never in a hot path.
    @State private var treeRoot: ResolvedRoot?

    /// True once `restoreState` has run for the CURRENT `treeRoot`.
    ///
    /// The persistence observers below must stay quiet until then.
    /// `store.reset()` empties `expanded` and `selection`, which fires those
    /// observers, and `persistState` overwrites the saved blob
    /// unconditionally — so without this gate every project switch would save
    /// `{[], []}` over the tree shape the very next line of the `.task` is
    /// about to restore, and the tree would come back collapsed every time.
    @State private var treeStateRestored = false

    // Editor tabs.
    @State private var tabs: [URL] = []
    @State private var activeTab: URL?

    // File-op prompt state: a create/rename sheet, a delete confirmation, and
    // an inline error for the sheet / an alert for delete failures.
    @State private var filePrompt: FilePrompt?
    @State private var fileOpError: String?
    /// Pending trash targets (empty = no confirmation showing). A LIST because
    /// the tree is multi-select now.
    @State private var pendingDelete: [URL] = []
    @State private var deleteError: String?

    // Git status decorations for the file tree (VS Code-style coloring).
    @State private var decorations = GitTruthStore()
    @Environment(\.controlActiveState) private var controlActiveState

    // Cursor/VSCode-style panel visibility. Tree shows by default; the AI
    // chat panel's open-state is persisted (default open) so the chat reads
    // as the primary surface everywhere — same pattern as Review / Visual /
    // DocGen. A manual close sticks across launches.
    @State private var treeVisible = true
    @AppStorage("EXPLORER_CHAT_VISIBLE") private var chatVisible = true
    /// Persisted chat-panel width (HSplitView has no width binding — read it
    /// back via GeometryReader, same pattern as ReviewView).
    @AppStorage("EXPLORER_CHAT_PANEL_WIDTH") private var chatPanelWidth: Double = 180
    /// Persisted file-tree width. The tree column is pinned OUTSIDE the
    /// HSplitView (see `body`), so it gets an explicit draggable divider
    /// rather than `persistedPanelWidth`.
    @AppStorage("EXPLORER_TREE_WIDTH") private var treeWidth: Double = 240

    /// The Explorer is the code-browsing pane, so it roots at the active
    /// project's `code/` folder (where repos clone to) — not the whole project
    /// (source/data/notes are managed in the Library). Falls back to the
    /// resolved workspace root when no project is open (repo-only/legacy use).
    private var root: URL? {
        if let code = projectStore.activeProjectCodeDir { return code }
        return WorkspaceRoot.resolve(config: config, projectStore: projectStore)
    }

    /// The root the store is actually keyed on. Pure — it never resolves
    /// anything itself, it only reports whether the value the `.task` resolved
    /// still belongs to the current `root`.
    ///
    /// Falling back to `root` for the one render before the task lands is safe
    /// (and is what avoids an empty-state flash on every project switch):
    /// nothing is ever LOADED under the unresolved spelling, so that frame
    /// renders an empty tree, never another project's.
    private func treeBase(_ root: URL) -> URL {
        guard let resolved = treeRoot, resolved.rawPath == root.path else { return root }
        return resolved.url
    }

    private struct ResolvedRoot {
        let rawPath: String
        let url: URL
    }

    /// The git working tree — a DIFFERENT root from `root` above.
    ///
    /// `root` is the tree root (`<project>/code`, a container of clones with
    /// no `.git` of its own). Passing that to the decoration store is exactly
    /// why Explorer's git colors were dead: `refresh` requires `root/.git` and
    /// correctly degraded to "no decorations". Decorations must resolve
    /// against the actual working tree instead.
    private var gitRoot: URL? {
        WorkspaceRoot.gitWorkingTree(config: config, projectStore: projectStore)
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
                        .frame(width: CGFloat(treeWidth))
                        .transition(.move(edge: .leading))
                    ResizableDivider(width: $treeWidth)
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
                    FeatureCatalog.terminalPanel(projectDirectory: projectDirectory)
                }
            }
        // Rebuild all per-project tree state when the active project changes,
        // so one project's tree/selection/tabs never show under another.
        .task(id: root?.path) {
            treeStateRestored = false
            store.reset()          // also stops the previous root's watcher
            tabs.removeAll()
            activeTab = nil
            guard let root else {
                treeRoot = nil
                return
            }
            // The ONE place the root's symlinks are resolved — see `treeRoot`.
            let base = ExplorerPaths.canonical(root)
            treeRoot = ResolvedRoot(rawPath: root.path, url: base)
            await store.loadChildren(of: base)
            // `.task(id:)` cancels this run when the project changes, but a
            // cancelled Swift task keeps executing past an `await` unless it
            // checks — and `loadChildren`'s inner work is deliberately
            // non-cancellable. `treeRoot` is stamped synchronously by the
            // newest run, so a superseded one sees a mismatch and bails
            // instead of restoring the OLD project's expansion into the store
            // the new run just reset, or watching the old root.
            guard treeRoot?.rawPath == root.path else { return }
            let shown = store.displayRoot(for: base)
            if shown != base { await store.loadChildren(of: shown) }
            guard treeRoot?.rawPath == root.path else { return }
            await store.restoreState(for: base)
            guard treeRoot?.rawPath == root.path else { return }
            treeStateRestored = true
            store.startWatching(base)
        }
        // Persist expansion/selection as they change (cheap: one small JSON
        // blob), so a crash or a force-quit doesn't lose the tree's shape.
        .onChange(of: store.expanded) { _, _ in
            persistTreeState()
        }
        .onChange(of: store.selection) { _, selection in
            persistTreeState()
            // VS Code opens on single click. `List` selection IS the click, so
            // opening happens here rather than in a tap gesture — a tap gesture
            // on a `List` row would fight the control's own selection handling.
            if selection.count == 1, let url = selection.first, !isDirectory(url) {
                open(url)
            }
        }
        // Refresh decorations when the project root changes / on appear.
        .task(id: gitRoot?.path) {
            await decorations.refresh(root: gitRoot)
            if let gitRoot { decorations.startWatching(root: gitRoot) } else { decorations.stopWatching() }
        }
        // Re-check git status when the window regains key focus (VS Code does
        // the same — picks up edits made via terminal/other tools). Kept even
        // with the watcher running: FSEvents can be missed while the app is
        // backgrounded.
        .onChange(of: controlActiveState) { _, state in
            if state == .key { Task { await decorations.refresh(root: gitRoot) } }
        }
        .onDisappear {
            decorations.stopWatching()
            store.stopWatching()
            persistTreeState()
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
            pendingDelete.count == 1
                ? "Move “\(pendingDelete[0].lastPathComponent)” to the Trash?"
                : "Move \(pendingDelete.count) items to the Trash?",
            isPresented: Binding(get: { !pendingDelete.isEmpty },
                                 set: { if !$0 { pendingDelete = [] } }),
            titleVisibility: .visible
        ) {
            Button("Move to Trash", role: .destructive) {
                let targets = pendingDelete
                pendingDelete = []
                delete(targets)
            }
            Button("Cancel", role: .cancel) { pendingDelete = [] }
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
            // Single-repo case: when the root's only child is one folder (the
            // root is the project's `code/` container and its one child is the
            // clone), display AT that folder rather than wrapping it in an
            // extra collapsible row. Owned by the store now — see
            // `ExplorerTreeStore.displayRoot(for:)`.
            let base = treeBase(root)
            let displayRoot = store.displayRoot(for: base)
            // `flatten` costs ~3.75 ms at 2000 rows against a 16.6 ms frame
            // budget and BOTH consumers below need the same visible rows, so
            // it runs exactly ONCE per render, here.
            let rows = store.flatten(from: displayRoot)
            VStack(spacing: 0) {
                treeToolbar(root: base, displayRoot: displayRoot, rows: rows)
                Divider()
                ExplorerTreeList(rows: rows,
                                 store: store,
                                 displayRoot: displayRoot,
                                 gitRoot: gitRoot,
                                 git: decorations,
                                 actions: actions())
            }
        } else {
            emptyState
        }
    }

    /// Where the toolbar's New File / New Folder buttons create: the selected
    /// folder, the parent of a selected file, or `displayRoot` when nothing is
    /// selected. With a multi-selection the FIRST row in display order wins —
    /// resolved through the already-flattened `rows` rather than
    /// `selection.first`, because `Set` iteration order is not stable and the
    /// target would otherwise jump between identical clicks.
    ///
    /// Answers from the row's own `isDirectory` rather than re-`stat`ing the
    /// path: this runs during `body`, and the row already knows.
    private func toolbarTargetDir(rows: [ExplorerTreeStore.Row], displayRoot: URL) -> URL {
        guard !store.selection.isEmpty,
              let anchor = rows.first(where: { store.selection.contains($0.url) })
        else { return displayRoot }
        return anchor.isDirectory ? anchor.url : anchor.url.deletingLastPathComponent()
    }

    private func treeToolbar(root: URL, displayRoot: URL,
                             rows: [ExplorerTreeStore.Row]) -> some View {
        let targetDir = toolbarTargetDir(rows: rows, displayRoot: displayRoot)
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
                        Button("Delete") { pendingDelete = [displayRoot] }
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

    private func open(_ url: URL) {
        if !tabs.contains(url) { tabs.append(url) }
        activeTab = url
    }

    private func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    private func refreshGit() async {
        await decorations.refresh(root: gitRoot)
    }

    /// Save the tree's shape for the active root — but never before this
    /// root's saved state has been restored. See `treeStateRestored`.
    private func persistTreeState() {
        guard treeStateRestored, let base = treeRoot?.url else { return }
        store.persistState(for: base)
    }

    /// Re-enumerate `dir` and make sure it is expanded — the standard
    /// follow-up to any operation that changed a directory's contents.
    /// `invalidate` first, because `expand` only loads a directory the cache
    /// does not already hold.
    private func reload(_ dir: URL) async {
        store.invalidate(dir)
        await store.expand(dir)
    }

    /// The action bundle handed to the tree. Rebuilt on each render, which is
    /// fine: it is six closures over `self`, not state.
    private func actions() -> ExplorerActions {
        ExplorerActions(
            open: { open($0) },
            newFile: { filePrompt = .newFile(in: $0) },
            newFolder: { filePrompt = .newFolder(in: $0) },
            beginRename: { filePrompt = .rename(url: $0) },
            delete: { pendingDelete = $0 },
            revealInFinder: { NSWorkspace.shared.activateFileViewerSelecting($0) }
        )
    }

    /// Run a create/rename op, then refresh the affected folder + git
    /// decorations. Throws up to the sheet handler so a bad name surfaces
    /// inline instead of silently failing.
    ///
    /// New URLs go through `ExplorerPaths.canonical(_:)` before they enter the
    /// selection: `List(selection:)` matches rows by raw `URL` hashing, and a
    /// URL built by appending a name to a directory keeps whatever spelling
    /// that directory had, while the row it must match came out of
    /// `FileManager` via `loadChildren`'s standardization.
    private func performFileOp(_ prompt: FilePrompt, _ name: String) throws {
        switch prompt.mode {
        case .newFile:
            // ONE spelling for both the selection and the tab: `open` dedupes
            // by `==`, so opening the raw URL and selecting the canonical one
            // (which re-enters `open` through the selection observer) would
            // leave two tabs on one file.
            let url = ExplorerPaths.canonical(try ExplorerFileOps.createFile(in: prompt.dir, name: name))
            store.selection = [url]
            open(url)
            Task { await reload(prompt.dir); await refreshGit() }
        case .newFolder:
            let url = ExplorerPaths.canonical(try ExplorerFileOps.createFolder(in: prompt.dir, name: name))
            store.selection = [url]
            Task { await reload(prompt.dir); await refreshGit() }
        case .rename:
            guard let url = prompt.url else { return }
            let new = try ExplorerFileOps.rename(url, to: name)
            retarget(from: url, to: ExplorerPaths.canonical(new))
        }
    }

    /// Follow a renamed/moved item: open tabs, the active tab, and the
    /// selection all point at the new URL rather than a path that no longer
    /// exists.
    private func retarget(from old: URL, to new: URL) {
        tabs = tabs.map { $0 == old ? new : $0 }
        if activeTab == old { activeTab = new }
        if store.selection.contains(old) {
            store.selection.remove(old)
            store.selection.insert(new)
        }
        Task { await reload(old.deletingLastPathComponent()); await refreshGit() }
    }

    /// Trash one or more items, close any tabs under them, refresh their
    /// parents. Stops at the first failure and reports it — a partial delete
    /// is visible in the tree after the refresh, so nothing is hidden.
    private func delete(_ urls: [URL]) {
        var parents: Set<String> = []
        do {
            for url in urls {
                try ExplorerFileOps.trash(url)
                parents.insert(ExplorerPaths.key(url.deletingLastPathComponent()))
                tabs.removeAll { $0 == url || ExplorerPaths.isDescendant($0, of: url) }
                if let active = activeTab, active == url || ExplorerPaths.isDescendant(active, of: url) {
                    activeTab = tabs.last
                }
                store.selection = store.selection.filter {
                    $0 != url && !ExplorerPaths.isDescendant($0, of: url)
                }
            }
        } catch {
            deleteError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        }
        Task {
            for parent in parents { await reload(URL(fileURLWithPath: parent)) }
            await refreshGit()
        }
    }

    /// Full tree + git refresh (toolbar Refresh). Re-enumerates every loaded
    /// folder rather than dropping the cache, so expansion survives.
    private func refreshAll() {
        Task { await store.refreshLoaded(); await refreshGit() }
    }

    /// Collapse every expanded folder (toolbar Collapse All), VS Code-style.
    private func collapseAll() {
        store.collapseAll()
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
