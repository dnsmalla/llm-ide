import Foundation

// "Ship" a set of edits that are sitting in a working tree: build ONE commit on
// top of the remote's default branch that contains exactly those files, push it
// to a new branch, and open a merge/pull request against the default branch.
// Nothing here ever pushes to, or merges into, the default branch — a human
// merges the request.
//
// The commit is built WITHOUT touching the user's checkout. A temporary index
// (`GIT_INDEX_FILE`) is filled from `origin/<default>` plus the working-tree
// content of the named paths, written out as a tree, committed with
// `commit-tree`, and pushed by sha. HEAD, the real index, the working tree and
// the local branches are never written. That is the whole point: the repair
// stays in the user's tree (so the next run does not repair it again, and the
// review screens still show it), their own staged and unstaged work is never
// swept into the commit, and a failure at any step cannot leave them on the
// wrong branch.
//
// Used by the Loop after a successful run that changed files. It lives in Core
// because the same sequence exists, privately, inside the Chat and Auto Task
// features, and a feature may not call another feature.

/// What to ship: edits already sitting in the working tree of `gitRoot`.
struct ShipRequest: Equatable {
    var gitRoot: URL
    /// Repo-relative paths, taken literally (no globbing). A rename lists both
    /// the old and the new path. ONLY these are committed.
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
    case permissions, remote, base, content, commit, push, mergeRequest
}

enum ShipOutcome: Equatable {
    /// The request is open on `branch` (a remote branch; no local one exists).
    case shipped(branch: String, mergeRequestURL: String, number: Int)
    /// Deliberately not shipped — a rule, not a fault (not allowed, a secret in
    /// the list, the branch differs from the remote's default, …).
    case skipped(reason: String)
    /// Something went wrong at `step`. The message says what state it left; the
    /// user's checkout is never part of that state, because it is never touched.
    case failed(step: ShipStep, message: String)

    /// One line for logs and the run journal.
    var summary: String {
        switch self {
        case .shipped(_, let url, let number):
            return "Opened merge request !\(number): \(url)"
        case .skipped(let reason):
            return "No merge request: \(reason)"
        case .failed(let step, let message):
            return "Merge request not created (\(step.rawValue)): \(message)"
        }
    }
}

@MainActor
protocol ChangeShipping {
    /// Preconditions: `request.gitRoot` is a git working tree and `request.paths`
    /// are modified in it.
    /// Postconditions: on `.shipped` one commit (parent: `origin/<default>`) holding
    /// exactly those paths' working-tree content was pushed to a new branch and a
    /// request is open. In EVERY outcome HEAD, the index, the working tree and the
    /// local branches are exactly as they were. Never touches the default branch.
    func ship(_ request: ShipRequest) async -> ShipOutcome
}

/// The git operations a shipment needs, behind a seam so the sequence can be
/// tested without a repository or a remote.
@MainActor
protocol ShipGitOperating {
    /// Runs `git <args>` in `root` with `environment` added to the process's.
    func git(_ args: [String], at root: URL, environment: [String: String]) async throws -> String
    /// Pushes the commit `sha` to `refs/heads/<branch>` on the remote.
    func pushCommit(sha: String, toBranch branch: String, at root: URL) async throws
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
    /// collide on the remote branch.
    static func branchName(prefix: String, at date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "\(prefix)-\(formatter.string(from: date))"
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

    // MARK: status

    struct StatusEntry: Equatable {
        var path: String
        /// The old name, for a rename or copy.
        var originalPath: String?
        var isUntracked: Bool

        /// Every path this entry touches (a rename touches both names).
        var allPaths: [String] { [path] + (originalPath.map { [$0] } ?? []) }
    }

    /// Entries of `git status --porcelain -z`. NUL-separated, so no path is quoted
    /// or escaped — a name with non-ASCII characters, spaces or quotes arrives
    /// exactly as it is on disk. A rename is `XY <new>\0<old>\0`.
    static func statusEntries(porcelainZ raw: String) -> [StatusEntry] {
        let tokens = raw.split(separator: "\0", omittingEmptySubsequences: true).map(String.init)
        var out: [StatusEntry] = []
        var index = 0
        while index < tokens.count {
            let token = tokens[index]
            index += 1
            guard token.count > 3 else { continue }
            let status = String(token.prefix(2))
            let path = String(token.dropFirst(3))
            var original: String?
            if status.contains("R") || status.contains("C"), index < tokens.count {
                original = tokens[index]
                index += 1
            }
            out.append(StatusEntry(path: path, originalPath: original, isUntracked: status == "??"))
        }
        return out
    }

    // MARK: secrets

    private static let secretNames: Set<String> = [
        ".env", ".npmrc", ".netrc", ".pgpass", "credentials.json", "secrets.json", "secrets.yaml",
        "secrets.yml", "secrets.toml", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "service-account.json",
    ]
    private static let secretSuffixes = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".secret"]
    private static let secretDirectories: Set<String> = [".aws", ".ssh", ".gnupg", ".docker", ".kube"]
    private static let templateSuffixes = [".example", ".sample", ".template", ".dist"]

