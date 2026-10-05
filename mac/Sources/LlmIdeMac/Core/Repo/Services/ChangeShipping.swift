import Foundation

// "Ship" a set of edits that are already in a working tree: put them on a NEW
// branch, commit exactly those files, push the branch and open a merge/pull
// request against the default branch. Nothing here ever pushes to, or merges
// into, the default branch — a human merges the request.
//
// Used by the Loop after a successful run that changed files. It lives in Core
// because the same sequence exists, privately, inside the Chat and Auto Task
// features, and a feature may not call another feature.

/// What to ship: edits already sitting in the working tree of `gitRoot`.
struct ShipRequest: Equatable {
    var gitRoot: URL
    /// Repo-relative paths. ONLY these are committed — anything else the user
    /// has modified or staged is left exactly as it was.
    var paths: [String]
    /// The branch is `<branchPrefix>-<timestamp>`: every shipment gets its own
    /// branch and its own request, whether or not an earlier one is still open.
    var branchPrefix: String
    var commitMessage: String
    var title: String
    var description: String
}

/// The step a shipment stopped at, for the message the user reads.
enum ShipStep: String, Equatable {
    case permissions, repository, gitState, branch, commit, push, mergeRequest
}

enum ShipOutcome: Equatable {
    /// The request is open. `leftOnBranch` is true when switching back to the
    /// branch the user was on failed, so the tree is still on the new branch.
    case shipped(branch: String, mergeRequestURL: String, number: Int, leftOnBranch: Bool)
    /// Deliberately not shipped — a rule, not a fault (not allowed, nothing to
    /// ship, a merge or cherry-pick in progress).
    case skipped(reason: String)
    /// Something went wrong at `step`. The message says what state it left.
    case failed(step: ShipStep, message: String)

    /// One line for logs and the run journal.
    var summary: String {
        switch self {
        case .shipped(_, let url, let number, let left):
            return "Opened merge request !\(number): \(url)" + (left ? " (the working tree was left on the new branch)" : "")
        case .skipped(let reason):
            return "No merge request: \(reason)"
        case .failed(let step, let message):
            return "Merge request not created (\(step.rawValue)): \(message)"
        }
    }
}

@MainActor
protocol ChangeShipping {
    /// Preconditions: `request.gitRoot` is a git working tree whose current
    /// branch is a named branch, and `request.paths` are modified in it.
    /// Postconditions: on `.shipped` the paths are committed on a new branch that
    /// was pushed, and a request is open; the original branch is checked out again
    /// (unless `leftOnBranch`). On `.skipped` / `.failed` no request was created;
    /// `.failed` at `.push` or later leaves the commit on the local new branch.
    /// An earlier request that is still open does not matter: each shipment is
    /// its own branch and request. Never touches the default branch.
    func ship(_ request: ShipRequest) async -> ShipOutcome
}

/// The git operations a shipment needs, behind a seam so the sequence can be
/// tested without a repository or a remote.
@MainActor
protocol ShipGitOperating {
    func git(_ args: [String], at root: URL) async throws -> String
    func currentBranch(at root: URL) async throws -> String
    func push(branch: String, at root: URL) async throws
}

// MARK: - Planning (pure)

/// The decisions a shipment makes, separated from the I/O so they are testable.
enum ShipPlanning {
    /// `loop/<slug>` — lower-case, only `[a-z0-9-]`, never empty.
    static func branchPrefix(for name: String, namespace: String = "loop") -> String {
        let slug = name.lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return "\(namespace)/\(slug.isEmpty ? "run" : String(slug.prefix(40)))"
    }

    /// `<prefix>-yyyyMMdd-HHmmss` (UTC, so the name does not depend on the locale
    /// or time zone). Seconds are in it because two runs in one minute must not
    /// collide on `git switch -c`.
    static func branchName(prefix: String, at date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "\(prefix)-\(formatter.string(from: date))"
    }

    /// Paths from `git status --porcelain` that are untracked (`??`) — they need
    /// `git add` before a pathspec can name them.
    static func untrackedPaths(porcelain: String, among paths: [String]) -> [String] {
        let wanted = Set(paths)
        var out: [String] = []
        for line in porcelain.split(separator: "\n") where line.hasPrefix("?? ") {
            var path = String(line.dropFirst(3))
            if path.hasPrefix("\"") && path.hasSuffix("\"") && path.count >= 2 {
                path = String(path.dropFirst().dropLast())
            }
            if wanted.contains(path) { out.append(path) }
        }
        return out
    }

    /// The default branch from `git symbolic-ref refs/remotes/origin/HEAD`
    /// ("refs/remotes/origin/main" → "main"); nil when it does not say.
    static func defaultBranch(fromSymbolicRef ref: String) -> String? {
        let trimmed = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("refs/remotes/origin/") else { return nil }
        let name = String(trimmed.dropFirst("refs/remotes/origin/".count))
        return name.isEmpty ? nil : name
    }

    /// Operations the user must have allowed (the repo allow-list) before anything
    /// leaves the machine. The same list the manual buttons obey.
    static let requiredOperations: [RepoOperation] = [.createBranch, .autoCommit, .push, .createPR]
}

// MARK: - Executor

