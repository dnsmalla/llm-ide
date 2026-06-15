import SwiftUI

/// Cursor-style Source Control panel over the active cloned repo. Two-pane
/// HSplitView: left = branch header + staged/unstaged file groups + commit
/// box; right = the colored unified diff of the selected file. Empty state
/// when no repo is active. Discard goes through a destructive confirmation.
struct SourceControlView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(\.controlActiveState) private var controlActiveState
    @State private var scm = SourceControlService()
    @State private var selected: FileChange?
    @State private var hunks: [DiffHunk] = []
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

    private enum PaneMode: String, CaseIterable { case changes = "Changes", history = "History" }

    /// Load `hunks` from an async producer, cancelling any prior load first
    /// and discarding the result if this load was superseded.
    private func loadHunks(_ produce: @escaping () async -> [DiffHunk]) {
        diffTask?.cancel()
        diffTask = Task {
            let h = await produce()
            if Task.isCancelled { return }
            hunks = h
        }
    }

    private var root: URL? { config.activeRepoLocalURL }

    /// highlight.js language hint for the right diff pane: "diff" in History
    /// mode (multi-file commit diff), else the selected file's extension.
    private var diffLanguage: String {
        if mode == .history { return "diff" }
        return (selected?.path as NSString?)?.pathExtension ?? ""
    }

    /// Whether the active repo has saved credentials (enables pull/push/sync).
    private var hasCredentials: Bool {
        guard let root else { return false }
        return scm.resolveCredentials?(root) != nil
    }

    @ViewBuilder private var content: some View {
        if let root {
            HSplitView {
                leftPane(root).frame(minWidth: 280, idealWidth: 340, maxWidth: 520)
                UnifiedDiffView(hunks: hunks, fileExtension: diffLanguage)
                    .frame(minWidth: 360)
            }
        } else {
            emptyState
        }
    }

    var body: some View {
        dialogs(mainBody)
    }

    private var mainBody: some View {
        content
        .background(theme.current.body)
        .task(id: root?.path) {
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
        .onDisappear { pollTask?.cancel(); pollTask = nil }
        // Fix 2: re-resolve selection by path after any file-list mutation so the
        // diff pane stays correct after stage/unstage/discard
        .onChange(of: scm.state.files) { _, files in
            // In History mode the right pane shows a commit diff; don't let a
            // status refresh clobber it.
            guard mode == .changes else { return }
            guard let sel = selected else { hunks = []; return }
            guard let root else { return }
            // Prefer the unstaged copy; fall back to staged (e.g. freshly staged file)
            let resolved = files.first(where: { $0.path == sel.path && !$0.staged })
                         ?? files.first(where: { $0.path == sel.path && $0.staged })
            if let resolved {
                selected = resolved
                loadHunks { await scm.diff(root: root, file: resolved) }
            } else {
                selected = nil
                hunks = []
            }
        }
        .onChange(of: selected) { _, sel in
            guard let sel, let root else { hunks = []; return }
            loadHunks { await scm.diff(root: root, file: sel) }
        }
        // History: load the commit list when entering History mode and clear
        // the file selection so file vs commit diffs never clobber each other.
        .onChange(of: mode) { _, new in
            if new == .history {
                selected = nil
                if let root { Task { commits = await scm.log(root: root) } }
            } else {
                selectedCommit = nil
                hunks = []
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
        // Load the selected commit's diff into the shared right pane.
        .onChange(of: selectedCommit) { _, c in
            guard let c, let root else { hunks = []; return }
            loadHunks { await scm.commitDiff(root: root, sha: c.sha) }
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
                    if let err = scm.state.error { errorBanner(err) }
                    fileGroup("Staged Changes", scm.stagedFiles, root)
                    fileGroup("Changes", scm.unstagedFiles, root, showStageAll: true)
                }
                Divider().background(theme.current.border)
                commitBox(root)
            } else {
                historyList(root)
            }
        }
    }

    @ViewBuilder private func historyList(_ root: URL) -> some View {
        ScrollView {
            if let err = scm.state.error { errorBanner(err) }
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
                .disabled(scm.isBusy || !hasCredentials)
                .help(hasCredentials ? "Pull" : credHelp)
            Button { Task { await scm.push(root: root) } } label: {
                Image(systemName: "arrow.up")
            }.buttonStyle(.plain)
                .disabled(scm.isBusy || !hasCredentials)
                .help(hasCredentials ? "Push" : credHelp)
            Button { Task { await scm.sync(root: root) } } label: {
                Image(systemName: "arrow.triangle.2.circlepath")
            }.buttonStyle(.plain)
                .disabled(scm.isBusy || !hasCredentials)
                .help(hasCredentials ? "Sync (fetch)" : credHelp)
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
            if !scm.state.hasUpstream {
                Button("Publish Branch") {
                    Task { await scm.publish(root: root) }
                }
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
                                        showStageAll: Bool = false) -> some View {
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
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Spacing.md).padding(.top, Spacing.sm)
            ForEach(files) { file in
                fileRow(file, root)
            }
        }
    }

    private func fileRow(_ file: FileChange, _ root: URL) -> some View {
        HStack(spacing: Spacing.xs) {
            Text(badge(file.status)).font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(color(file.status)).frame(width: 14)
            Text(file.displayPath).font(Typography.caption).lineLimit(1).truncationMode(.middle)
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
        .background(selected == file ? theme.current.accent.opacity(0.12) : .clear)
        .contentShape(Rectangle())
        .onTapGesture { selected = file }
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

    private func errorBanner(_ msg: String) -> some View {
        Text(msg).font(Typography.caption).foregroundStyle(theme.current.danger)
            .padding(Spacing.sm).frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.sm) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 28))
                .foregroundStyle(theme.current.textMuted)
            Text("No active repository").font(Typography.bodyStrong)
            Text("Activate a cloned repo in Settings → GitLab / GitHub.")
                .font(Typography.caption).foregroundStyle(theme.current.textMuted)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
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
        switch s {
        case .added, .untracked: return .green
        case .deleted: return .red
        case .conflicted: return .orange
        default: return theme.current.accent2
        }
    }
}
