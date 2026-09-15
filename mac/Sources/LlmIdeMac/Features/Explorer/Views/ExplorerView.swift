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
    @Environment(ShellState.self) private var shell

    @State private var showProjectPaths = false

    /// The tree's model — children cache, expansion, and selection. Replaces
    /// the three `@State` properties that used to live here; `children(of:)`
    /// wrote into one of them from inside `body`, which SwiftUI forbids
    /// (design §3 finding #9).
    @State private var store = ExplorerTreeStore()

    /// Explorer-internal cut/copy clipboard — never `NSPasteboard`. See
    /// `ExplorerClipboard` for why the system pasteboard is the wrong tool.
    @State private var clipboard = ExplorerClipboard()

    /// Inline rename: which row is being edited, and its live text. Owned here
    /// rather than in the row so a project switch, a delete, or a successful
    /// commit can close an editor the row itself is about to stop rendering.
    @State private var renamingURL: URL?
    @State private var renameText = ""

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
    /// Any failed destructive operation (trash, drag-move, paste) — shown in
    /// the "Couldn't complete the operation" alert. Distinct from
    /// `fileOpError`, which is the create/rename sheet's INLINE error.
    @State private var opError: String?

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

    /// The tree column's resize bounds — ONE source of truth, handed to both
    /// `ResizableDivider` (which clamps on write) and `clampedTreeWidth`
    /// (which clamps on read).
    private static let treeWidthMin = 160.0
    private static let treeWidthMax = 520.0

    /// `treeWidth` clamped for RENDERING. `@AppStorage` reads back whatever is
    /// in `UserDefaults` unfiltered, so a value written by an older build, by
    /// a `defaults write`, or a NaN that got stored once, would survive a whole
    /// launch as an out-of-range (or un-layout-able) frame width — clamping
    /// only on the drag write never gets a chance to correct it.
    private var clampedTreeWidth: Double {
        ResizableDivider.clamp(treeWidth, minWidth: Self.treeWidthMin, maxWidth: Self.treeWidthMax)
    }

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

    /// The root `SearchView` walks — a THIRD root, distinct from both `root`
    /// (the tree's `code/` container) and `gitRoot` (the git working tree).
    /// Unifying Search's root with the Explorer's is design §3 finding #10 and
    /// belongs to P4; until then, Find in Folder computes against Search's
    /// ACTUAL root so the handoff is honest rather than plausible.
    private var searchRoot: URL? {
        WorkspaceRoot.resolve(config: config, projectStore: projectStore)
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
                        .frame(width: CGFloat(clampedTreeWidth))
                        .transition(.move(edge: .leading))
                    ResizableDivider(width: $treeWidth,
                                     minWidth: Self.treeWidthMin, maxWidth: Self.treeWidthMax)
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
            renamingURL = nil      // a rename editor must not survive the switch
            // Nor may the clipboard: a cut made in project A and pasted after
            // switching to project B would MOVE A's files into B, and nothing
            // on screen hints that the clipboard still holds a foreign path.
            clipboard.clear()
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
            // `restoreState` answers false when a NEWER restore superseded this
            // one. That includes a re-run for the SAME root — `.task(id:)`
            // fires again on disappear/reappear — which the `rawPath` check
            // below cannot see, because both runs stamp the identical path.
            // The Bool is the load-bearing signal now; the `rawPath` check
            // stays as defence in depth against an outright project switch.
            let restored = await store.restoreState(for: base)
            guard restored, treeRoot?.rawPath == root.path else { return }
            treeStateRestored = true
            store.startWatching(base)
        }
        // Persist expansion/selection as they change (cheap: one small JSON
        // blob), so a crash or a force-quit doesn't lose the tree's shape.
        .onChange(of: store.expanded) { _, _ in
            persistTreeState()
        }
        // Selection changes persist, and do NOTHING else. Opening deliberately
        // does not hang off this observer any more: `List` owns ↑/↓, so
        // arrowing down through N files fired it N times and left N PERMANENT
        // tabs open behind the cursor — and a multi-delete that shrank the
        // selection to one survivor opened that survivor. Files open on click
        // (`ExplorerTreeRow`'s simultaneous tap gesture) and on ⏎
        // (`ExplorerKeyCommand.open`). This app has no preview tab, so VS
        // Code's "arrow keys preview the file" has no faithful equivalent —
        // not opening is the honest degradation.
        .onChange(of: store.selection) { _, _ in
            persistTreeState()
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
               isPresented: Binding(get: { opError != nil }, set: { if !$0 { opError = nil } })) {
            Button("OK", role: .cancel) { opError = nil }
        } message: {
            Text(opError ?? "")
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
                                 actions: actions(displayRoot: displayRoot),
                                 renamingURL: renamingURL,
                                 renameText: $renameText)
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
    /// fine: it is a handful of closures over `self`, not state.
    ///
    /// `displayRoot` is a parameter rather than a re-derivation because
    /// `treePane` has already resolved it for this render (and `flatten` is
    /// keyed on the same value) — the two must not be able to disagree about
    /// where the tree starts.
    private func actions(displayRoot: URL) -> ExplorerActions {
        ExplorerActions(
            open: { open($0) },
            newFile: { filePrompt = .newFile(in: $0) },
            newFolder: { filePrompt = .newFolder(in: $0) },
            // Inline now, not the sheet. `FilePrompt.rename` stays in use for
            // the tree TOOLBAR's display-root menu — that header is not a tree
            // row, so it has nothing to edit in place.
            beginRename: { url in
                renamingURL = url
                renameText = url.lastPathComponent
            },
            delete: { pendingDelete = $0 },
            revealInFinder: { NSWorkspace.shared.activateFileViewerSelecting($0) },
            drop: { sources, destination, copy in performDrop(sources, into: destination, copy: copy) },
            cut: { clipboard.cut($0) },
            copy: { clipboard.copy($0) },
            paste: { performPaste(into: $0) },
            // Read HERE, inside `body`, not behind a closure: this is what
            // registers the observation dependency that re-enables the Paste
            // menu item the moment the clipboard changes. See
            // `ExplorerActions.canPaste`.
            canPaste: !clipboard.isEmpty,
            commitRename: { url, name in commitRename(url, to: name) },
            cancelRename: { renamingURL = nil },
            copyPath: { urls, relative in copyPaths(urls, relative: relative, base: displayRoot) },
            findInFolder: { findInFolder($0) },
            canFindIn: { url in
                guard let searchRoot else { return false }
                return ExplorerPaths.includeGlob(for: url, root: searchRoot) != nil
            }
        )
    }

    /// Scope Search to `folder`, then switch to it.
    ///
    /// Setting the pending glob BEFORE changing the section is load-bearing:
    /// the section change is what mounts `SearchView`, and its `.task` reads
    /// the value on mount. Writing it afterwards would arrive too late.
    private func findInFolder(_ folder: URL) {
        guard let searchRoot,
              let glob = ExplorerPaths.includeGlob(for: folder, root: searchRoot) else { return }
        shell.pendingSearchInclude = glob
        shell.section = .search
    }

    /// Put one path per line on the SYSTEM pasteboard — the one legitimate use
    /// of `NSPasteboard` in this panel, because the point of Copy Path is to
    /// paste the result somewhere outside the app.
    ///
    /// `relative` paths are computed against the tree's display root — the
    /// folder whose name the tree header shows — so they read the way the user
    /// sees the tree, and match a repo-relative path in the single-repo case. A
    /// URL outside that root, or the root itself, falls back to its absolute
    /// path rather than silently copying an empty line.
    private func copyPaths(_ urls: [URL], relative: Bool, base: URL) {
        let lines = urls.map { url -> String in
            guard relative,
                  let rel = ExplorerPaths.relativePath(of: url, from: base),
                  !rel.isEmpty else { return ExplorerPaths.key(url) }
            return rel
        }
        let text = lines.joined(separator: "\n")
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    /// Apply an inline rename. An unchanged or empty name just closes the
    /// editor. A refusal or a failure leaves the editor OPEN with the text
    /// intact, so a bad name can be corrected rather than retyped.
    ///
    /// The new URL goes through `ExplorerPaths.canonical(_:)` before it reaches
    /// the selection or a tab, exactly as `performFileOp` does: `rename`
    /// builds its result by appending to the parent, which keeps whatever
    /// spelling that parent had, while the row it must match came out of
    /// `FileManager`. An uncanonical URL here silently never highlights.
    private func commitRename(_ url: URL, to name: String) {
        switch ExplorerRenameName.resolve(name, current: url.lastPathComponent) {
        case .cancel:
            renamingURL = nil
        case .reject(let error):
            opError = error.errorDescription
        case .apply(let trimmed):
            do {
                let new = ExplorerPaths.canonical(try ExplorerFileOps.rename(url, to: trimmed))
                renamingURL = nil
                retarget(from: url, to: new)
            } catch {
                opError = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
            }
        }
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
            // by `==`, and `List(selection:)` matches rows by raw `URL`
            // hashing, so selecting one spelling and opening another would
            // both fail to highlight and risk a second tab on one file.
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

    /// `url` re-pointed at `new` when it was at `old` — `new` itself when it IS
    /// `old`, the matching path UNDER `new` when it is a strict descendant, and
    /// `nil` when it is neither.
    ///
    /// The descendant half is what makes renaming or moving a FOLDER honest.
    /// Matching by `==` alone (which is what `remap` did) re-pointed the folder
    /// and abandoned everything inside it: a tab open on `docs/a.md` kept
    /// pointing at a path that no longer exists once `docs/` was renamed, and
    /// the selection and expansion of every row underneath went stale with it.
    ///
    /// Answered through `ExplorerPaths.relativePath`, so "same place" is judged
    /// on standardized path keys rather than raw `URL` equality (a tab and a
    /// row can spell one directory with and without its trailing-slash hint),
    /// and so `/docs2` is never read as living inside `/docs`.
    private func rebase(_ url: URL, from old: URL, to new: URL) -> URL? {
        guard let relative = ExplorerPaths.relativePath(of: url, from: old) else { return nil }
        guard !relative.isEmpty else { return new }
        return ExplorerPaths.canonical(new.appendingPathComponent(relative))
    }

    /// Point open tabs, the active tab, the selection, and the expansion set at
    /// `new` instead of `old` — including everything nested under `old`.
    /// Pure state remap — no filesystem work, no reload — so a multi-item move
    /// can call it per item and reload ONCE at the end instead of
    /// re-enumerating the same folder n times.
    ///
    /// `new` must already be `ExplorerPaths.canonical`: `List(selection:)`
    /// matches rows by raw `URL` hashing, so an uncanonical URL inserted here
    /// silently never highlights.
    ///
    /// Returns the directories whose expansion moved with them. Their children
    /// are still cached under the OLD keys, so `flatten` would render them
    /// open and EMPTY until someone re-enumerates them — that is the caller's
    /// job, batched with its other reloads. Nothing is returned for a moved
    /// FILE, which is the common case.
    @discardableResult
    private func remap(from old: URL, to new: URL) -> [URL] {
        tabs = tabs.map { rebase($0, from: old, to: new) ?? $0 }
        if let active = activeTab, let moved = rebase(active, from: old, to: new) {
            activeTab = moved
        }

        let movedSelection = store.selection.compactMap { url in
            rebase(url, from: old, to: new).map { (url, $0) }
        }
        if !movedSelection.isEmpty {
            var selection = store.selection
            for (before, after) in movedSelection {
                selection.remove(before)
                selection.insert(after)
            }
            store.selection = selection
        }

        let oldKey = ExplorerPaths.key(old)
        let newKey = ExplorerPaths.key(new)

        // Reap the children cached under the PRE-rename paths. Nothing else
        // ever will on the rename path: `invalidate` is keyed on the path, and
        // the caller only reloads the old parent and the folders whose
        // expansion moved — all of them NEW keys. The old entries would sit
        // there until `refreshLoaded`'s next FSEvent tick noticed the
        // directory was gone, and until then every tick re-walks a subtree
        // that no longer exists.
        //
        // Reaping is invisible to `flatten`, which is why it is safe to do
        // here rather than after the reload: the renamed folder's own ROW
        // comes from its PARENT's cache entry, which is not touched, and
        // `appendRows` only descends into a directory that is in `expanded` —
        // and the loop below is about to move the old key out of `expanded`.
        // So no row that was rendering before this call stops rendering
        // because of it.
        //
        // Placed BEFORE the `movedKeys` guard, not inside it: `collapse`
        // leaves a folder's children cached on purpose, so a loaded-then-
        // collapsed folder has a stale key to reap even though no expansion
        // moved with it.
        let staleKeys = store.children.keys.filter { $0 == oldKey || $0.hasPrefix(oldKey + "/") }
        for key in staleKeys {
            store.invalidate(URL(fileURLWithPath: key, isDirectory: true))
        }

        // Expansion is keyed on `ExplorerPaths.key` STRINGS, not URLs, so it is
        // rewritten by prefix here rather than through `rebase`. Without this a
        // renamed folder comes back collapsed and strands its old key — and its
        // open children collapse with it.
        let movedKeys = store.expanded.filter { $0 == oldKey || $0.hasPrefix(oldKey + "/") }
        guard !movedKeys.isEmpty else { return [] }
        var expanded = store.expanded
        var reopened: [URL] = []
        for key in movedKeys {
            expanded.remove(key)
            let moved = newKey + String(key.dropFirst(oldKey.count))
            expanded.insert(moved)
            reopened.append(URL(fileURLWithPath: moved, isDirectory: true))
        }
        store.expanded = expanded
        return reopened
    }

    /// Follow a renamed/moved item: remap the tabs, selection and expansion,
    /// then refresh the folder it came from and re-enumerate any folder whose
    /// expansion moved with it.
    private func retarget(from old: URL, to new: URL) {
        let reopened = remap(from: old, to: new)
        Task {
            await reload(old.deletingLastPathComponent())
            for dir in reopened { await store.loadChildren(of: dir) }
            await refreshGit()
        }
    }

    /// `sources` split into the ones worth applying against this destination
    /// and the NAMES of the ones that have since vanished.
    ///
    /// First the set is reduced to its topmost members by
    /// `ExplorerPaths.topLevel`: a selection can hold a folder AND something
    /// inside it, and moving or copying the folder carries the child with it,
    /// so the child is redundant rather than a second operation. See that
    /// function for what happened before it existed.
    ///
    /// Then two kinds are held back. First, anything that no longer exists —
    /// deleted or moved by another app between the ⌘X and the ⌘V, or between
    /// picking a drag up and dropping it. `ExplorerFileOps` reports those as a
    /// typed `.sourceMissing`, but it still THROWS, and the caller's loop used
    /// to stop at the first throw — so one file deleted from a three-item cut
    /// took the other two down with it. The callers no longer `break`, so this
    /// is now the first of two nets rather than the only one: filtering here
    /// keeps the vanished items out of the operation entirely, and the callers
    /// catch `.sourceMissing` for anything that vanishes in the window between
    /// this check and its own turn. Both report through `reportMissing`, once,
    /// after the loop. (The test is
    /// `ExplorerFileOps.itemExists`, which lstats: a broken symlink is a real
    /// row the user can see and move, not a vanished item.)
    ///
    /// Second, the ones that can only ever fail against this destination: the
    /// destination folder ITSELF, and any folder the destination lives inside.
    ///
    /// Dragging a multi-selection onto one of its own folders used to be
    /// order-dependent — `[folder, e.txt]` aborted at `folder` and moved
    /// nothing, `[e.txt, folder]` moved the file and then alerted — because the
    /// ops loop stopped at the first throw and `Set` order decided which came
    /// first. Finder's rule is that the drop target is simply not part of its
    /// own drag, so it is dropped from the list and the rest go through.
    ///
    /// When the SECOND rule alone would empty the list, the pruned sources are
    /// returned instead: dragging a folder onto itself (or into its own
    /// child) with nothing else selected is a genuine mistake, and it must
    /// still raise "Can't move a folder into itself." rather than silently
    /// doing nothing. That fallback deliberately does NOT apply once something
    /// vanished — there the honest answer is the `.sourceMissing` report, not
    /// a doomed retry.
    private func droppable(_ sources: [URL],
                           into destinationDir: URL) -> (apply: [URL], missing: [String]) {
        let topLevel = ExplorerPaths.topLevel(sources)
        let destinationKey = ExplorerPaths.key(destinationDir)
        var missing: [String] = []
        let applicable = topLevel.filter { source in
            guard ExplorerFileOps.itemExists(source) else {
                missing.append(source.lastPathComponent)
                return false
            }
            return ExplorerPaths.key(source) != destinationKey
                && !ExplorerPaths.isDescendant(destinationDir, of: source)
        }
        if applicable.isEmpty, missing.isEmpty { return (topLevel, []) }
        return (applicable, missing)
    }

    /// One alert line for every source that had vanished.
    ///
    /// APPENDS to whatever is already in `opError` instead of standing down in
    /// front of it. The old rule ("a real error is the more specific news")
    /// deferred to ANY non-nil `opError` — including a stale one the user has
    /// not dismissed yet, which has nothing to do with this operation. A paste
    /// whose sources had all vanished then showed the user the PREVIOUS
    /// operation's message and no word about the files that are gone. Files
    /// disappearing out from under a cut is exactly the news that must never
    /// be swallowed, so it is always added.
    ///
    /// Both facts survive when the operation ALSO failed: the callers set
    /// `opError` from their `catch` immediately before calling this, and a
    /// collision and a vanished source in one paste are two separate things
    /// the user needs to know. Separated by a blank line so the alert reads as
    /// two statements rather than one run-on sentence.
    private func reportMissing(_ missing: [String]) {
        guard !missing.isEmpty else { return }
        let line = missing.count == 1
            ? (ExplorerFileError.sourceMissing(missing[0]).errorDescription ?? "")
            : "These items no longer exist: " + missing.map { "“\($0)”" }.joined(separator: ", ")
        appendOpError(line)
    }

    /// Add `line` to the shared alert without displacing what is already
    /// there. Two independent facts about one gesture (a collision AND a
    /// vanished source) are two things the user needs, and the alert shows
    /// one string.
    private func appendOpError(_ line: String) {
        guard !line.isEmpty else { return }
        if let existing = opError, !existing.isEmpty {
            opError = existing + "\n\n" + line
        } else {
            opError = line
        }
    }

    /// One line per source that FAILED, each NAMING the item it belongs to.
    ///
    /// The destructive loops used to `break` on the first throw, so a
    /// collision on the second of five items silently left the other three
    /// unapplied while showing a message that named none of them. They now
    /// run to completion and collect here instead — see `failureLine`.
    private func reportFailures(_ failures: [String]) {
        guard !failures.isEmpty else { return }
        appendOpError(failures.joined(separator: "\n"))
    }

    /// A failure attributed to the item that produced it.
    ///
    /// Always prefixed with the name, even for a single-item gesture: with
    /// multi-select, "An item with this name already exists." on its own does
    /// not say WHICH of the five dragged files is the one still sitting in the
    /// source folder.
    private func failureLine(_ source: URL, _ error: Error) -> String {
        let message = (error as? ExplorerFileError)?.errorDescription ?? error.localizedDescription
        return "“\(source.lastPathComponent)”: \(message)"
    }

    /// Apply a drag & drop. ⌥ copies (Finder's convention); otherwise moves.
    ///
    /// (This doc comment used to sit above `droppable`, where it described the
    /// wrong function — it was left behind when `droppable` was hoisted above
    /// it.)
    ///
    /// Every source's ORIGINAL parent is refreshed alongside the destination,
    /// or a moved file would keep rendering in the folder it came from until
    /// the watcher's next tick. Self-nesting and name collisions are rejected
    /// by `ExplorerFileOps` and surface in the shared alert — this never
    /// overwrites anything.
    ///
    /// EVERY source gets its turn, like `performPaste` and `delete(_:)`. A
    /// throw is collected and the loop continues; the collected lines are
    /// reported together at the end. It used to `break`, which meant one
    /// collision (or one source that lost a race with another process) took
    /// every item behind it down silently — the user saw one sentence about
    /// one file and no word that the rest of their drag had not happened.
    /// Continuing is safe because each operation is independently guarded and
    /// never overwrites: a refused item simply stays where it was.
    private func performDrop(_ sources: [URL], into destinationDir: URL, copy: Bool) {
        var touched: Set<String> = [ExplorerPaths.key(destinationDir)]
        var reopened: [URL] = []
        var failures: [String] = []
        let (applicable, alreadyMissing) = droppable(sources, into: destinationDir)
        var missing = alreadyMissing
        for source in applicable {
            do {
                if copy {
                    _ = try ExplorerFileOps.copy(from: source, to: destinationDir)
                } else {
                    let moved = try ExplorerFileOps.move(from: source, to: destinationDir)
                    touched.insert(ExplorerPaths.key(source.deletingLastPathComponent()))
                    reopened += remap(from: source, to: ExplorerPaths.canonical(moved))
                }
            } catch ExplorerFileError.sourceMissing(let name) {
                missing.append(name)   // lost the race with another process
            } catch {
                failures.append(failureLine(source, error))
            }
        }
        reportFailures(failures)
        reportMissing(missing)
        Task {
            for dir in touched { await reload(URL(fileURLWithPath: dir)) }
            for dir in reopened { await store.loadChildren(of: dir) }
            await refreshGit()
        }
    }

    /// Apply the clipboard into `dir`. A cut is consumed (cleared) on a
    /// successful paste, matching Finder/VS Code — the same cut cannot be
    /// pasted twice. A copy stays armed so it can be pasted repeatedly, each
    /// time producing a fresh Finder-style "… copy" sibling.
    ///
    /// Self-nesting and name collisions are rejected inside `ExplorerFileOps`
    /// and surface in the shared alert; this never overwrites anything. On a
    /// failure the clipboard is deliberately left armed, so the user can fix
    /// the collision and paste again rather than re-selecting the sources.
    ///
    /// Applied ITEM BY ITEM, the same shape `performDrop` uses, and never
    /// through a batch helper that returns only its final result: the items
    /// already moved when item three collides are gone from disk, so a paste
    /// of `[a, b, c]` that failed on `b` would leave `a` moved with its open
    /// tab still pointing at the path `a` no longer occupies. Remapping per
    /// item is the only way to keep the tabs honest about what actually
    /// happened — and it is why `ExplorerFileOps` has no `paste` any more.
    private func performPaste(into dir: URL) {
        guard let operation = clipboard.operation, !clipboard.isEmpty else { return }
        let sources = clipboard.urls
        let isMove = operation == .cut
        var touched: Set<String> = [ExplorerPaths.key(dir)]
        var reopened: [URL] = []
        var results: [URL] = []
        var failures: [String] = []
        let (applicable, alreadyMissing) = droppable(sources, into: dir)
        var missing = alreadyMissing
        for source in applicable {
            do {
                // Canonical before anything enters `store.selection` or a tab:
                // `List(selection:)` matches rows by raw `URL` hashing, and a
                // URL built by appending a name to a directory keeps that
                // directory's spelling instead of the one `loadChildren`
                // produced.
                let landed = ExplorerPaths.canonical(
                    isMove
                        ? try ExplorerFileOps.move(from: source, to: dir)
                        : try ExplorerFileOps.copy(from: source, to: dir))
                results.append(landed)
                if isMove {
                    touched.insert(ExplorerPaths.key(source.deletingLastPathComponent()))
                    reopened += remap(from: source, to: landed)
                }
            } catch ExplorerFileError.sourceMissing(let name) {
                missing.append(name)   // lost the race with another process
            } catch {
                failures.append(failureLine(source, error))
            }
        }
        reportFailures(failures)
        reportMissing(missing)
        // A cut is consumed unless a REAL failure held one of its items back.
        // A cut stopped by a collision stays armed so the user can fix it and
        // finish; clearing there would strand the remainder with no way back
        // to the selection that produced it. Sources that had vanished — before
        // the paste or during it — don't count against that: no retry can bring
        // them back, so they must not keep the clipboard armed forever.
        if isMove, failures.isEmpty { clipboard.clear() }
        if !results.isEmpty { store.selection = Set(results) }
        Task {
            for parent in touched { await reload(URL(fileURLWithPath: parent)) }
            for folder in reopened { await store.loadChildren(of: folder) }
            await refreshGit()
        }
    }

    /// Trash one or more items, close any tabs under them, refresh their
    /// parents.
    ///
    /// Reduced to its topmost members first. `[folder, folder/keep.txt,
    /// other.txt]` is one selection the user can make in two clicks, and
    /// trashing `folder` takes `keep.txt` with it — so `keep.txt`'s own turn
    /// used to throw, the loop `break`d, and `other.txt` was never trashed at
    /// all, after the user had confirmed "Move 3 items to the Trash". All
    /// three still reach the Trash under the pruned form (`keep.txt` inside
    /// `folder`), so the confirmation the user answered is still honoured
    /// exactly — which is why the dialog keeps counting what was SELECTED.
    ///
    /// Every remaining item then gets its turn: a failure is attributed to
    /// its item and collected, never allowed to cancel the items behind it.
    /// A partial delete is also visible in the tree after the refresh, but
    /// "visible afterwards" was never enough for a confirmed destructive
    /// action — the user has to be told.
    private func delete(_ urls: [URL]) {
        var parents: Set<String> = []
        var failures: [String] = []
        var missing: [String] = []
        for url in ExplorerPaths.topLevel(urls) {
            // Same "vanished" test the drop/paste path uses, so all four
            // destructive paths tell the user the same thing about a source
            // another process removed first — rather than letting
            // `trashItem` surface a raw Cocoa sentence.
            guard ExplorerFileOps.itemExists(url) else {
                missing.append(url.lastPathComponent)
                continue
            }
            do {
                try ExplorerFileOps.trash(url)
            } catch {
                failures.append(failureLine(url, error))
                continue
            }
            parents.insert(ExplorerPaths.key(url.deletingLastPathComponent()))
            tabs.removeAll { $0 == url || ExplorerPaths.isDescendant($0, of: url) }
            if let active = activeTab, active == url || ExplorerPaths.isDescendant(active, of: url) {
                activeTab = tabs.last
            }
            store.selection = store.selection.filter {
                $0 != url && !ExplorerPaths.isDescendant($0, of: url)
            }
            // An inline rename must never outlive its row: deleting the
            // folder a rename is happening inside would otherwise leave an
            // editor open over a ghost, whose ⏎ renames nothing.
            if let renaming = renamingURL,
               renaming == url || ExplorerPaths.isDescendant(renaming, of: url) {
                renamingURL = nil
            }
        }
        reportFailures(failures)
        reportMissing(missing)
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