    /// True for a path that looks like a credential or key. Such a file must not be
    /// put in a request even if a repair or a skill stage wrote it — the push
    /// cannot be taken back. Name-based on purpose: it is a floor under the
    /// protected-path rules, not a content scanner.
    static func isSecretPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/").map { String($0).lowercased() }
        guard let name = parts.last else { return false }
        if parts.dropLast().contains(where: { secretDirectories.contains($0) }) { return true }
        if templateSuffixes.contains(where: { name.hasSuffix($0) }) { return false }
        if secretNames.contains(name) || name.hasPrefix(".env.")
            || (name.hasPrefix("service-account") && name.hasSuffix(".json")) {
            return true
        }
        return secretSuffixes.contains { name.hasSuffix($0) }
    }

    static func secretPaths(in paths: [String]) -> [String] { paths.filter(isSecretPath) }

    // MARK: generated artifacts

    private static let artifactNames: Set<String> = [".coverage", "coverage.xml", ".DS_Store", "Thumbs.db", ".pytest_cache", "__pycache__", "htmlcov", "node_modules", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv"]

    /// True for a file a test run or an interpreter leaves behind (coverage data, byte-code,
    /// caches, a virtual environment). A repair that re-runs the tests rewrites these, and
    /// the scope guard attributes an untracked file it saw change — so they must be kept
    /// out of a request explicitly. Name-based, deliberately short: anything else a
    /// repair creates is shipped, because a new source file is a legitimate part of a fix.
    static func isGeneratedArtifact(_ path: String) -> Bool {
        let parts = path.split(separator: "/").map(String.init)
        guard let name = parts.last else { return false }
        if parts.contains(where: { artifactNames.contains($0) }) { return true }
        return name.hasSuffix(".pyc") || name.hasSuffix(".pyo") || name.hasSuffix(".log")
    }

    // MARK: remote

    /// `host/path` of a remote, lower-cased and without credentials, scheme, a
    /// trailing slash, `.git`, or the web-page suffix a pasted URL carries
    /// (`/-/…`, `/tree/…`, `/blob/…`, `/issues`, `/merge_requests`). Handles https,
    /// `ssh://` and the scp form (`git@host:a/b`, `host:a/b`). A bare `owner/name`
    /// (how a GitHub repo is often saved) has no host.
    struct RemoteKey: Equatable {
        var host: String?
        var path: String
    }

    private static let pageSegments: Set<String> = ["-", "tree", "blob", "issues", "merge_requests", "pulls", "pull", "commits", "wiki"]

    static func remoteKey(_ raw: String) -> RemoteKey? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !text.isEmpty else { return nil }
        var host: String?
        if let scheme = text.range(of: "://") {
            text = String(text[scheme.upperBound...])
            if let at = text.firstIndex(of: "@"), at < (text.firstIndex(of: "/") ?? text.endIndex) {
                text = String(text[text.index(after: at)...])
            }
            guard let slash = text.firstIndex(of: "/") else { return nil }
            host = String(text[..<slash])
            text = String(text[text.index(after: slash)...])
        } else if let colon = text.firstIndex(of: ":"),
                  colon < (text.firstIndex(of: "/") ?? text.endIndex) {
            // git@host:owner/name, or host:owner/name
            let beforeColon = String(text[..<colon])
            host = String(beforeColon.split(separator: "@").last ?? "")
            text = String(text[text.index(after: colon)...])
        }
        if let current = host, let port = current.firstIndex(of: ":") { host = String(current[..<port]) }
        // A pasted web-page URL carries a page suffix (`/-/tree/main`, `/issues`, …). Cut it
        // at the first marker SEGMENT after `group/project` — whole segments only, so a
        // project named `issues-tracker` or `pulls-api` is not mistaken for a page.
        var segments = text.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if let cut = segments.indices.first(where: { $0 >= 2 && pageSegments.contains(segments[$0]) }) {
            segments = Array(segments[..<cut])
        }
        text = segments.joined(separator: "/")
        if text.hasSuffix(".git") { text = String(text.dropLast(4)) }
        // `owner/name` at least: a single word (a numeric project id) names no project here.
        guard text.contains("/") else { return nil }
        return RemoteKey(host: host?.isEmpty == true ? nil : host, path: text)
    }

    /// Whether `origin` is the project the app saved: the PATH (`group/project`)
    /// must be the same. The host is deliberately not compared — an SSH alias
    /// (`github-work`) or an alternate SSH host (`ssh.github.com`) is the same
    /// server under another name, and the credential is already scoped to the
    /// token's own host by the push. What this guards is a FORK (a different owner).
    /// A saved value that names no `group/project` (a numeric id) cannot be compared,
    /// and is accepted.
    static func sameRemote(saved: String, origin: String) -> Bool {
        guard let wanted = remoteKey(saved) else { return true }
        guard let actual = remoteKey(origin) else { return false }
        return wanted.path == actual.path
    }
}