@MainActor
final class GitChangeShipper: ChangeShipping {
    private let git: ShipGitOperating
    private let backend: RepoBackend
    private let projectId: String
    private let defaultBranchHint: String?
    private let isAllowed: (RepoOperation) -> Bool
    private let now: () -> Date

    /// - Parameters:
    ///   - projectId: the backend-native project id the requests are opened in.
    ///   - defaultBranchHint: the default branch the app recorded when it cloned
    ///     the repo; used when git cannot say.
    ///   - isAllowed: the repo allow-list for this provider.
    init(git: ShipGitOperating, backend: RepoBackend, projectId: String,
         defaultBranchHint: String? = nil,
         isAllowed: @escaping (RepoOperation) -> Bool,
         now: @escaping () -> Date = Date.init) {
        self.git = git
        self.backend = backend
        self.projectId = projectId
        self.defaultBranchHint = defaultBranchHint
        self.isAllowed = isAllowed
        self.now = now
    }

    func ship(_ request: ShipRequest) async -> ShipOutcome {
        for operation in ShipPlanning.requiredOperations where !isAllowed(operation) {
            return .skipped(reason: "“\(operation.label)” is not allowed for this repo. Turn it on in the repo allow-list to open merge requests automatically.")
        }
        guard !request.paths.isEmpty else { return .skipped(reason: "nothing changed") }

        let root = request.gitRoot
        // A pathspec commit is refused mid-merge and mid-cherry-pick; say so
        // instead of forwarding git's message.
        for marker in ["MERGE_HEAD", "CHERRY_PICK_HEAD"] {
            if (try? await git.git(["rev-parse", "-q", "--verify", marker], at: root)) != nil {
                return .skipped(reason: "the repo has a \(marker == "MERGE_HEAD" ? "merge" : "cherry-pick") in progress")
            }
        }
        let original: String
        do { original = try await git.currentBranch(at: root) }
        catch { return .failed(step: .gitState, message: error.localizedDescription) }
        guard !original.isEmpty, original != "HEAD" else {
            return .skipped(reason: "the repo is on a detached HEAD, so there is no branch to return to")
        }

        let target = await defaultBranch(at: root)

        let branch = ShipPlanning.branchName(prefix: request.branchPrefix, at: now())
        do { _ = try await git.git(["switch", "-c", branch], at: root) }
        catch { return .failed(step: .branch, message: error.localizedDescription) }

        // From here a failure must put the user back on their branch.
        var untracked: [String] = []
        do {
            let porcelain = try await git.git(["status", "--porcelain", "--"] + request.paths, at: root)
            untracked = ShipPlanning.untrackedPaths(porcelain: porcelain, among: request.paths)
            if !untracked.isEmpty { _ = try await git.git(["add", "--"] + untracked, at: root) }
            _ = try await git.git(["commit", "-m", request.commitMessage, "--"] + request.paths, at: root)
        } catch {
            if !untracked.isEmpty { _ = try? await git.git(["restore", "--staged", "--"] + untracked, at: root) }
            _ = try? await git.git(["switch", original], at: root)
            _ = try? await git.git(["branch", "-D", branch], at: root)   // nothing was committed on it
            return .failed(step: .commit, message: error.localizedDescription)
        }

        do { try await git.push(branch: branch, at: root) }
        catch {
            let back = await switchBack(to: original, at: root)
            return .failed(step: .push, message: "\(error.localizedDescription). The fix is committed on the local branch \(branch)\(back ? "" : " (the working tree is still on it)").")
        }

        let created: RepoMergeRequest
        do {
            created = try await backend.createMergeRequest(
                projectId: projectId,
                payload: RepoMergeRequestPayload(title: request.title, description: request.description,
                                                 sourceBranch: branch, targetBranch: target))
        } catch {
            let back = await switchBack(to: original, at: root)
            return .failed(step: .mergeRequest, message: "\(error.localizedDescription). The branch \(branch) is pushed; open the request by hand\(back ? "" : " (the working tree is still on it)").")
        }

        let back = await switchBack(to: original, at: root)
        return .shipped(branch: branch, mergeRequestURL: created.webUrl, number: created.number, leftOnBranch: !back)
    }

    private func switchBack(to branch: String, at root: URL) async -> Bool {
        (try? await git.git(["switch", branch], at: root)) != nil
    }

    private func defaultBranch(at root: URL) async -> String {
        if let ref = try? await git.git(["symbolic-ref", "refs/remotes/origin/HEAD"], at: root),
           let name = ShipPlanning.defaultBranch(fromSymbolicRef: ref) { return name }
        if let hint = defaultBranchHint, !hint.isEmpty { return hint }
        return "main"
    }
}

// MARK: - Real git

/// `RepoManager` as the git seam: local commands through its hardened runner,
/// the push through its credential-scoped `push`.
@MainActor
struct RepoManagerShipGit: ShipGitOperating {
    let repo: RepoManager
    let token: String
    let backend: RepoManager.Backend

    func git(_ args: [String], at root: URL) async throws -> String {
        try await repo.runGit(args, at: root)
    }

    func currentBranch(at root: URL) async throws -> String {
        try await repo.currentBranch(at: root)
    }

    func push(branch: String, at root: URL) async throws {
        try await repo.push(at: root, branch: branch, token: token, backend: backend)
    }
}
