import Foundation
import Observation

@MainActor
@Observable
final class SourceControlService {
    struct State {
        var branch: String?
        var ahead: Int = 0
        var behind: Int = 0
        var files: [FileChange] = []
        var isLoading = false
        var error: String?
        /// Whether the current branch tracks an upstream (drives Publish visibility).
        var hasUpstream: Bool = false
    }

    private(set) var state = State()
    private let repo: RepoManager

    /// Resolves the active repo's auth backend + token. Set by the view
    /// (which owns AppConfig) so this service stays config-agnostic. Returns
    /// nil when the repo has no saved credentials.
    var resolveCredentials: ((URL) -> (token: String, backend: RepoManager.Backend)?)?

    /// True while a remote/branch operation is in flight (drives UI disabling).
    private(set) var isBusy = false

    /// Bumped on every completed refresh. Views key branch-list reloads off
    /// this so external/terminal branch changes (and deletes that don't move
    /// HEAD) are reflected, not just current-branch changes.
    private(set) var refreshTick = 0

    /// Designated initialiser for injection (tests, previews, etc.)
    init(repo: RepoManager) { self.repo = repo }

    /// No-arg initialiser for SwiftUI `@State`. Both this class and RepoManager
    /// are @MainActor so this init is also @MainActor-isolated; calling it from
    /// a @MainActor context (SwiftUI view, another @MainActor type) is safe.
    convenience init() { self.init(repo: RepoManager()) }

    var stagedFiles: [FileChange]   { state.files.filter { $0.staged } }
    var unstagedFiles: [FileChange] { state.files.filter { !$0.staged } }

