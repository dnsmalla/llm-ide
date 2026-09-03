import SwiftUI

/// Cursor-style Source Control panel over the active cloned repo. Two
/// columns: left = branch header + either the staged/unstaged file groups and
/// commit box (Changes) or the commit list and the selected commit's file
/// list (History); right = the selected file's diff — Monaco's diff editor
/// over a `HunkStagingList`, which is interactive in Changes mode and
/// read-only in History. Exactly one file's diff is shown at a time in both
/// modes. Empty state when no repo is active. Discard goes through a
/// destructive confirmation.
struct SourceControlView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(\.controlActiveState) private var controlActiveState
    @State private var scm = SourceControlService()
    /// Per-hunk staging runs through `GitTruthStore` (`git apply --cached`),
    /// not through `SourceControlService` — the service only knows whole-file
    /// `add`/`restore`.
    @State private var gitTruthStore = GitTruthStore()
    /// Every file the user has selected, for BULK actions on the list
    /// (context-menu stage/unstage). Multi-select never means "show several
    /// diffs" — the right pane still shows exactly one file, per Task 7's
    /// `MonacoDiffView` design.
    @State private var selectedFiles: Set<FileChange> = []
    /// The single file whose diff the right pane shows: the most recently
    /// clicked one, independent of how many are in `selectedFiles`.
    @State private var selected: FileChange?
    /// Focus for the changes list, so ↑/↓ move the file selection ONLY while
    /// the list itself has focus — arrowing inside the commit-message field
    /// must not walk the list.
    @FocusState private var fileListFocused: Bool
    @State private var hunks: [DiffHunk] = []
    /// Full old/new text behind the right pane's `MonacoDiffView`. Monaco's
    /// diff editor computes its own word-level diff from full text and never
    /// consumes `DiffHunk`, so these are loaded ALONGSIDE `hunks` (which is
    /// what the `HunkStagingList` under it renders and stages), never derived
    /// from them.
    @State private var diffOriginal: String = ""
    @State private var diffModified: String = ""
    /// Identity of the diff currently sitting in `hunks` (see `diffKey`), or
    /// nil while a load is in flight. The hunk pane renders — and so the
    /// Stage/Unstage buttons exist — only when this matches the selection the
    /// pane is drawing, so a click can never send one file's hunk body under
    /// another file's path (or under the same path's OTHER index side).
    @State private var loadedKey: String?
    /// True while a per-hunk `git apply --cached` is in flight. A second
    /// click during that window would reliably fail and leave an error banner
    /// sitting on top of a stage that actually succeeded.
    @State private var isStagingHunk = false
    @State private var message: String = ""
    @State private var confirmDiscard: FileChange?
    @State private var branches: [String] = []
    @State private var pollTask: Task<Void, Never>?
    @State private var showCreateBranch = false
    @State private var newBranchName = ""
    @State private var confirmDeleteBranch: String?
    @State private var mode: PaneMode = .changes
    @State private var commits: [Commit] = []
    @State private var selectedCommit: Commit?
    /// History mode browses ONE file of the selected commit at a time (same
    /// shape as Changes mode), rather than rendering a whole multi-file
    /// commit diff as a single blob.
    @State private var commitFiles: [String] = []
    @State private var selectedCommitFile: String?
    @State private var stashes: [SourceControlService.Stash] = []
    @State private var showStashMessage = false
    @State private var stashMessage = ""
    @State private var amendOn = false
    @State private var confirmDiscardAll = false
    @State private var tags: [String] = []
    @State private var showCreateTag = false
    @State private var newTagName = ""
    /// In-flight diff load. Cancelled before starting a new one so rapid
    /// file/commit selection can't race (last-to-finish overwriting the
    /// current selection's diff).
    @State private var diffTask: Task<Void, Never>?
    /// In-flight commit-file-list load, cancelled the same way and for the
    /// same reason as `diffTask` — clicking down a commit list fast would
    /// otherwise let an older commit's file list land last.
    @State private var commitFilesTask: Task<Void, Never>?

    private enum PaneMode: String, CaseIterable { case changes = "Changes", history = "History" }

    /// The right pane's whole payload: the parsed hunks the
    /// `HunkStagingList` renders plus the full old/new text `MonacoDiffView`
    /// renders. Loaded as ONE unit under ONE cancellable task on purpose —
    /// both halves describe the same selection, so a superseded load has to
    /// drop both together or the two panes end up showing different files.
    private typealias DiffPayload = (hunks: [DiffHunk], original: String, modified: String)

    /// What `hunks` currently describes. A path alone is NOT enough: a
    /// partially-staged file (porcelain `MM`) has a staged and an unstaged
    /// row sharing one path, whose hunks come from opposite sides of the
    /// index and must never be applied to each other's side.
    private static func diffKey(for file: FileChange) -> String {
        file.path + (file.staged ? ":staged" : ":worktree")
    }

    private static func diffKey(sha: String, path: String) -> String {
        "\(sha):\(path)"
    }

    /// Load the right pane from an async producer, cancelling any prior load
    /// first and discarding the result if this load was superseded. Clears
    /// `loadedKey` for the duration, so the pane cannot offer actions over
    /// the PREVIOUS selection's hunks while the new ones are still loading.
    ///
    /// The clear is conditional because a status poll re-runs this for the
    /// SAME selection whenever any *other* file changes; blanking the pane to
    /// "Loading…" every time would throw away the user's scroll position for
    /// an edit they didn't make. A matching key means the same path AND the
    /// same index side, so the hunks already on screen still belong to this
    /// selection and the safety invariant holds.
    private func loadDiff(key: String, _ produce: @escaping () async -> DiffPayload) {
        diffTask?.cancel()
        if loadedKey != key { loadedKey = nil }
        diffTask = Task {
            let payload = await produce()
            if Task.isCancelled { return }
            hunks = payload.hunks
            diffOriginal = payload.original
            diffModified = payload.modified
            loadedKey = key
        }
    }

    /// Right pane for one working-tree file (Changes mode). The two producers
    /// run as `async let` so their git subprocesses overlap — `diffContent`
    /// alone spawns two, and serialising all of them widened the window in
    /// which the pane shows one selection over another's data.
    private func loadFileDiff(root: URL, file: FileChange) {
        loadDiff(key: Self.diffKey(for: file)) {
            async let parsed = scm.diff(root: root, file: file)
            async let content = scm.diffContent(root: root, file: file)
            let (hunks, text) = await (parsed, content)
            return (hunks, text.original, text.modified)
        }
    }

    /// Right pane for one file of one commit (History mode). The hunks come
    /// from a real `git show` diff (`commitFileHunks`) rather than a
    /// whole-file line diff of the two contents: git emits compact ±3-context
    /// hunks, so a 3-line change in a 2000-line file is a few rows instead of
    /// two thousand.
    private func loadCommitFileDiff(root: URL, sha: String, path: String) {
        loadDiff(key: Self.diffKey(sha: sha, path: path)) {
            async let parsed = scm.commitFileHunks(root: root, sha: sha, path: path)
            async let content = scm.commitFileContent(root: root, sha: sha, path: path)
            let (hunks, text) = await (parsed, content)
            return (hunks, text.original, text.modified)
        }
    }

    /// Drop whatever the right pane is showing, cancelling any in-flight load
    /// so it can't repopulate the pane a moment later.
    private func clearDiff() {
        diffTask?.cancel()
        diffTask = nil
        loadedKey = nil
        hunks = []
        diffOriginal = ""
        diffModified = ""
    }

    // MARK: - Per-hunk staging

    /// Whether the right pane offers per-hunk **Stage** buttons for `file`.
    ///
    /// Untracked files are deliberately excluded even though they are
    /// unstaged: `SourceControlService.diff` synthesizes a single
    /// `@@ -0,0 +1,N @@` hunk covering the file's entire content, so "stage
    /// this hunk" would just be "stage this file" — which the file row's own
    /// `+` button already does — and the patch `GitTruthStore` synthesizes
    /// carries an `a/<path>` header for a blob that does not exist in the
    /// index, which `git apply --cached` correctly rejects.
    private func canStageHunks(_ file: FileChange) -> Bool {
        !file.staged && file.status != .untracked
    }

    /// Stage exactly one hunk, then refresh.
    ///
    /// NOTE: `git apply --cached` legitimately REJECTS some hunks, and the
    /// user sees git's own wording ("patch does not apply") on the sticky
    /// banner. Two ordinary causes:
    ///   1. **The file has no trailing newline.** `UnifiedDiffParser` drops
    ///      the `\ No newline at end of file` marker, so the patch
    ///      `GitTruthStore.stagePatch` synthesizes cannot reproduce it and
    ///      git refuses to apply it. Stage the whole file (the file row's
    ///      `+` button) instead.
    ///   2. The file changed on disk after the hunk was parsed.
    /// A rejected `git apply --cached` is a no-op on the index, so there is
    /// no partial state to unwind — an error message is the whole remedy.
    /// This must NEVER be a `try?`: swallowing it means the user clicks
    /// Stage and nothing happens, silently.
    ///
    /// Re-entrant clicks are DROPPED (`isStagingHunk`) rather than queued: a
    /// double-click would otherwise run the same apply twice, and the second
    /// one reliably fails against an index the first already moved — leaving
    /// an error banner sitting on top of a stage that actually worked.
    private func stageHunk(root: URL, file: FileChange, hunk: DiffHunk) {
        guard !isStagingHunk else { return }
        isStagingHunk = true
        scm.clearOpError()
        Task {
            defer { isStagingHunk = false }
            do { try await gitTruthStore.stagePatch(root: root, path: file.path, hunk: hunk) }
            catch {
                scm.setOpError("Couldn't stage that hunk in \(file.displayPath): \(error.localizedDescription)")
            }
            await scm.refresh(root: root)
        }
    }

    /// Unstage exactly one already-staged hunk, then refresh. Same failure
    /// modes, same no-`try?` rule and same re-entry guard as `stageHunk`.
    private func unstageHunk(root: URL, file: FileChange, hunk: DiffHunk) {
        guard !isStagingHunk else { return }
        isStagingHunk = true
        scm.clearOpError()
        Task {
            defer { isStagingHunk = false }
            do { try await gitTruthStore.unstagePatch(root: root, path: file.path, hunk: hunk) }
            catch {
                scm.setOpError("Couldn't unstage that hunk in \(file.displayPath): \(error.localizedDescription)")
            }
            await scm.refresh(root: root)
        }
    }

    /// SCM operates on the active git WORKING TREE. Resolved project-first
    /// (the project root when it's itself a repo, else the active clone) so
    /// SCM follows the open project rather than whichever repo is globally
    /// active. `isGitRepo`-gated, so it's nil — and the empty state shows —
    /// when no working tree exists.
    private var root: URL? { WorkspaceRoot.gitWorkingTree(config: config, projectStore: projectStore) }

    /// File extension driving the right pane's Monaco language id. History
    /// mode uses the selected COMMIT FILE's extension, not a "diff" hint —
    /// that pane now shows one real file's before/after content, not a
    /// multi-file unified-diff blob.
    private var diffLanguage: String {
        let path = mode == .history ? selectedCommitFile : selected?.path
        return (path as NSString?)?.pathExtension ?? ""
    }

    /// Whether the active repo has saved credentials (enables pull/push/sync).
    private var hasCredentials: Bool {
        guard let root else { return false }
        return scm.resolveCredentials?(root) != nil
    }

    /// Which provider owns `root` (matched by saved clone `localPath`), or nil
    /// when `root` isn't an allow-list-managed repo. Mirrors
    /// `SourceControlService.providerKind(for:)` so the button `.disabled`
    /// state matches what the service itself will enforce.
    private func providerKind(for root: URL) -> RepoBackendKind? {
        config.providerKind(forRepoRoot: root)
    }

    /// True when `op` is disallowed for `root`'s provider. Unmanaged roots
    /// (no matching saved clone) are never disabled here — the service itself
    /// only gates managed repos.
    private func isBlocked(_ op: RepoOperation, root: URL) -> Bool {
        guard let kind = providerKind(for: root) else { return false }
        return !config.isAllowed(op, provider: kind)
    }

    /// Tooltip text for a disabled-by-allow-list button. Mirrors the sticky
    /// `opError` message `SourceControlService` sets on the same condition.
    private func blockedHelp(_ op: RepoOperation, root: URL) -> String {
        guard let kind = providerKind(for: root) else { return "" }
        return "\(op.label) is disabled for \(kind.displayName). Enable it in Settings → \(kind.displayName) → Automation & Actions."
    }

    /// Thin panel header mirroring Explorer's, carrying the Explorer ⇄ Source
    /// Control switcher so you can return to the file tree from here.
    private var scmHeaderBar: some View {
        HStack(spacing: 6) {
            PanelSectionTabs()
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.bar)
    }

    @ViewBuilder private var content: some View {
        if let root {
            VStack(spacing: 0) {
                // Pinned ACROSS both panes, not inside the left pane's scroll
                // view: per-hunk staging failures are raised by the RIGHT
                // pane, and a banner the user has to scroll the left list to
                // find reintroduces exactly the silence the no-`try?` rule on
                // `stageHunk` exists to prevent.
                errorBanner()
                // Fixed-width changes column — HSplitView overrides a child's
                // width frame, so pin it outside the split to keep it minimal.
                HStack(spacing: 0) {
                    leftPane(root).frame(width: 300)
                    Divider()
                    detailPane(root)
                        .frame(minWidth: 360, maxWidth: .infinity)
                }
            }
        } else {
            emptyState
        }
    }

    /// Right pane: Monaco's real diff editor on top (the "view" half) over a
    /// native `HunkStagingList` (the "act" half). Exactly ONE file's diff —
    /// and so exactly one Monaco instance — is ever mounted; nothing is
    /// mounted at all until something is selected, so an empty pane never
    /// pays for a WebView.
    @ViewBuilder private func detailPane(_ root: URL) -> some View {
        switch mode {
        case .changes:
            if let selected {
                changesDetail(root, selected)
            } else {
                detailPlaceholder("Select a file to see its changes")
            }
        case .history:
            if selectedCommitFile != nil {
                historyDetail
            } else {
                detailPlaceholder(selectedCommit == nil
                                  ? "Select a commit to browse the files it touched"
                                  : "Select a file to see what this commit changed")
            }
        }
    }

    /// Working-tree diff plus per-hunk staging. `HunkStagingList` is
    /// read-only whenever both callbacks are nil, so a staged row offers only
    /// Unstage and an untracked row offers neither (see `canStageHunks`).
    private func changesDetail(_ root: URL, _ file: FileChange) -> some View {
        VSplitView {
            MonacoDiffView(original: diffOriginal, modified: diffModified,
                           language: MonacoLanguageMap.id(for: diffLanguage))
            hunkPane(
                key: Self.diffKey(for: file),
                onStage: canStageHunks(file) ? { hunk in stageHunk(root: root, file: file, hunk: hunk) } : nil,
                onUnstage: file.staged ? { hunk in unstageHunk(root: root, file: file, hunk: hunk) } : nil
            )
            .disabled(isStagingHunk)
        }
    }

    /// One file of one commit. Committed history is not stageable, so both
    /// `HunkStagingList` callbacks stay nil (its read-only mode).
    @ViewBuilder private var historyDetail: some View {
        VSplitView {
            MonacoDiffView(original: diffOriginal, modified: diffModified,
                           language: MonacoLanguageMap.id(for: diffLanguage))
            if let path = selectedCommitFile, let sha = selectedCommit?.sha {
                hunkPane(key: Self.diffKey(sha: sha, path: path), onStage: nil, onUnstage: nil)
            }
        }
    }

    /// Lower half of the right pane.
    ///
    /// The hunk list — and therefore its Stage/Unstage buttons — renders ONLY
    /// once `loadedKey` says the hunks in state belong to `key`. Without that
    /// gate the newly selected file's buttons draw over the previously
    /// selected file's hunks for the whole load window, and a click there
    /// sends one file's hunk body under another file's path to
    /// `git apply --cached`. The dangerous case is the same PATH flipping
    /// index sides, where the synthesized patch has a plausible header and
    /// can actually succeed against the side the user didn't choose.
    ///
    /// Zero hunks is a real, reachable state — binary files, mode-only
    /// changes, 100 % renames — and gets the explicit empty state the
    /// retired `UnifiedDiffView` used to render.
    @ViewBuilder
    private func hunkPane(key: String,
                          onStage: ((DiffHunk) -> Void)?,
                          onUnstage: ((DiffHunk) -> Void)?) -> some View {
        if loadedKey != key {
            detailPlaceholder("Loading…")
        } else if hunks.isEmpty {
            detailPlaceholder("No changes to show")
        } else {
            HunkStagingList(hunks: hunks, onStage: onStage, onUnstage: onUnstage)
        }
    }

    private func detailPlaceholder(_ message: String) -> some View {
        Text(message)
            .font(Typography.caption)
            .foregroundStyle(theme.current.textMuted)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    var body: some View {
        dialogs(mainBody)
    }

    private var mainBody: some View {
        VStack(spacing: 0) {
            scmHeaderBar
            Divider()
            content
        }
        .background(theme.current.body)
        .task(id: root?.path) {
            scm.config = config
            scm.resolveCredentials = { repo in
                if config.gitLabSavedProjects.contains(where: { $0.localPath == repo.path }),
                   !config.gitLabToken.isEmpty {
                    return (config.gitLabToken, .gitlab)
                }
                if config.gitHubSavedRepos.contains(where: { $0.localPath == repo.path }),
                   !config.gitHubToken.isEmpty {
                    return (config.gitHubToken, .github)
                }
                return nil
            }
            // Clear any selection carried over from a previous repo.
            selectedCommit = nil
            selected = nil
            selectedFiles = []
            commitFilesTask?.cancel(); commitFilesTask = nil
            commitFiles = []
            selectedCommitFile = nil
            clearDiff()
            await scm.refresh(root: root)
        }
        // Fix 1: refresh when window becomes key (picks up external changes)
        .onChange(of: controlActiveState) { _, new in
            if new == .key, let root {
                Task { await scm.refresh(root: root) }
            }
        }
        // Refresh every time the panel appears (fixes terminal branch changes not
        // showing) and start a visible-only poll so external git ops (e.g. a
        // `git checkout` in the integrated terminal) surface without a focus change.
        .onAppear {
            if let root { Task { await scm.refresh(root: root) } }
            startPoll()
        }
        // Every long-running task this view owns dies with it — a diff or
        // commit-file load started just before dismissal would otherwise run
        // to completion and write `@State` for a view that is gone.
        .onDisappear {
            pollTask?.cancel(); pollTask = nil
            diffTask?.cancel(); diffTask = nil
            commitFilesTask?.cancel(); commitFilesTask = nil
        }
        // Fix 2: re-resolve selection by path after any file-list mutation so the
        // diff pane stays correct after stage/unstage/discard
        .onChange(of: scm.state.files) { _, files in
            // In History mode the right pane shows a commit diff; don't let a
            // status refresh clobber it.
            guard mode == .changes else { return }
            // Staging a file moves its row between the two groups, producing
            // a DIFFERENT `FileChange`; drop members that no longer exist so
            // a ghost can't linger as an invisible bulk-action target.
            selectedFiles.formIntersection(files)
            guard let sel = selected else { clearDiff(); return }
            guard let root else { return }
            // Stay on the SAME side of the index the user picked, falling back
            // to the other side only when this one is gone (e.g. the file was
            // just fully staged). Preferring "unstaged" unconditionally used
            // to flip a partially-staged file (porcelain `MM`, which is TWO
            // rows sharing one path) from the staged row to the unstaged one
            // on the next poll — silently removing per-hunk Unstage from under
            // the user, on the file state that most wants it.
            let resolved = files.first(where: { $0.path == sel.path && $0.staged == sel.staged })
                         ?? files.first(where: { $0.path == sel.path })
            if let resolved {
                selected = resolved
                loadFileDiff(root: root, file: resolved)
            } else {
                selected = nil
                clearDiff()
            }
        }
        .onChange(of: selected) { _, sel in
            guard let sel, let root else { clearDiff(); return }
            loadFileDiff(root: root, file: sel)
        }
        // History: load the commit list when entering History mode and clear
        // the file selection so file vs commit diffs never clobber each other.
        .onChange(of: mode) { _, new in
            clearDiff()
            if new == .history {
                selected = nil
                selectedFiles = []
                if let root { Task { commits = await scm.log(root: root) } }
            } else {
                selectedCommit = nil
                commitFilesTask?.cancel(); commitFilesTask = nil
                commitFiles = []
                selectedCommitFile = nil
            }
        }
        // Keep the history list fresh on every refresh while in History mode,
        // and the stash list fresh while in Changes mode.
        .onChange(of: scm.refreshTick) { _, _ in
            guard let root else { return }
            if mode == .history { Task { commits = await scm.log(root: root) } }
            else {
                Task { stashes = await scm.stashList(root: root) }
                Task { tags = await scm.tags(root: root) }
            }
        }
        // Selecting a commit lists the files it touched — it does NOT load a
        // diff. Picking one of those files is a separate step, mirroring
        // Changes mode's select-a-file-then-see-its-diff shape.
        .onChange(of: selectedCommit) { _, c in
            selectedCommitFile = nil
            clearDiff()
            commitFilesTask?.cancel(); commitFilesTask = nil
            guard let c, let root else { commitFiles = []; return }
            commitFilesTask = Task {
                let files = await scm.commitFiles(root: root, sha: c.sha)
                if Task.isCancelled { return }
                commitFiles = files
            }
        }
        .onChange(of: selectedCommitFile) { _, path in
            guard let path, let c = selectedCommit, let root else { clearDiff(); return }
            loadCommitFileDiff(root: root, sha: c.sha, path: path)
        }
    }

    /// All sheets/alerts/confirmation dialogs, factored out of `body` to keep
    /// the main view expression type-checkable.
    @ViewBuilder private func dialogs<V: View>(_ base: V) -> some View {
        base
        .confirmationDialog("Discard changes?", isPresented: Binding(
            get: { confirmDiscard != nil }, set: { if !$0 { confirmDiscard = nil } }
        ), presenting: confirmDiscard) { file in
            Button("Discard \(file.displayPath)", role: .destructive) {
                if let root { Task { await scm.discard(root: root, file: file); confirmDiscard = nil } }
            }
        } message: { file in
            Text(file.status == .untracked
                 ? "“\(file.displayPath)” will be deleted."
                 : "Changes to “\(file.displayPath)” will be lost.")
        }
        .alert("New branch", isPresented: $showCreateBranch) {
            TextField("Branch name", text: $newBranchName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty, let root else { return }
                Task { await scm.createBranch(root: root, name: name) }
            }
        } message: {
            Text("Create a new branch from the current HEAD and switch to it.")
        }
        .confirmationDialog("Delete branch?", isPresented: Binding(
            get: { confirmDeleteBranch != nil }, set: { if !$0 { confirmDeleteBranch = nil } }
        ), presenting: confirmDeleteBranch) { branch in
            Button("Delete \(branch)", role: .destructive) {
                if let root { Task { await scm.deleteBranch(root: root, name: branch); confirmDeleteBranch = nil } }
            }
        } message: { branch in
            Text("Branch “\(branch)” will be deleted (only if fully merged).")
        }
        .alert("Stash changes", isPresented: $showStashMessage) {
            TextField("Message (optional)", text: $stashMessage)
            Button("Cancel", role: .cancel) {}
            Button("Stash") {
                let msg = stashMessage
                guard let root else { return }
                Task { await scm.stashPush(root: root, message: msg); stashMessage = "" }
            }
        } message: {
            Text("Stash all working-tree changes (including untracked files).")
        }
        .confirmationDialog("Discard all changes?", isPresented: $confirmDiscardAll) {
            Button("Discard All Changes", role: .destructive) {
                if let root { Task { await scm.discardAll(root: root) } }
            }
        } message: {
            Text("This permanently deletes all uncommitted changes AND untracked files.")
        }
        .alert("New tag", isPresented: $showCreateTag) {
            TextField("Tag name", text: $newTagName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newTagName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty, let root else { return }
                Task { await scm.createTag(root: root, name: name) }
            }
        } message: {
            Text("Create a lightweight tag at the current HEAD.")
        }
    }

    /// Start a visible-only refresh loop. Cancels any existing poll first so we
    /// never run two concurrently. Skips refreshes while an op is in flight
    /// (`isBusy`) to avoid fighting in-flight stage/commit/push work.
    private func startPoll() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if let root, !scm.isBusy { await scm.refresh(root: root) }
            }
        }
    }

    @ViewBuilder private func leftPane(_ root: URL) -> some View {
        VStack(spacing: 0) {
            branchHeader(root)
            Divider().background(theme.current.border)
            Picker("", selection: $mode) {
                ForEach(PaneMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.sm)
            Divider().background(theme.current.border)
            if mode == .changes {
                ScrollView {
                    fileGroup("Staged Changes", scm.stagedFiles, root, showUnstageAll: true)
                    fileGroup("Changes", scm.unstagedFiles, root, showStageAll: true)
                }
                // The changes list is a hand-built ScrollView + ForEach, not
                // a `List(selection:)`, so arrow keys have to be wired
                // explicitly. `onMoveCommand` is the AppKit-backed hook and
                // fires only while this view holds focus, so it cannot
                // swallow arrows meant for the commit-message field below.
                .focusable()
                .focused($fileListFocused)
                .onMoveCommand { direction in
                    switch direction {
                    case .up:   moveSelection(-1)
                    case .down: moveSelection(1)
                    default:    break        // ←/→ have no meaning in a flat list
                    }
                }
                Divider().background(theme.current.border)
                commitBox(root)
            } else {
                historyList(root)
            }
        }
    }

    /// Cap on the commit-file list's height so a commit touching a hundred
    /// files can't push the commit list itself off-screen. Both halves stay
    /// independently scrollable.
    private static let commitFileListMaxHeight: CGFloat = 240

    @ViewBuilder private func historyList(_ root: URL) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                if commits.isEmpty {
                    Text("No commits")
                        .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Spacing.md).padding(.top, Spacing.sm)
                }
                ForEach(commits) { commit in
                    commitRow(commit)
                }
            }
            if selectedCommit != nil {
                Divider().background(theme.current.border)
                commitFileList()
                    .frame(maxHeight: Self.commitFileListMaxHeight)
            }
        }
    }

    /// Files touched by the selected commit. Picking one loads only THAT
    /// file's diff into the right pane — History never renders a whole
    /// multi-file commit at once.
    @ViewBuilder private func commitFileList() -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Files (\(commitFiles.count))")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Spacing.md).padding(.top, Spacing.sm)
            if commitFiles.isEmpty {
                Text("No files in this commit")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.xs)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(commitFiles, id: \.self) { path in
                            commitFileRow(path)
                        }
                    }
                }
            }
        }
    }

    private func commitFileRow(_ path: String) -> some View {
        Text(path)
            .font(Typography.caption).foregroundStyle(theme.current.text)
            .lineLimit(1).truncationMode(.middle)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.xs)
            .background(selectedCommitFile == path ? theme.current.accent.opacity(0.12) : .clear)
            .contentShape(Rectangle())
            .onTapGesture { selectedCommitFile = path }
    }

    private func commitRow(_ commit: Commit) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Spacing.xs) {
                Text(commit.shortSha)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                Text(commit.subject)
                    .font(Typography.caption).foregroundStyle(theme.current.text)
                    .lineLimit(1).truncationMode(.tail)
            }
            Text("\(commit.author) · \(commit.relativeDate)")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.xs)
        .background(selectedCommit == commit ? theme.current.accent.opacity(0.12) : .clear)
        .contentShape(Rectangle())
        .onTapGesture { selectedCommit = commit }
    }

    /// Tree-state-independent overflow: tag create/list + discard-all. Lives in
    /// the branch header so tags stay reachable even with a clean working tree.
    private func overflowMenu(_ root: URL) -> some View {
        Menu {
            Button("Create Tag…") { newTagName = ""; showCreateTag = true }
            if !tags.isEmpty {
                Menu("Tags") {
                    ForEach(tags, id: \.self) { Text($0) }   // read-only listing
                }
            }
            Divider()
            Button("Discard All Changes", role: .destructive) { confirmDiscardAll = true }
        } label: {
            Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(scm.isBusy)
        .help("More actions (tags, discard all)")
    }

    private func branchHeader(_ root: URL) -> some View {
        let credHelp = "Configure a token in Settings → GitLab / GitHub"
        return HStack(spacing: Spacing.sm) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 12))
            branchMenu(root)
            if scm.state.ahead > 0 { Text("↑\(scm.state.ahead)").font(Typography.caption) }
            if scm.state.behind > 0 { Text("↓\(scm.state.behind)").font(Typography.caption) }
            Spacer()
            if mode == .changes { stashMenu(root) }
            Button { Task { await scm.pull(root: root) } } label: {
                Image(systemName: "arrow.down")
            }.buttonStyle(.plain)
                .disabled(scm.isBusy || !hasCredentials || isBlocked(.sync, root: root))
                .help(isBlocked(.sync, root: root) ? blockedHelp(.sync, root: root)
                      : (hasCredentials ? "Pull" : credHelp))
            Button { Task { await scm.push(root: root) } } label: {
                Image(systemName: "arrow.up")
            }.buttonStyle(.plain)
                .disabled(scm.isBusy || !hasCredentials || isBlocked(.push, root: root))
                .help(isBlocked(.push, root: root) ? blockedHelp(.push, root: root)
                      : (hasCredentials ? "Push" : credHelp))
            Button { Task { await scm.sync(root: root) } } label: {
                Image(systemName: "arrow.triangle.2.circlepath")
            }.buttonStyle(.plain)
                .disabled(scm.isBusy || !hasCredentials || isBlocked(.sync, root: root) || isBlocked(.push, root: root))
                .help(isBlocked(.sync, root: root) ? blockedHelp(.sync, root: root)
                      : isBlocked(.push, root: root) ? blockedHelp(.push, root: root)
                      : (hasCredentials ? "Sync (fetch)" : credHelp))
            Button { Task { await scm.refresh(root: root) } } label: {
                Image(systemName: "arrow.clockwise")
            }.buttonStyle(.plain).disabled(scm.isBusy).help("Refresh")
            overflowMenu(root)
        }
        .foregroundStyle(theme.current.text)
        .padding(.horizontal, Spacing.md).padding(.vertical, Spacing.sm)
    }

    private func branchMenu(_ root: URL) -> some View {
        Menu {
            ForEach(branches, id: \.self) { b in
                Button {
                    Task { await scm.checkout(root: root, branch: b) }
                } label: {
                    if b == scm.state.branch {
                        Label(b, systemImage: "checkmark")
                    } else {
                        Text(b)
                    }
                }
            }
            Divider()
            Button("Create Branch…") {
                newBranchName = ""
                showCreateBranch = true
            }
            .disabled(isBlocked(.createBranch, root: root))
            if !scm.state.hasUpstream {
                Button("Publish Branch") {
                    Task { await scm.publish(root: root) }
                }
                .disabled(isBlocked(.push, root: root))
            }
            // Merge / Delete are offered only for non-current branches
            // (you can't merge or delete the branch you're on).
            let others = branches.filter { $0 != scm.state.branch }
            if !others.isEmpty {
                Divider()
                Menu("Merge into current") {
                    ForEach(others, id: \.self) { b in
                        Button("Merge “\(b)”") {
                            Task { await scm.merge(root: root, branch: b) }
                        }
                    }
                }
                ForEach(others, id: \.self) { b in
                    Button("Delete \(b)", role: .destructive) {
                        confirmDeleteBranch = b
                    }
                }
            }
        } label: {
            HStack(spacing: 2) {
                Text(scm.state.branch ?? "—").font(Typography.bodyStrong)
                Image(systemName: "chevron.down").font(.system(size: 9))
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(scm.isBusy)
        .onAppear { Task { branches = await scm.listBranches(root: root) } }
        // Reload on every refresh (poll/manual/op) so branch deletes and
        // external/terminal branch changes are reflected, not just HEAD moves.
        .onChange(of: scm.refreshTick) { _, _ in
            Task { branches = await scm.listBranches(root: root) }
        }
    }

    private func stashMenu(_ root: URL) -> some View {
        Menu {
            Button("Stash Changes…") {
                stashMessage = ""
                showStashMessage = true
            }
            if !stashes.isEmpty {
                Divider()
                ForEach(stashes) { stash in
                    Button("Pop: \(stash.message)") {
                        Task { await scm.stashPop(root: root, index: stash.index) }
                    }
                }
            }
        } label: {
            Image(systemName: "tray.and.arrow.down").font(.system(size: 12))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(scm.isBusy)
        .help("Stash")
    }

    @ViewBuilder private func fileGroup(_ title: String, _ files: [FileChange], _ root: URL,
                                        showStageAll: Bool = false,
                                        showUnstageAll: Bool = false) -> some View {
        if !files.isEmpty {
            HStack(spacing: Spacing.xs) {
                Text("\(title) (\(files.count))")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                Spacer()
                if showStageAll {
                    Button { Task { await scm.stageAll(root: root) } } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.plain)
                    .disabled(scm.isBusy)
                    .help("Stage All")
                }
                if showUnstageAll {
                    Button { Task { await scm.unstageAll(root: root) } } label: {
                        Image(systemName: "minus")
                    }
                    .buttonStyle(.plain)
                    .disabled(scm.isBusy)
                    .help("Unstage All")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.md).padding(.top, Spacing.sm)
            ForEach(files) { file in
                fileRow(file, root)
            }
        }
    }

    // MARK: - Changes-list selection

    /// Every file in the order the two `fileGroup`s render them — staged
    /// first, then unstaged — so ↑/↓ walk the list the way it looks on
    /// screen, crossing the group boundary.
    private var filesInDisplayOrder: [FileChange] {
        scm.stagedFiles + scm.unstagedFiles
    }

    /// Resolves a ⇧-click range between `file` and `anchor`, scoped to
    /// whichever single group (staged or unstaged) both belong to. nil when
    /// they're in DIFFERENT groups: those render as two separate lists, so a
    /// range spanning both has no meaning on screen.
    private func fileGroupFiles(containing file: FileChange, and anchor: FileChange) -> [FileChange]? {
        for list in [scm.stagedFiles, scm.unstagedFiles] {
            guard let iFile = list.firstIndex(of: file),
                  let iAnchor = list.firstIndex(of: anchor) else { continue }
            let range = iFile < iAnchor ? iFile...iAnchor : iAnchor...iFile
            return Array(list[range])
        }
        return nil
    }

    /// Handle a click on `file`: ⌘ toggles membership, ⇧ extends from the
    /// last-clicked anchor within one group, a plain click replaces the
    /// selection. The clicked file always becomes the diff-pane selection,
    /// and the click takes focus so ↑/↓ work immediately afterwards.
    private func selectFile(_ file: FileChange) {
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) {
            if selectedFiles.contains(file) { selectedFiles.remove(file) }
            else { selectedFiles.insert(file) }
        } else if flags.contains(.shift), let anchor = selected,
                  let range = fileGroupFiles(containing: file, and: anchor) {
            selectedFiles.formUnion(range)
        } else {
            selectedFiles = [file]
        }
        selected = file
        fileListFocused = true
    }

    /// Move the diff-pane selection one row up (-1) or down (+1). Clamps at
    /// both ends rather than wrapping, matching Finder/Xcode list behavior.
    ///
    /// "Nothing selected" and "selected but not in this list" are handled
    /// SEPARATELY. Collapsing them sent the selection to row 0 on any arrow
    /// press inside the re-resolution window — `scm.state.files` has been
    /// replaced but `.onChange(of:)` has not yet mapped `selected` onto the
    /// new snapshot — which is a jump the user did not ask for, on a list
    /// that refreshes itself every 3 seconds.
    private func moveSelection(_ delta: Int) {
        let files = filesInDisplayOrder
        guard !files.isEmpty else { return }
        guard let current = selected else {
            // Nothing selected yet: either arrow key lands on the first row.
            selected = files[0]
            selectedFiles = [files[0]]
            return
        }
        // Stale selection: `.onChange(of: scm.state.files)` is about to
        // re-resolve it (or clear it). Do nothing for this keystroke rather
        // than yanking the selection to the top of the list.
        guard let idx = files.firstIndex(of: current) else { return }
        let file = files[min(max(idx + delta, 0), files.count - 1)]
        selected = file
        selectedFiles = [file]
    }

    /// Row background. The diff-shown file keeps EXACTLY the wash it had
    /// before multi-select existed; the rest of a multi-selection gets a
    /// lighter one so a ⌘/⇧-click is visible at all — without that,
    /// multi-select would be invisible on screen and the context menu's
    /// "Stage 3 Files" would appear out of nowhere.
    private func rowBackground(_ file: FileChange) -> Color {
        if selected == file { return theme.current.accent.opacity(0.12) }
        if selectedFiles.contains(file) { return theme.current.accent.opacity(0.06) }
        return .clear
    }

    /// Right-click menu for a file row: a second entry point to the actions
    /// the row's own buttons already offer, plus the two path utilities.
    ///
    /// Bulk stage/unstage applies to the whole selection when the clicked row
    /// is part of it, filtered to the rows the action actually fits — a
    /// selection spanning both groups would otherwise let "Unstage 3 Files"
    /// run `unstage` over files that were never staged.
    ///
    /// Discard stays SINGLE-file: `confirmDiscard` presents a dialog naming
    /// one file, and this task does not extend it. A "Discard (3 Files)"
    /// label over a one-file dialog would misdescribe a destructive action.
    ///
    /// **The menu always targets the RIGHT-CLICKED row, which is not
    /// necessarily the highlighted one.** Right-clicking outside the
    /// selection leaves the highlight where it was, so the menu can look
    /// like it acts on the highlighted row; the item labels ("Stage",
    /// "Stage 3 Files") are what say which. Adopting the row on right-click
    /// would need a pre-presentation hook `.contextMenu` does not offer —
    /// mutating `@State` from a `@ViewBuilder` is illegal — so this is
    /// documented rather than fixed. Do NOT reach for an
    /// `NSViewRepresentable` right-click monitor to close the gap.
    @ViewBuilder
    private func contextMenuItems(for file: FileChange) -> some View {
        let selection = selectedFiles.contains(file) ? Array(selectedFiles) : [file]
        let targets = selection.filter { $0.staged == file.staged }
        let suffix = targets.count > 1 ? " \(targets.count) Files" : ""
        if file.staged {
            Button("Unstage\(suffix)") {
                guard let root else { return }
                Task { for target in targets { await scm.unstage(root: root, path: target.path) } }
            }
        } else {
            Button("Stage\(suffix)") {
                guard let root else { return }
                Task { for target in targets { await scm.stage(root: root, path: target.path) } }
            }
            Button("Discard Changes", role: .destructive) { confirmDiscard = file }
        }
        Divider()
        Button("Copy Path") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(file.path, forType: .string)
        }
        Button("Reveal in Finder") {
            guard let root else { return }
            NSWorkspace.shared.activateFileViewerSelecting([root.appendingPathComponent(file.path)])
        }
    }

    /// A row's file label: a rename shows where the file CAME FROM as well as
    /// where it is now; every other status is just the path. Shared by the
    /// row's `Text` and its tooltip so the two cannot drift apart.
    private func rowLabel(_ file: FileChange) -> String {
        file.renamedFrom.map { "\($0) → \(file.displayPath)" } ?? file.displayPath
    }

    private func fileRow(_ file: FileChange, _ root: URL) -> some View {
        HStack(spacing: Spacing.xs) {
            Text(badge(file.status)).font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(color(file.status)).frame(width: 14)
            // Middle-truncated in a 300pt column, so the tooltip carries the
            // whole thing — a rename prints two paths in the space one used
            // to take and is the likeliest row to lose its middle.
            Text(rowLabel(file))
                .font(Typography.caption).lineLimit(1).truncationMode(.middle)
                .help(rowLabel(file))
            Spacer()
            if file.staged {
                Button { Task { await scm.unstage(root: root, path: file.path) } } label: {
                    Image(systemName: "minus") }.buttonStyle(.plain).help("Unstage")
            } else {
                Button { Task { await scm.stage(root: root, path: file.path) } } label: {
                    Image(systemName: "plus") }.buttonStyle(.plain).help("Stage")
                Button { confirmDiscard = file } label: {
                    Image(systemName: "arrow.uturn.backward") }.buttonStyle(.plain).help("Discard")
            }
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, 3)
        .background(rowBackground(file))
        .contentShape(Rectangle())
        .onTapGesture { selectFile(file) }
        .contextMenu { contextMenuItems(for: file) }
    }

    private func commitBox(_ root: URL) -> some View {
        // Amend with an empty message uses --no-edit, so the message-required
        // gate is lifted when amend is on.
        let noChanges = scm.stagedFiles.isEmpty && scm.unstagedFiles.isEmpty
        let emptyMessage = message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let commitDisabled = scm.isBusy || (!amendOn && (emptyMessage || noChanges))
        return VStack(spacing: Spacing.xs) {
            TextField("Commit message", text: $message, axis: .vertical)
                .textFieldStyle(.plain).lineLimit(1...4)
                .padding(Spacing.sm)
                .background(theme.current.surface2).clipShape(RoundedRectangle(cornerRadius: Radius.sm))
            Toggle("Amend last commit", isOn: $amendOn)
                .font(Typography.caption)
                .toggleStyle(.checkbox)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: Spacing.xs) {
                Button {
                    let msg = message
                    Task {
                        if amendOn { await scm.amend(root: root, message: msg) }
                        else { await scm.commit(root: root, message: msg) }
                        message = ""
                    }
                } label: { Text(amendOn ? "Amend" : "Commit").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent)
                .disabled(commitDisabled)
                // Commit & Push: commit (commit-all-aware) then push the branch.
                // Needs credentials and an actual change to commit; not offered
                // for amend (push of a rewritten commit would need a force-push).
                Button {
                    let msg = message
                    Task { await scm.commitAndPush(root: root, message: msg); message = "" }
                } label: { Image(systemName: "arrow.up.circle") }
                .buttonStyle(.bordered)
                .disabled(scm.isBusy || amendOn || emptyMessage || noChanges || !hasCredentials)
                .help(hasCredentials ? "Commit & Push"
                      : "Configure a token in Settings → GitLab / GitHub")
            }
        }
        .padding(Spacing.md)
    }

    /// Banner showing the sticky op error (priority) or the transient status
    /// error. Op errors get a dismiss (×); status errors clear themselves on
    /// the next refresh, so no button is needed. Returns nothing when both are
    /// nil.
    @ViewBuilder private func errorBanner() -> some View {
        if let msg = scm.state.opError ?? scm.state.error {
            HStack(alignment: .top, spacing: Spacing.xs) {
                Text(msg).font(Typography.caption).foregroundStyle(theme.current.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if scm.state.opError != nil {
                    Button { scm.clearOpError() } label: {
                        Image(systemName: "xmark").font(.system(size: 10))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(theme.current.textMuted)
                    .help("Dismiss")
                }
            }
            .padding(Spacing.sm).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var emptyState: some View {
        EmptyStateView(
            icon: "arrow.triangle.branch",
            title: "No active repository",
            message: "Activate a cloned repo in Settings → GitLab / GitHub to see changes here.",
            actionLabel: "Open Settings",
            action: { NotificationCenter.default.post(name: .openSection, object: "settings") }
        )
    }

    private func badge(_ s: FileChange.Status) -> String {
        switch s {
        case .added: return "A"
        case .modified: return "M"
        case .deleted: return "D"
        case .renamed: return "R"
        case .untracked: return "U"
        case .conflicted: return "C"
        }
    }
    private func color(_ s: FileChange.Status) -> Color {
        theme.current.color(for: s)
    }
}
