// Review-and-commit for the files a Loop run changed.
//
// Before this, a run's `changedPaths` were a plain text list and the UI's own
// advice was "review with git before committing" — i.e. go use another tool.
// This closes that loop: expand a path to read its hunks, then commit exactly
// the run's files with one message.
//
// **What it shows is the working tree NOW, not a snapshot of the run.** The
// journal records which paths a repair touched, never the patch itself, and
// capturing patches would put unbounded diff text into every run record. So
// the diff is read live from git, which is exactly right in the common case
// (the run just finished and you want to see what it did) and honestly
// labelled for the case where it is not — a path already committed, reverted,
// or edited since shows as no longer modified rather than pretending to be
// the run's own change.
//
// **Two invariants make the commit trustworthy**, and both cost a deliberate
// departure from `SourceControlService`'s own commit path:
//
// 1. *Only these files are committed.* `git commit` commits the whole INDEX,
//    so staging the run's paths and calling a plain commit would also ship
//    anything the user had staged for a separate commit. This commits with a
//    **pathspec** (`git commit -m … -- <paths>`), which takes those paths'
//    working-tree content and leaves the rest of the index untouched.
// 2. *What you read is what you commit.* The diff is therefore `HEAD` vs the
//    working tree, NOT `SourceControlService.diff`'s index-vs-worktree — for a
//    partially staged file those differ, and showing only the unstaged half of
//    a file this view is about to commit whole would hide real content behind
//    a review button.
//
// Built on `RepoManager` (the sanctioned local-git entry point) + the shared
// `StatusParser`/`UnifiedDiffParser`/`DiffHunk` models + `HunkStagingList`
// from `Views/Shared/`, all of which survive the lite build.
// `SourceControlView` and everything else under `Views/SourceControl/` is
// compiled OUT while LoopEngine is compiled IN (see mac/Package.swift's
// `file_explorer` key), so neither depending on it nor navigating to that
// section is an option here.
//
// `SourceControlService` is deliberately NOT used, despite offering status,
// diff and commit: its `refresh` writes `.gitignore` files into the repo as
// housekeeping, and merely clicking a past run to look at it must not mutate
// the user's working tree. Reading status through `git status --porcelain` +
// `StatusParser` is the same thing `GitRepairScopeGuard` does, with no side
// effects.

import SwiftUI

struct LoopRunChangesReview: View {
    /// The checkout to diff and commit in — the project's current git working
    /// tree, not `LoopRunRecord.gitRoot`.
    let gitRoot: URL
    /// Repo-relative paths the run reported changing.
    let paths: [String]
    /// True when the run executed against a checkout other than `gitRoot`.
    /// Its edits are not in this working tree, so there is nothing here to
    /// review. Deliberately named for what is KNOWN (a different checkout)
    /// rather than the likeliest cause: an isolated worktree that has since
    /// been removed is the common case, but a scheduled run resolving its git
    /// root differently than the desktop does produces the same inequality.
    let ranInDifferentCheckout: Bool
    /// Seed for the commit message field.
    let defaultMessage: String

    @EnvironmentObject var theme: ThemeStore