// MARK: - Executor

@MainActor
final class GitChangeShipper: ChangeShipping {
    private let git: ShipGitOperating
    private let backend: RepoBackend
    private let projectId: String
    private let defaultBranchHint: String?
    private let expectedRemote: String?
    private let isAllowed: (RepoOperation) -> Bool
    private let now: () -> Date
    private let temporaryDirectory: URL

    /// - Parameters:
    ///   - projectId: the backend-native project id the requests are opened in.
    ///   - defaultBranchHint: the default branch the app recorded when it cloned
    ///     the repo; used when git cannot say.
    ///   - expectedRemote: the project URL (or `owner/name`) the app saved. When
    ///     set, `origin` must be that project — otherwise the branch would be
    ///     pushed to a fork and the request opened somewhere it does not exist.
    ///   - isAllowed: the repo allow-list for this provider.
    init(git: ShipGitOperating, backend: RepoBackend, projectId: String,
         defaultBranchHint: String? = nil, expectedRemote: String? = nil,
         isAllowed: @escaping (RepoOperation) -> Bool,
         now: @escaping () -> Date = Date.init,
         temporaryDirectory: URL = FileManager.default.temporaryDirectory) {
        self.git = git
        self.backend = backend
        self.projectId = projectId
        self.defaultBranchHint = defaultBranchHint
        self.expectedRemote = expectedRemote
        self.isAllowed = isAllowed
        self.now = now
        self.temporaryDirectory = temporaryDirectory
    }

    /// Paths are file NAMES, not patterns: `t[1].py` must not also match `t1.py`.
    private let literal = ["GIT_LITERAL_PATHSPECS": "1"]

    private func run(_ args: [String], at root: URL, extra: [String: String] = [:]) async throws -> String {
        try await git.git(args, at: root, environment: literal.merging(extra) { _, new in new })
    }

