import Foundation

/// Isolated git worktrees for concurrent Loop runs on the same linked repo.
///
/// When enabled on a loop config, a run that would wait in `LoopRunQueue` on
/// the main working tree is redirected into a managed worktree instead, so
/// repairs never race in one checkout.
@MainActor
public enum LoopWorktreeManager {

    public struct Lease: Equatable, Sendable {
        public let mainRepo: URL
        public let worktreePath: URL
        public let branch: String
        public let baseCommit: String
    }

    public enum Error: Swift.Error, Equatable {
        case notAGitRepository
        case dirtyWorkingTree
        case worktreePathExists
        case gitFailed(String)
    }

    private static var activeByMainRepo: [String: Int] = [:]
    /// Standardised paths of worktrees a live lease owns (created, not yet
    /// finished) — what `pruneStale` must never touch.
    private static var liveLeasePaths: Set<String> = []

    private static func key(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Runs currently executing in a worktree for `mainRepo` (not queued on main).
    static func activeWorktreeRunCount(mainRepo: URL) -> Int {
        activeByMainRepo[mainRepo.resolvingSymlinksInPath().path] ?? 0
    }

    /// Best-effort worktree creation. Returns `nil` when git refuses (dirty tree,
    /// missing git, etc.) so the caller can fall back to the FIFO queue.
    ///
    /// - Parameter runGit: `nil` (the default) resolves to `defaultRunGit` at
    ///   the call site inside this function's body, not as a function-reference
    ///   default argument value. A `@MainActor` static async function used
    ///   directly as a default argument of type `([String], URL) async throws
    ///   -> String` miscompiled into a non-isolated thunk that crashed every
    ///   run with `swift_task_dealloc: freed pointer was not the last
    ///   allocation` (reproduced via `lldb`, Swift 5 language mode on a
    ///   Swift 6 toolchain) — this resolve-in-body form sidesteps that thunk
    ///   entirely.
    static func createIfPossible(mainRepo: URL, faultsRoot: URL, requireCleanMain: Bool = true,
                                 runGit: (([String], URL) async throws -> String)? = nil) async -> Lease? {
        do {
            return try await create(mainRepo: mainRepo, faultsRoot: faultsRoot,
                                    requireCleanMain: requireCleanMain, runGit: runGit)
        } catch {
            return nil
        }
    }

    /// - Parameter requireCleanMain: When `false`, a worktree is still cut from
    ///   `HEAD` (never from the dirty working tree's uncommitted content) even
    ///   though the main checkout has local changes. Used by loops that must
    ///   never edit the main checkout and must never refuse one just because
    ///   it is dirty — see `LoopEngineConfig.alwaysUseWorktree`.
    /// - Parameter runGit: see `createIfPossible`'s note on why this resolves
    ///   `defaultRunGit` inside the body rather than as a default argument value.
    public static func create(mainRepo: URL, faultsRoot: URL, requireCleanMain: Bool = true,
                       runGit: (([String], URL) async throws -> String)? = nil) async throws -> Lease {
        let runGit = runGit ?? { try await defaultRunGit($0, at: $1) }
        _ = try await runGit(["rev-parse", "--is-inside-work-tree"], mainRepo)
        if requireCleanMain {
            let status = try await runGit(["status", "--porcelain"], mainRepo)
            guard status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw Error.dirtyWorkingTree
            }
        }
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

        // Claimed BEFORE git creates it so a concurrent `pruneStale` cannot
        // mistake the half-made checkout for a leftover.
        liveLeasePaths.insert(key(path))
        do {
            _ = try await runGit(["worktree", "add", "-b", branch, path.path, "HEAD"], mainRepo)
        } catch {
            liveLeasePaths.remove(key(path))
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
    /// - Parameter runGit: resolved in the body — see `createIfPossible`.
    /// - Returns: a message naming the worktree and branch when it was RETAINED
    ///   (dirty, advanced, or unreadable), so the caller can tell the user where
    ///   the work is; nil when it was removed or already gone.
    @discardableResult
    static func finish(_ lease: Lease,
                       runGit: (([String], URL) async throws -> String)? = nil) async -> String? {
        let runGit = runGit ?? { try await defaultRunGit($0, at: $1) }
        decrementActive(mainRepo: lease.mainRepo)
        liveLeasePaths.remove(key(lease.worktreePath))
        guard FileManager.default.fileExists(atPath: lease.worktreePath.path) else { return nil }

        guard let status = try? await runGit(["status", "--porcelain"], lease.worktreePath),
              let head = try? await runGit(["rev-parse", "HEAD"], lease.worktreePath),
              status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              head.trimmingCharacters(in: .whitespacesAndNewlines) == lease.baseCommit else {
            return "the run changed code in an isolated checkout, kept for review: "
                + "\(lease.worktreePath.path) (branch \(lease.branch))"
        }

        _ = try? await runGit(["worktree", "remove", "--force", lease.worktreePath.path],
                               lease.mainRepo)
        _ = try? await runGit(["branch", "-D", lease.branch], lease.mainRepo)
        return nil
    }

    /// Run-start hygiene: `git worktree prune`, then remove loop worktree
    /// directories that no live lease owns (leftovers of a quit or crash, since
    /// the cleanup in a run's `defer` never runs then). A leftover is removed
    /// only when it is provably disposable: clean, and its HEAD already
    /// contained in the main repo's HEAD. A dirty or divergent one is kept —
    /// deleting a Loop's repairs is worse than a stray checkout. Returns one
    /// human-readable line per removal or keep, for the run log.
    @discardableResult
    static func pruneStale(mainRepo: URL, faultsRoot: URL,
                           runGit: (([String], URL) async throws -> String)? = nil) async -> [String] {
        let runGit = runGit ?? { try await defaultRunGit($0, at: $1) }
        let parent = worktreeParent(mainRepo: mainRepo, faultsRoot: faultsRoot)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: parent.path) else {
            return []
        }
        var notes: [String] = []
        _ = try? await runGit(["worktree", "prune"], mainRepo)
        for name in names.sorted() {
            let dir = parent.appendingPathComponent(name, isDirectory: true)
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue,
                  FileManager.default.fileExists(atPath: dir.appendingPathComponent(".git").path),
                  !liveLeasePaths.contains(key(dir)) else { continue }
            guard let status = try? await runGit(["status", "--porcelain"], dir),
                  status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                notes.append("kept leftover worktree \(name) (uncommitted changes or unreadable)")
                continue
            }
            guard let head = try? await runGit(["rev-parse", "HEAD"], dir)
                    .trimmingCharacters(in: .whitespacesAndNewlines), !head.isEmpty,
                  (try? await runGit(["merge-base", "--is-ancestor", head, "HEAD"], mainRepo)) != nil else {
                notes.append("kept leftover worktree \(name) (has commits not in the main checkout)")
                continue
            }
            _ = try? await runGit(["worktree", "remove", "--force", dir.path], mainRepo)
            _ = try? await runGit(["branch", "-D", "llmide/loop/\(name)"], mainRepo)
            if FileManager.default.fileExists(atPath: dir.path) {
                notes.append("could not remove leftover worktree \(name)")
            } else {
                notes.append("removed leftover worktree \(name)")
            }
        }
        return notes
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
        liveLeasePaths.removeAll()
    }
#endif
}
