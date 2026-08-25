import Foundation

/// Isolated git worktrees for concurrent Loop runs on the same linked repo.
///
/// When enabled on a loop config, a run that would wait in `LoopRunQueue` on
/// the main working tree is redirected into `<project>/system/loop-worktrees/<id>`
/// instead, so repairs never race in one checkout.
@MainActor
enum LoopWorktreeManager {

    struct Lease: Equatable, Sendable {
        let mainRepo: URL
        let worktreePath: URL
        let branch: String
        let baseCommit: String
    }

    enum Error: Swift.Error, Equatable {
        case notAGitRepository
        case worktreePathExists
        case gitFailed(String)
    }

    private static var activeByMainRepo: [String: Int] = [:]

    /// Runs currently executing in a worktree for `mainRepo` (not queued on main).
    static func activeWorktreeRunCount(mainRepo: URL) -> Int {
        activeByMainRepo[mainRepo.resolvingSymlinksInPath().path] ?? 0
    }

    /// Best-effort worktree creation. Returns `nil` when git refuses (dirty tree,
    /// missing git, etc.) so the caller can fall back to the FIFO queue.
    static func createIfPossible(mainRepo: URL, faultsRoot: URL,
                                 runGit: ([String], URL) async throws -> String = defaultRunGit) async -> Lease? {
        do {
            return try await create(mainRepo: mainRepo, faultsRoot: faultsRoot, runGit: runGit)
        } catch {
            return nil
        }
    }

    static func create(mainRepo: URL, faultsRoot: URL,
                       runGit: ([String], URL) async throws -> String = defaultRunGit) async throws -> Lease {
        _ = try await runGit(["rev-parse", "--is-inside-work-tree"], mainRepo)
        let baseCommit = try await runGit(["rev-parse", "HEAD"], mainRepo)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        let runId = UUID().uuidString.prefix(8).lowercased()
        let branch = "llmide/loop/\(runId)"
        let parent = worktreeParent(mainRepo: mainRepo, faultsRoot: faultsRoot)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let path = parent.appendingPathComponent(String(runId), isDirectory: true)
        guard !FileManager.default.fileExists(atPath: path.path) else {
            throw Error.worktreePathExists
        }

        do {
            _ = try await runGit(["worktree", "add", "-b", branch, path.path, "HEAD"], mainRepo)
        } catch {
            try? FileManager.default.removeItem(at: path)
            throw Error.gitFailed(error.localizedDescription)
        }

        let mainKey = mainRepo.resolvingSymlinksInPath().path
        activeByMainRepo[mainKey, default: 0] += 1
        return Lease(mainRepo: mainRepo, worktreePath: path, branch: branch,
                     baseCommit: baseCommit)
    }

    /// Finish a worktree run without discarding its output.
    ///
    /// An unchanged worktree is removed. A dirty worktree OR one whose branch
    /// advanced is retained for review. Git/status failures also retain it:
    /// cleanup must fail safe because deleting a Loop's repairs is worse than
    /// leaving an extra checkout on disk.
    static func finish(_ lease: Lease,
                       runGit: ([String], URL) async throws -> String = defaultRunGit) async {
        decrementActive(mainRepo: lease.mainRepo)
        guard FileManager.default.fileExists(atPath: lease.worktreePath.path) else { return }

        guard let status = try? await runGit(["status", "--porcelain"], lease.worktreePath),
              let head = try? await runGit(["rev-parse", "HEAD"], lease.worktreePath),
              status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              head.trimmingCharacters(in: .whitespacesAndNewlines) == lease.baseCommit else {
            return
        }

        _ = try? await runGit(["worktree", "remove", "--force", lease.worktreePath.path],
                               lease.mainRepo)
        _ = try? await runGit(["branch", "-D", lease.branch], lease.mainRepo)
    }

    /// Keep worktrees outside the checked-out repo. In the common split layout,
    /// `<project>/system` is already outside `gitRoot` and is easy to discover.
    /// When the project root IS the repo, use a sibling directory so `git
    /// worktree add` never creates a nested checkout inside the main checkout.
    private static func worktreeParent(mainRepo: URL, faultsRoot: URL) -> URL {
        let mainPath = mainRepo.resolvingSymlinksInPath().standardizedFileURL.path
        let faultsPath = faultsRoot.resolvingSymlinksInPath().standardizedFileURL.path
        let faultsInsideMain = faultsPath == mainPath || faultsPath.hasPrefix(mainPath + "/")
        if faultsInsideMain {
            return mainRepo.deletingLastPathComponent()
                .appendingPathComponent(".llmide-loop-worktrees", isDirectory: true)
                .appendingPathComponent(mainRepo.lastPathComponent, isDirectory: true)
        }
        return faultsRoot.appendingPathComponent("system/loop-worktrees", isDirectory: true)
    }

    private static func decrementActive(mainRepo: URL) {
        let key = mainRepo.resolvingSymlinksInPath().path
        guard let count = activeByMainRepo[key] else { return }
        if count <= 1 {
            activeByMainRepo.removeValue(forKey: key)
        } else {
            activeByMainRepo[key] = count - 1
        }
    }

    private static func defaultRunGit(_ args: [String], at cwd: URL) async throws -> String {
        try await RepoManager().runGit(args, at: cwd)
    }

#if DEBUG
    static func _resetForTesting() {
        activeByMainRepo.removeAll()
    }
#endif
}