    @State private var repo = RepoManager()
    /// Live `git status` rows for this checkout, refreshed explicitly.
    @State private var files: [FileChange] = []
    @State private var statusError: String?
    @State private var hunks: [String: [DiffHunk]] = [:]
    /// Why a path's diff could not be read, keyed by path. Kept apart from
    /// `hunks` so "git failed" is never rendered as "no textual diff".
    @State private var diffErrors: [String: String] = [:]
    @State private var expanded: Set<String> = []
    @State private var message = ""
    /// Two flags, not one: sharing them made pressing Refresh relabel the
    /// Commit button "Committing…" for the duration of a `git status`.
    @State private var isCommitting = false
    @State private var isRefreshing = false
    @State private var committedNote: String?
    @State private var commitError: String?

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("Files changed")
                    .font(Typography.caption.weight(.semibold))
                    .foregroundStyle(t.textMuted)
                Spacer()
                if !ranInDifferentCheckout {
                    // The working tree can change under this view (a terminal
                    // commit, another run) and nothing pushes that at us.
                    Button {
                        Task { await reload() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 9))
                    }
                    .buttonStyle(.borderless)
                    .disabled(isRefreshing || isCommitting)
                    .help("Re-read git status and discard loaded diffs")
                }
                Text("\(paths.count)")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }

            if ranInDifferentCheckout {
                Text("This run worked in a different checkout than the one open now — often an isolated worktree, which is removed when the run ends. These paths were changed there, so there is nothing to review or commit here.")
                    .font(Typography.caption)
                    .foregroundStyle(t.accent4)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Read live from git against HEAD, so it reflects the working tree now — not a snapshot taken during the run.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(paths, id: \.self) { path in
                pathRow(path)
            }

            if !ranInDifferentCheckout, !dirtyPaths.isEmpty {
                commitBox
            }
            if let committedNote {
                Text(committedNote)
                    .font(Typography.caption)
                    .foregroundStyle(t.success)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // `statusError` first: when git status itself failed, that is the
            // explanation for whatever the commit path then reported.
            if let problem = statusError ?? commitError {
                Text(problem)
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // Keyed on the checkout only because the CALL SITE gives this view a
        // per-record identity (`.id(record.id)`), so selecting another run
        // builds a fresh instance rather than reusing this one's loaded
        // diffs, commit note, and message.
        .task(id: gitRoot.path) {
            message = defaultMessage
            guard !ranInDifferentCheckout else { return }
            await loadStatus()
        }
    }

    /// Reads `git status` for this checkout. Read-only by construction — the
    /// reason this view does not use `SourceControlService` (see file header).
    private func loadStatus() async {
        do {
            let raw = try await repo.runGit(
                ["status", "--porcelain", "--untracked-files=all"], at: gitRoot)
            files = StatusParser.parse(porcelain: raw)
            statusError = nil
        } catch {
            files = []
            statusError = "Could not read git status: \(error.localizedDescription)"
        }
    }

    // MARK: - Rows

    /// The run's paths that git still reports as changed. Only these are
    /// offered for commit — a path the user already committed or reverted
    /// must not be silently re-committed by this view.
    private var dirtyPaths: [String] {
        paths.filter { change(for: $0) != nil }
    }

    /// Any status row for `path`. Which side (staged or not) no longer
    /// matters for the diff — that is read against HEAD — so this only
    /// answers "does git consider this path changed"; `isPartiallyStaged`
    /// reports the partially-staged case separately.
    private func change(for path: String) -> FileChange? {
        files.first { $0.path == path }
    }

    /// True when `path` has BOTH a staged and an unstaged row (porcelain
    /// "MM"): the user staged part of this file for their own commit, and a
    /// pathspec commit here will take the whole file.
    private func isPartiallyStaged(_ path: String) -> Bool {
        let rows = files.filter { $0.path == path }
        return rows.contains(where: \.staged) && rows.contains(where: { !$0.staged })
    }

    /// The in-progress operation that makes git refuse a partial commit, or
    /// `nil` when there is none.
    ///
    /// Asks about the STATE rather than counting conflicted paths: a merge
    /// whose conflicts have all been resolved with `git add` has no
    /// conflicted rows left while `MERGE_HEAD` still exists, and that is
    /// exactly when a path-count check would wave the commit through into
    /// the raw fatal. `rev-parse --verify` rather than probing
    /// `.git/MERGE_HEAD`, because `.git` is a FILE (not a directory) in a
    /// linked worktree — which is where this feature runs its parallel loops.
    ///
    /// Only these two refs: a cherry-pick refuses exactly like a merge, while
    /// an in-progress revert or rebase permits a pathspec commit, so naming
    /// them here would refuse a commit git would have accepted.
    private func blockingGitOperation() async -> String? {
        for (ref, name) in [("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick")] {
            // Non-zero exit (which `runGit` throws on) is the normal "not in
            // this state" answer; `-q` keeps that quiet rather than a fatal.
            if (try? await repo.runGit(["rev-parse", "-q", "--verify", ref], at: gitRoot)) != nil {
                return name
            }
        }
        return nil
    }

    @ViewBuilder
    private func pathRow(_ path: String) -> some View {
        let t = theme.current
        let file = change(for: path)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if file != nil, !ranInDifferentCheckout {
                    Button {
                        toggle(path)
                    } label: {
                        Image(systemName: expanded.contains(path) ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9))
                            .foregroundStyle(t.textMuted)
                    }
                    .buttonStyle(.borderless)
                    // Expanding mid-commit could let a `loadDiff` write into
                    // `hunks` after `commit()` clears it, caching one
                    // pre-commit diff for that row until the next Refresh.
                    .disabled(isCommitting)
                } else {
                    // Keeps every row's text on the same left edge whether or
                    // not it has a disclosure control.
                    Spacer().frame(width: 12)
                }
                Text(path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(t.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer(minLength: 4)
                statusBadge(file, path: path)
            }
            if expanded.contains(path) {
                expandedDiff(path)
            }
        }
    }

    @ViewBuilder
    private func expandedDiff(_ path: String) -> some View {
        let t = theme.current
        if let failure = diffErrors[path] {
            // Distinct from the empty-diff case below: telling the user their
            // file is binary when git actually errored sends them looking in
            // the wrong place entirely.
            Text("Could not read this diff: \(failure)")
                .font(Typography.caption)
                .foregroundStyle(t.danger)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 14)
        } else if let loaded = hunks[path] {
            if loaded.isEmpty {
                Text("git reported no textual diff against HEAD (a binary file, or a mode-only change).")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .padding(.leading, 14)
            } else {
                // Read-only: no onStage/onUnstage. Per-hunk staging is a
                // source-control workflow; here the unit of action is
                // "commit what this run changed".
                HunkStagingList(hunks: loaded)
                    .frame(maxHeight: 220)
                    .padding(.leading, 14)
            }
        } else {
            Text("Loading diff…")
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .padding(.leading, 14)
        }
    }

    @ViewBuilder
    private func statusBadge(_ file: FileChange?, path: String) -> some View {
        let t = theme.current
        if ranInDifferentCheckout {
            Text("elsewhere")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(t.textMuted)
        } else if let file {
            HStack(spacing: 4) {
                if isPartiallyStaged(path) {
                    // Load-bearing warning, not decoration: this file has the
                    // user's own staged work in it, and committing from here
                    // takes the whole file.
                    Text("partly staged")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(t.accent4)
                        .help("You have part of this file staged. Committing here commits the whole file, including that.")
                }
                Text(file.status.rawValue)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(t.accent)
            }
        } else if statusError != nil {
            // "no longer modified" would be a claim about git made while git
            // could not be read at all.
            Text("status unavailable")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(t.danger)
                .help("git status could not be read — see the error below")
        } else {
            Text("no longer modified")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(t.textMuted)
                .help("Committed, reverted, or changed back since the run")
        }
    }

    private func toggle(_ path: String) {
        if expanded.contains(path) {
            expanded.remove(path)
            return
        }
        expanded.insert(path)
        guard hunks[path] == nil, diffErrors[path] == nil,
              let file = change(for: path) else { return }
        Task { await loadDiff(path: path, file: file) }
    }

    /// `HEAD` vs working tree for `path` — what a pathspec commit from here
    /// would actually record. Index-vs-worktree (what a plain `git diff`
    /// gives) is deliberately avoided: for a partially staged file it shows
    /// only the half that is not staged, while the commit takes both.
    private func loadDiff(path: String, file: FileChange) async {
        // An untracked file has no HEAD side to diff against; synthesize the
        // all-insert hunk from its contents, the way the shared model does
        // for an agent's not-yet-committed edit.
        if file.status == .untracked {
            let url = gitRoot.appendingPathComponent(path)
            guard let content = try? String(contentsOf: url, encoding: .utf8) else {
                diffErrors[path] = "unreadable as UTF-8 text"
                return
            }
            // `fromLineDiff` leaves `header` empty, which renders as a blank
            // grey bar above the rows; synthesize the @@ line a real
            // whole-file insertion would carry.
            hunks[path] = DiffHunk.fromLineDiff(old: "", new: content).map { hunk in
                guard hunk.header.isEmpty else { return hunk }
                var titled = hunk
                titled.header = "@@ -0,0 +1,\(hunk.rows.count) @@"
                return titled
            }
            return
        }
        do {
            let raw = try await repo.runGit(["diff", "HEAD", "--", path], at: gitRoot)
            hunks[path] = UnifiedDiffParser.parse(raw)
        } catch {
            diffErrors[path] = error.localizedDescription
        }
    }

    private func reload() async {
        isRefreshing = true
        defer { isRefreshing = false }
        commitError = nil
        committedNote = nil
        hunks = [:]
        diffErrors = [:]
        expanded = []
        await loadStatus()
    }

    // MARK: - Commit

    private var commitBox: some View {
        let t = theme.current
        let partly = dirtyPaths.filter { isPartiallyStaged($0) }
        return VStack(alignment: .leading, spacing: 4) {
            Divider().background(t.border).padding(.vertical, 2)
            TextField("Commit message", text: $message, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(Typography.caption)
            HStack(spacing: Spacing.sm) {
                Button(isCommitting ? "Committing…" : "Commit \(dirtyPaths.count) file(s)") {
                    Task { await commit() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(isCommitting || isRefreshing
                          || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Text("Commits these files only. Anything you have staged for a different commit stays staged.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !partly.isEmpty {
                Text("\(partly.count) of these are partly staged — committing takes the whole file, including the part you staged.")
                    .font(Typography.caption)
                    .foregroundStyle(t.accent4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func commit() async {
        isCommitting = true
        defer { isCommitting = false }
        commitError = nil
        committedNote = nil
        // Re-read status first: this view can have been open for a while, and
        // committing a path list computed from stale status is how a "commit
        // 2 files" ends up committing something else entirely.
        await loadStatus()
        // A status read that FAILED leaves `files` empty, which would make
        // the guard below announce "no longer modified" — asserting a fact
        // about git while git is precisely what could not be read.
        guard statusError == nil else { return }
        let toCommit = dirtyPaths
        guard !toCommit.isEmpty else {
            commitError = "Nothing left to commit — these paths are no longer modified."
            return
        }
        // Say it in words instead of forwarding `fatal: cannot do a partial
        // commit during a merge`. Finishing the merge is the fix; committing
        // the whole index here instead would be exactly the index-wide commit
        // invariant 1 exists to prevent.
        if let blocking = await blockingGitOperation() {
            commitError = "This repo has a \(blocking) in progress. Finish or abort it first — git cannot commit a subset of files mid-\(blocking)."
            return
        }
        // Untracked paths must be added before a pathspec can name them; git
        // rejects an unknown pathspec outright. Tracked paths need no staging
        // at all — the pathspec commit takes their working-tree content.
        let untracked = toCommit.filter { change(for: $0)?.status == .untracked }
        do {
            if !untracked.isEmpty {
                _ = try await repo.runGit(["add", "--"] + untracked, at: gitRoot)
            }
            // The pathspec is what confines the commit to these files; see
            // invariant 1 in the file header.
            _ = try await repo.runGit(["commit", "-m", message, "--"] + toCommit, at: gitRoot)
            committedNote = "Committed \(toCommit.count) file(s)."
            hunks = [:]
            diffErrors = [:]
            expanded = []
        } catch {
            commitError = error.localizedDescription
            // Undo the staging this method did. Without it a rejected commit
            // (a commit-msg hook, an unexpected git state) leaves the loop's
            // new files sitting in the user's index — invariant 1 broken by
            // the failure path rather than the success path. Only the paths
            // added just above are unstaged, never anything the user staged.
            if !untracked.isEmpty {
                _ = try? await repo.runGit(["restore", "--staged", "--"] + untracked, at: gitRoot)
            }
        }
        await loadStatus()
    }
}