    func ship(_ request: ShipRequest) async -> ShipOutcome {
        for operation in ShipPlanning.requiredOperations where !isAllowed(operation) {
            return .skipped(reason: "“\(operation.label)” is not allowed for this repo. Turn it on in the repo allow-list to open merge requests automatically.")
        }
        guard !request.paths.isEmpty else { return .skipped(reason: "nothing changed") }

        // A push cannot be taken back: never put a credential or key in one.
        let secrets = ShipPlanning.secretPaths(in: request.paths)
        if !secrets.isEmpty {
            return .skipped(reason: "\(secrets.prefix(3).joined(separator: ", ")) looks like a secret, so none of this run's changes were pushed — review them by hand")
        }

        let root = request.gitRoot

        // The branch must go to the project the request is opened in.
        if let expected = expectedRemote {
            let origin: String
            // The PUSH url: `pushurl` / `pushInsteadOf` can send a push somewhere the fetch url does not.
            do { origin = try await run(["remote", "get-url", "--push", "origin"], at: root).trimmingCharacters(in: .whitespacesAndNewlines) }
            catch { return .failed(step: .remote, message: "could not read the origin remote: \(error.localizedDescription)") }
            guard ShipPlanning.sameRemote(saved: expected, origin: origin) else {
                return .skipped(reason: "origin (\(origin)) is not the project this folder is saved as (\(expected)), so nothing was pushed")
            }
        }

        let target = await defaultBranch(at: root)
        let base: String
        do {
            base = try await run(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/\(target)^{commit}"], at: root)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return .skipped(reason: "there is no origin/\(target) here yet — fetch the repo in Source Control first")
        }

        // The request is "origin/<default> + these files", but the run was TESTED on
        // HEAD. Unless the two are the same tree, the request is not what was tested
        // (a repair that calls a helper from an unpushed commit would fail in CI),
        // and a shipped file would carry the branch's own differences along with it.
        let differing: String
        do { differing = try await run(["diff", "--name-only", base, "HEAD"], at: root) }
        catch { return .failed(step: .content, message: error.localizedDescription) }
        let drift = differing.split(separator: "\n").map(String.init)
        if !drift.isEmpty {
            return .skipped(reason: "your current checkout differs from origin/\(target) (\(drift.count) file\(drift.count == 1 ? "" : "s"): \(drift.prefix(3).joined(separator: ", "))), but the request is built on origin/\(target) — it would not be what the loop tested. Push or pull so they match, then run again")
        }

        // Build the tree in a THROWAWAY index: origin/<default>, plus the named paths
        // as they are in the working tree. The real index is never read or written.
        let indexFile = temporaryDirectory.appendingPathComponent("ship-\(UUID().uuidString).index")
        defer { try? FileManager.default.removeItem(at: indexFile) }
        let scratch = ["GIT_INDEX_FILE": indexFile.path]
        let sha: String
        do {
            _ = try await run(["read-tree", base], at: root, extra: scratch)
            _ = try await run(["add", "-A", "--"] + request.paths, at: root, extra: scratch)
            let tree = try await run(["write-tree"], at: root, extra: scratch).trimmingCharacters(in: .whitespacesAndNewlines)
            let baseTree = try await run(["rev-parse", "\(base)^{tree}"], at: root).trimmingCharacters(in: .whitespacesAndNewlines)
            guard tree != baseTree else {
                return .skipped(reason: "these files already match origin/\(target), so there is nothing to put in a request")
            }
            sha = try await run(["commit-tree", tree, "-p", base, "-m", request.commitMessage], at: root)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return .failed(step: .commit, message: error.localizedDescription)
        }

        let branch = ShipPlanning.branchName(prefix: request.branchPrefix, at: now())
        do { try await git.pushCommit(sha: sha, toBranch: branch, at: root) }
        catch {
            // A timeout can fire after the remote already took the ref, so do not claim otherwise.
            return .failed(step: .push, message: "\(error.localizedDescription). Your files and branches are untouched; a branch named \(branch) may exist on the remote.")
        }

        do {
            let created = try await backend.createMergeRequest(
                projectId: projectId,
                payload: RepoMergeRequestPayload(title: request.title, description: request.description,
                                                 sourceBranch: branch, targetBranch: target))
            return .shipped(branch: branch, mergeRequestURL: created.webUrl, number: created.number)
        } catch {
            return .failed(step: .mergeRequest, message: "\(error.localizedDescription). The branch \(branch) is pushed; open the request by hand. Your files and branches are untouched.")
        }
    }

    private func defaultBranch(at root: URL) async -> String {
        if let ref = try? await run(["symbolic-ref", "refs/remotes/origin/HEAD"], at: root),
           let name = ShipPlanning.defaultBranch(fromSymbolicRef: ref) { return name }
        if let hint = defaultBranchHint, !hint.isEmpty { return hint }
        return "main"
    }
}

// MARK: - Real git

/// `RepoManager` as the git seam: local commands through its hardened runner,
/// the push through its credential-scoped `pushCommit`.
@MainActor
struct RepoManagerShipGit: ShipGitOperating {
    let repo: RepoManager
    let token: String
    let backend: RepoManager.Backend

    func git(_ args: [String], at root: URL, environment: [String: String]) async throws -> String {
        try await repo.runGit(args, at: root, environment: environment)
    }

    func pushCommit(sha: String, toBranch branch: String, at root: URL) async throws {
        try await repo.pushCommit(at: root, sha: sha, toBranch: branch, token: token, backend: backend)
    }
}