    /// Refresh status + branch info for `root`. nil root → cleared state.
    func refresh(root: URL?) async {
        guard let root, isGitRepo(root) else { state = State(); return }
        state.isLoading = true; state.error = nil
        defer { state.isLoading = false; refreshTick &+= 1 }
        // Retroactively self-ignore generated artifact dirs so their contents
        // stop flooding status (fixes already-generated trees without regen).
        ensureGeneratedIgnores(root)
        do {
            let porcelain = try await repo.runGit(
                ["status", "--porcelain=v1", "--untracked-files=all"], at: root)
            state.files = StatusParser.parse(porcelain: porcelain)
            state.branch = try? await repo.runGit(
                ["rev-parse", "--abbrev-ref", "HEAD"], at: root)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            // Upstream tracking: resolves only when the branch has one (best-effort).
            let upstream = try? await repo.runGit(
                ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], at: root)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            state.hasUpstream = !(upstream?.isEmpty ?? true)
            // ahead/behind vs upstream (best-effort; no upstream → 0/0)
            if let counts = try? await repo.runGit(
                ["rev-list", "--count", "--left-right", "@{u}...HEAD"], at: root) {
                let nums = counts.split(whereSeparator: { $0 == "\t" || $0 == " " })
                    .compactMap { Int($0) }
                if nums.count == 2 { state.behind = nums[0]; state.ahead = nums[1] }
                else { state.ahead = 0; state.behind = 0 }
            } else { state.ahead = 0; state.behind = 0 }
        } catch {
            state.error = error.localizedDescription
        }
    }

    func diff(root: URL, file: FileChange) async -> [DiffHunk] {
        if file.status == .untracked {
            let url = root.appendingPathComponent(file.path)
            guard let content = try? String(contentsOf: url, encoding: .utf8) else { return [] }
            let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            // Drop a trailing empty element from a final newline so we don't show a phantom row.
            let trimmed = (lines.last == "" ? Array(lines.dropLast()) : lines)
            let rows = trimmed.enumerated().map { i, text in
                DiffRow(kind: .insert, oldLine: nil, newLine: i + 1, text: text)
            }
            guard !rows.isEmpty else { return [] }
            return [DiffHunk(header: "@@ -0,0 +1,\(rows.count) @@", rows: rows)]
        }
        let args = file.staged ? ["diff", "--cached", "--", file.path] : ["diff", "--", file.path]
        guard let raw = try? await repo.runGit(args, at: root) else { return [] }
        return UnifiedDiffParser.parse(raw)
    }

    func stage(root: URL, path: String) async { await run(["add", "--", path], root) }
    func unstage(root: URL, path: String) async { await run(["restore", "--staged", "--", path], root) }

    /// Stage everything (`git add -A`), then refresh. Cursor-style "Stage All".
    func stageAll(root: URL) async { await run(["add", "-A"], root) }

    /// Discard working-tree changes. Untracked files are deleted; tracked files
    /// are restored. Caller must confirm — this is destructive.
    func discard(root: URL, file: FileChange) async {
        if file.status == .untracked {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(file.path))
        } else {
            await run(["restore", "--", file.path], root)
        }
        await refresh(root: root)
    }

    /// Commit-all-aware (Cursor-style): if nothing is staged but there ARE
    /// changes, stage everything (`git add -A`) first, then commit; otherwise
    /// commit what's already staged. Refresh afterwards either way.
    func commit(root: URL, message: String) async {
        do {
            if stagedFiles.isEmpty && !state.files.isEmpty {
                _ = try await repo.runGit(["add", "-A"], at: root)
            }
            try await repo.commit(at: root, message: message)
        }
        catch { state.error = error.localizedDescription }
        await refresh(root: root)
    }

    // MARK: - Remote operations

    /// Pull (--ff-only) from origin using the repo's saved credentials.
    func pull(root: URL) async {
        guard let c = resolveCredentials?(root), !c.token.isEmpty else {
            state.error = "No credentials configured for this repo."; return
        }
        isBusy = true; defer { isBusy = false }
        do { try await repo.pull(at: root, token: c.token, backend: c.backend) }
        catch { state.error = error.localizedDescription }
        await refresh(root: root)
    }

    /// Push the current branch (with upstream tracking) to origin.
    func push(root: URL) async {
        guard let c = resolveCredentials?(root), !c.token.isEmpty else {
            state.error = "No credentials configured for this repo."; return
        }
        guard let branch = state.branch else { state.error = "No branch to push."; return }
        isBusy = true; defer { isBusy = false }
        do { try await repo.push(at: root, branch: branch, token: c.token, backend: c.backend) }
        catch { state.error = error.localizedDescription }
        await refresh(root: root)
    }

    /// Fetch from origin (no merge), then refresh status / ahead-behind.
    func sync(root: URL) async {
        guard let c = resolveCredentials?(root), !c.token.isEmpty else {
            state.error = "No credentials configured for this repo."; return
        }
        isBusy = true; defer { isBusy = false }
        do { try await repo.fetch(at: root, token: c.token, backend: c.backend) }
        catch { state.error = error.localizedDescription }
        await refresh(root: root)
    }

    // MARK: - Branch operations

    /// Local branch names (no leading marker), via `git branch --format`.
    func listBranches(root: URL) async -> [String] {
        guard let out = try? await repo.runGit(
            ["branch", "--format=%(refname:short)"], at: root) else { return [] }
        return out.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Check out an existing local branch, then refresh.
    func checkout(root: URL, branch: String) async {
        isBusy = true; defer { isBusy = false }
        do { _ = try await repo.runGit(["checkout", branch], at: root) }
        catch { state.error = error.localizedDescription }
        await refresh(root: root)
    }

    /// Create a new branch off HEAD and switch to it, then refresh.
    func createBranch(root: URL, name: String) async {
        await run(["checkout", "-b", name], root)
    }

    /// Delete a local branch (safe `-d` by default; `-D` when forced), then refresh.
    func deleteBranch(root: URL, name: String, force: Bool = false) async {
        await run(["branch", force ? "-D" : "-d", name], root)
    }

    /// Publish the current branch to origin, setting upstream tracking.
    /// Reuses the same credential resolution as `push()`.
    func publish(root: URL) async {
        guard let c = resolveCredentials?(root), !c.token.isEmpty else {
            state.error = "No credentials configured for this repo."; return
        }
        guard let branch = state.branch else { state.error = "No branch to publish."; return }
        isBusy = true; defer { isBusy = false }
        do { try await repo.push(at: root, branch: branch, token: c.token, backend: c.backend) }
        catch { state.error = error.localizedDescription }
        await refresh(root: root)
    }

    private func run(_ args: [String], _ root: URL) async {
        do { _ = try await repo.runGit(args, at: root); await refresh(root: root) }
        catch { state.error = error.localizedDescription }
    }

    private func isGitRepo(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.appendingPathComponent(".git").path)
    }

    /// For each known generated-artifact dir (`.code-notes`, `.understand-anything`),
    /// if the dir exists but has no `.gitignore`, drop in a self-ignoring `*`
    /// marker so git stops listing its contents regardless of the repo's root
    /// .gitignore. Best-effort: never fails the refresh.
    private func ensureGeneratedIgnores(_ root: URL) {
        let fm = FileManager.default
        for dir in [".code-notes", ".understand-anything"] {
            let dirURL = root.appendingPathComponent(dir, isDirectory: true)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dirURL.path, isDirectory: &isDir), isDir.boolValue else { continue }
            let ignoreURL = dirURL.appendingPathComponent(".gitignore")
            if !fm.fileExists(atPath: ignoreURL.path) {
                try? "*\n".write(to: ignoreURL, atomically: true, encoding: .utf8)
            }
        }
    }
}
