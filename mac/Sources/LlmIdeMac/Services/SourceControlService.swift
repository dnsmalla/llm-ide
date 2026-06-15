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
    }

    private(set) var state = State()
    private let repo: RepoManager

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
        defer { state.isLoading = false }
        do {
            let porcelain = try await repo.runGit(
                ["status", "--porcelain=v1", "--untracked-files=all"], at: root)
            state.files = StatusParser.parse(porcelain: porcelain)
            state.branch = try? await repo.runGit(
                ["rev-parse", "--abbrev-ref", "HEAD"], at: root)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            // ahead/behind vs upstream (best-effort; no upstream → 0/0)
            if let counts = try? await repo.runGit(
                ["rev-list", "--count", "--left-right", "@{u}...HEAD"], at: root) {
                let nums = counts.split(whereSeparator: { $0 == "\t" || $0 == " " })
                    .compactMap { Int($0) }
                if nums.count == 2 { state.behind = nums[0]; state.ahead = nums[1] }
            } else { state.ahead = 0; state.behind = 0 }
        } catch {
            state.error = error.localizedDescription
        }
    }

    func diff(root: URL, path: String, staged: Bool) async -> [DiffHunk] {
        let args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path]
        guard let raw = try? await repo.runGit(args, at: root) else { return [] }
        return UnifiedDiffParser.parse(raw)
    }

    func stage(root: URL, path: String) async { await run(["add", "--", path], root) }
    func unstage(root: URL, path: String) async { await run(["restore", "--staged", "--", path], root) }

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

    func commit(root: URL, message: String) async {
        do { try await repo.commit(at: root, message: message) }
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
}
