import Foundation
import os.log

/// Errors thrown by RepoManager operations.
enum RepoError: LocalizedError {
    case gitNotFound
    case cloneFailed(String)
    case commandFailed(String)
    case notARepo(URL)
    case dirtyWorkingTree

    var errorDescription: String? {
        switch self {
        case .gitNotFound:             return "git not found — install Xcode Command Line Tools."
        case .cloneFailed(let msg):    return "Clone failed: \(msg)"
        case .commandFailed(let msg):  return msg
        case .notARepo(let url):       return "\(url.path) is not a git repository."
        case .dirtyWorkingTree:        return "Working tree has uncommitted changes."
        }
    }
}

/// Thin wrapper around the `git` CLI for local repository operations.
/// All methods are `async throws` and run on a background thread via `Task.detached`.
@MainActor
final class RepoManager {
    private let log = Logger(subsystem: "com.llmide.macapp", category: "RepoManager")

    /// Which provider we're authenticating against — drives the auth
    /// strategy used by `configureTokenAuth` and `embedToken`. GitLab
    /// accepts the `PRIVATE-TOKEN` header; GitHub doesn't and needs
    /// the credential embedded in the remote URL as `x-access-token`.
    /// Defaults to .gitlab so the existing call sites keep working
    /// without per-call updates.
    enum Backend {
        case gitlab
        case github
    }

    // MARK: - Clone

    /// Clone `remoteURL` into `destination`. The token is supplied to git
    /// via per-command environment (never embedded in the URL/argv and
    /// never persisted), so the stored `origin` remains credential-free.
    /// Returns the detected default branch.
    func clone(remoteURL: String, to destination: URL, token: String, backend: Backend = .gitlab) async throws -> String {
        let parent = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)

        // Clone with a clean URL; auth travels in the process environment.
        // `--` terminates option parsing so a remoteURL beginning with `-`
        // can't be interpreted as a git flag (arg-injection guard).
        _ = try await git(["clone", "--depth", "1", "--", remoteURL, destination.path],
                          cwd: parent, token: token, backend: backend)
        log.info("repo_cloned path=\(destination.path, privacy: .public)")

        // Detect default branch from HEAD symbolic ref.
        let branch = (try? await gitOutput(["symbolic-ref", "--short", "HEAD"], cwd: destination)) ?? "main"
        return branch.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Pull

    func pull(at repoURL: URL, token: String, backend: Backend = .gitlab, remote: String = "origin") async throws {
        // Defensively strip any credentials a previous app version may have
        // baked into the origin URL, then authenticate via the environment.
        try await stripRemoteCredentials(at: repoURL, remote: remote)
        _ = try await git(["pull", "--ff-only", remote], cwd: repoURL, token: token, backend: backend)
        log.info("repo_pulled path=\(repoURL.path, privacy: .public)")
    }

    // MARK: - Fetch

    func fetch(at repoURL: URL, token: String, backend: Backend = .gitlab, remote: String = "origin") async throws {
        // Defensively strip any baked-in credentials, then authenticate via env.
        try await stripRemoteCredentials(at: repoURL, remote: remote)
        _ = try await git(["fetch", remote], cwd: repoURL, token: token, backend: backend)
        log.info("repo_fetched path=\(repoURL.path, privacy: .public)")
    }

    // MARK: - Branch operations

    func createAndCheckout(branch: String, at repoURL: URL, from base: String) async throws {
        _ = try await git(["fetch", "origin", base], cwd: repoURL)
        _ = try await git(["checkout", "-b", branch, "origin/\(base)"], cwd: repoURL)
        log.info("branch_created branch=\(branch, privacy: .public)")
    }

    /// Switch to an existing branch (local or remote). Used when the
    /// remote branch already exists — e.g. when re-running the
    /// workflow for the same issue. Fetches the remote ref first so a
    /// fresh checkout tracks the latest tip.
    func checkoutExisting(branch: String, at repoURL: URL) async throws {
        _ = try await git(["fetch", "origin", branch], cwd: repoURL)
        // If the local branch already exists, just switch to it.
        // Otherwise create a tracking branch from origin.
        let (localList, _) = try await git(
            ["branch", "--list", branch], cwd: repoURL)
        if localList.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            _ = try await git(["checkout", "-b", branch, "origin/\(branch)"], cwd: repoURL)
        } else {
            _ = try await git(["checkout", branch], cwd: repoURL)
        }
        log.info("branch_reused branch=\(branch, privacy: .public)")
    }

    // MARK: - Status / diff

    /// Returns unified diff of staged + unstaged changes.
    func diff(at repoURL: URL) async throws -> String {
        let staged = (try? await gitOutput(["diff", "--cached"], cwd: repoURL)) ?? ""
        let unstaged = (try? await gitOutput(["diff"], cwd: repoURL)) ?? ""
        return (staged + unstaged).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Commit & push

    func stageAll(at repoURL: URL) async throws {
        _ = try await git(["add", "-A"], cwd: repoURL)
    }

    func commit(at repoURL: URL, message: String) async throws {
        _ = try await git(["commit", "-m", message], cwd: repoURL)
        log.info("committed message=\(message, privacy: .public)")
    }

    func push(at repoURL: URL, branch: String, token: String, backend: Backend = .gitlab, remote: String = "origin") async throws {
        try await stripRemoteCredentials(at: repoURL, remote: remote)
        _ = try await git(["push", "--set-upstream", remote, branch], cwd: repoURL, token: token, backend: backend)
        log.info("pushed branch=\(branch, privacy: .public)")
    }

    // MARK: - File helpers

    /// Write content to a file inside the repo, creating intermediate directories.
    func write(content: String, to relativePath: String, in repoURL: URL) throws {
        let fileURL = repoURL.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try content.write(to: fileURL, atomically: true, encoding: .utf8)
    }

    // MARK: - Agent git-op

    static let defaultBranchNames: Set<String> = ["main", "master"]

    /// Current branch name, or "" if detached/unknown.
    func currentBranch(at repoURL: URL) async throws -> String {
        let (out, _) = try await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd: repoURL)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func agentBranchName(from slug: String?) -> String {
        let base = (slug ?? "change").lowercased()
            .replacingOccurrences(of: "[^a-z0-9-]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return "agent/\(base.isEmpty ? "change" : base)"
    }

    /// A user-supplied git ref/branch must not look like a flag or contain
    /// whitespace. We do NOT use `--` to guard these: for checkout/diff/reset/log
    /// `--` switches git to pathspec mode and would reinterpret the ref as a file
    /// path. Rejecting flag-like values is the correct guard for a ref/branch.
    private func safeRef(_ s: String) throws -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.hasPrefix("-"),
              t.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
            throw RepoError.commandFailed("invalid git ref/branch: \(s)")
        }
        return t
    }

    /// The repo's default branch: whichever of main/master exists, preferring main.
    private func resolveDefaultBranch(at repoURL: URL) async throws -> String {
        for name in ["main", "master"] {
            if (try? await git(["rev-parse", "--verify", "--quiet", name], cwd: repoURL)) != nil {
                return name
            }
        }
        return "main"
    }

    /// Execute an allow-listed git op on `repoURL`, enforcing branch-first /
    /// protected-main. Returns combined output text. Throws on git failure or a
    /// policy violation (which the caller surfaces to the agent).
    func runGitOp(_ a: GitOpArgs, at repoURL: URL, token: String? = nil) async throws -> String {
        // Confirm it's a git repo (clean error if not).
        _ = try await git(["rev-parse", "--is-inside-work-tree"], cwd: repoURL)
        let branch = try await currentBranch(at: repoURL)
        let onDefault = Self.defaultBranchNames.contains(branch)
        // Detached HEAD: `git rev-parse --abbrev-ref HEAD` returns "HEAD". A
        // commit here would be orphaned and a push would use "HEAD" as a
        // refspec — so treat it like "not on a usable branch" for mutations
        // (commit auto-branches; push/pull/merge refuse). Reads are unaffected.
        let detached = branch == "HEAD" || branch.isEmpty

        func run(_ argv: [String], tok: String? = nil) async throws -> String {
            let (out, err) = try await git(argv, cwd: repoURL, token: tok)
            return [out, err].filter { !$0.isEmpty }.joined(separator: "\n")
        }

        switch a.op {
        // ---- read (no policy) ----
        // -uall lists every untracked file individually (default -unormal
        // collapses an untracked dir to one entry) so the agent's report
        // matches the file-level view the IDE git panel shows.
        case .status:  return try await run(["status", "--short", "--branch", "-uall"])
        case .log:
            let r = try safeRef(a.ref ?? "HEAD")
            return try await run(["log", "--oneline", "-n", "20", r])
        case .diff:
            if let ref = a.ref { return try await run(["diff", "--stat", try safeRef(ref)]) }
            return try await run(["diff", "--stat"])
        case .branch:  return try await run(["branch", "--all"])

        // ---- safe-write ----
        case .add:     return try await run(["add", "-A"])
        case .create_branch:
            let name = try (a.branch.map { try safeRef($0) }) ?? agentBranchName(from: a.slug)
            return try await run(["checkout", "-b", name])
        case .checkout:
            guard let b = a.branch else { throw RepoError.commandFailed("checkout needs a branch") }
            return try await run(["checkout", try safeRef(b)])
        case .commit:
            guard let msg = a.message, !msg.isEmpty else { throw RepoError.commandFailed("commit needs a message") }
            // BRANCH-FIRST: never commit on the default branch (or detached
            // HEAD) — make a feature branch first.
            if onDefault || detached {
                let name = agentBranchName(from: a.slug)
                _ = try await run(["checkout", "-b", name])
            }
            _ = try await run(["add", "-A"])
            return try await run(["commit", "-m", msg])
        case .pull_ff:
            guard !detached else { throw RepoError.commandFailed("Can't pull in a detached HEAD — checkout a branch first.") }
            return try await run(["pull", "--ff-only", "origin", branch], tok: token)
        case .push:
            // PROTECTED MAIN: only ever push the CURRENT non-default branch;
            // never the default branch and never a detached HEAD.
            if onDefault || detached {
                throw RepoError.commandFailed("Refusing to push: not on a feature branch (current: \(branch)). I work on a feature branch; use merge_to_main to land changes.")
            }
            return try await run(["push", "--set-upstream", "origin", branch], tok: token)

        // ---- destructive ----
        case .merge:
            guard let src = a.branch else { throw RepoError.commandFailed("merge needs a source branch") }
            if onDefault || detached {
                throw RepoError.commandFailed("Refusing to merge into the default branch (or a detached HEAD) directly. Use merge_to_main for that explicit step.")
            }
            return try await run(["merge", "--no-ff", try safeRef(src)])
        case .revert:
            return try await run(["revert", "--no-edit", try safeRef(a.ref ?? "HEAD")])
        case .reset:
            let mode = a.mode ?? "mixed"
            guard ["soft", "mixed", "hard"].contains(mode) else {
                throw RepoError.commandFailed("reset mode must be soft, mixed, or hard")
            }
            return try await run(["reset", "--\(mode)", try safeRef(a.ref ?? "HEAD")])
        case .stash:
            return try await run(["stash", "push", "-u"])
        case .clean:
            return try await run(["clean", "-fd"])   // NOT -x; never nukes ignored files without explicit intent
        case .clone:
            guard let url = a.ref else { throw RepoError.commandFailed("clone needs a repository URL") }
            return try await run(["clone", url, repoURL.path])
        case .merge_to_main:
            // The ONLY op allowed to reach origin/<default>. Caller (sheet) has
            // confirmed at destructive tier.
            guard let src = a.branch, !Self.defaultBranchNames.contains(src) else {
                throw RepoError.commandFailed("merge_to_main needs a non-default source branch")
            }
            let safeSrc = try safeRef(src)
            let target = try await resolveDefaultBranch(at: repoURL)
            _ = try await run(["checkout", target])
            do {
                _ = try await run(["merge", "--ff-only", safeSrc])
            } catch {
                // A non-fast-forward (default branch moved) leaves us checked
                // out on the default branch — return to the original branch so
                // a later commit can't accidentally land on the default.
                _ = try? await run(["checkout", branch])
                throw error
            }
            return try await run(["push", "origin", target], tok: token)
        }
    }

    // MARK: - Private helpers

    /// If a previous app version baked credentials into the `origin` URL
    /// (`https://user:token@host/…`), rewrite it to a clean, credential-free
    /// URL. This scrubs leaked secrets out of `.git/config` on disk.
    private func stripRemoteCredentials(at repoURL: URL, remote: String) async throws {
        guard let current = try? await gitOutput(["remote", "get-url", remote], cwd: repoURL) else { return }
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              components.user != nil || components.password != nil else { return }
        components.user = nil
        components.password = nil
        if let clean = components.string, clean != trimmed {
            _ = try? await git(["remote", "set-url", remote, clean], cwd: repoURL)
        }
    }

    /// Build the per-command environment that carries git credentials via
    /// `GIT_CONFIG_*` keys. These are applied like `-c http.extraHeader=…`
    /// but live ONLY in the child process environment — never in argv
    /// (invisible to `ps`) and never written to `.git/config`.
    // Pure helper — builds a credential env dict from inputs, no main-actor state,
    // so callable off the main actor (it runs during background process setup).
    /// The `http.extraHeader` credential pair for a backend, as a config pair
    /// rather than a whole environment.
    ///
    /// It used to return the finished env including `GIT_CONFIG_COUNT=1`, which
    /// made it impossible to add any OTHER git config without silently clobbering
    /// the count (git reads exactly COUNT pairs, so a second writer either loses
    /// its own pair or hides the credential header). `gitEnv` below owns the
    /// numbering now, so config can be composed.
    nonisolated static func authConfigPair(token: String, backend: Backend) -> (String, String) {
        switch backend {
        case .gitlab:
            // GitLab accepts the PRIVATE-TOKEN header for HTTPS git ops.
            return ("http.extraHeader", "PRIVATE-TOKEN: \(token)")
        case .github:
            // GitHub uses HTTP Basic with x-access-token as the username.
            let basic = Data("x-access-token:\(token)".utf8).base64EncodedString()
            return ("http.extraHeader", "Authorization: Basic \(basic)")
        }
    }

    /// Environment for a git subprocess: the parent environment plus prompt
    /// suppression, a transfer-stall guard, and (when authenticating) the
    /// credential header — with `GIT_CONFIG_COUNT` numbered correctly across all
    /// of them.
    ///
    /// `http.lowSpeedLimit` / `http.lowSpeedTime` are the important part now that
    /// git has no wall-clock cap. They are a STALL detector, not a deadline: git
    /// aborts only if throughput stays under ~1 KB/s for 5 minutes, so a slow but
    /// progressing clone of a huge repo runs as long as it needs, while a dead
    /// remote (the case the old 120 s cap really guarded) fails with a real error
    /// instead of wedging the auto-task pipeline forever. `GIT_TERMINAL_PROMPT=0`
    /// covers the other hang: waiting on credentials nobody can type.
    nonisolated static func gitEnv(token: String?, backend: Backend) -> [String: String] {
        var pairs: [(String, String)] = [
            ("http.lowSpeedLimit", "1000"),   // bytes/sec
            ("http.lowSpeedTime", "300"),     // sustained for 5 min → abort
        ]
        if let token, !token.isEmpty {
            pairs.append(authConfigPair(token: token, backend: backend))
        }
        var env = ProcessInfo.processInfo.environment
        // Never let git launch an interactive credential prompt; fail fast. Set
        // unconditionally — it used to arrive only with a token, so an
        // unauthenticated op against a private remote could sit waiting forever.
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GIT_CONFIG_COUNT"] = String(pairs.count)
        for (i, pair) in pairs.enumerated() {
            env["GIT_CONFIG_KEY_\(i)"] = pair.0
            env["GIT_CONFIG_VALUE_\(i)"] = pair.1
        }
        return env
    }

    /// Redact a secret from text before it is surfaced in an error/log.
    /// `nonisolated` because it's pure string work and is called from the
    /// background git queue (outside the main actor).
    private nonisolated static func redact(_ text: String, token: String?) -> String {
        var out = text
        if let token, !token.isEmpty {
            let basic = Data("x-access-token:\(token)".utf8).base64EncodedString()
            out = out
                .replacingOccurrences(of: token, with: "***")
                .replacingOccurrences(of: basic, with: "***")
        }
        // Defense-in-depth: scrub any *other* recognized credential shape git or
        // a remote echoed back (a token we never held), mirroring the
        // extension's shared redaction pattern set.
        return SecretRedactor.redact(out)
    }

    private func gitOutput(_ args: [String], cwd: URL) async throws -> String {
        let (out, _) = try await git(args, cwd: cwd)
        return out
    }

    /// Public entry point for local, non-authenticated git commands (status,
    /// diff, add, restore, commit). Reuses the same hardened Process runner
    /// (timeouts, deadlock-safe pipe drain). Returns stdout; throws on non-zero.
    func runGit(_ args: [String], at cwd: URL) async throws -> String {
        try await gitOutput(args, cwd: cwd)
    }

    /// Same as `runGit(_:at:)`, but pipes `stdin` to the child process before
    /// reading its output — needed for `git apply --cached -` (hunk staging,
    /// see `GitTruthStore.stagePatch`). No existing call in this codebase
    /// piped data into a subprocess before this; every other `Process` here
    /// hardcodes `FileHandle.nullDevice`.
    func runGit(_ args: [String], at cwd: URL, stdin: Data) async throws -> String {
        let (out, _) = try await git(args, cwd: cwd, stdin: stdin)
        return out
    }

    /// Run git. When `token` is supplied, credentials are injected via the
    /// process environment (see `authEnv`) and redacted from any error text.
    @discardableResult
    private func git(_ args: [String], cwd: URL, token: String? = nil, backend: Backend = .gitlab, timeout: TimeInterval? = nil, stdin: Data? = nil) async throws -> (String, String) {
        // No wall clock unless the caller asks for one. The old caps (120 s for
        // clone/fetch/pull/push, 30 s for local plumbing) failed the operations
        // that need time most: cloning or fetching a large repo on an ordinary
        // connection routinely exceeds two minutes, and the user got
        // "git clone timed out after 120s" for a transfer that was progressing
        // fine. The hang these caps really guarded against — git waiting on an
        // interactive credential prompt — is now prevented at the source
        // (GIT_TERMINAL_PROMPT=0 plus a detached stdin, below), so the clock is
        // no longer the thing standing between a stuck git and a leaked
        // continuation.
        let cap = timeout ?? 0

        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                proc.arguments = args
                proc.currentDirectoryURL = cwd

                // Parent environment (git needs PATH/HOME) plus prompt
                // suppression, the transfer-stall guard, and credentials when
                // authenticating — see gitEnv. Detaching stdin closes the
                // credential-prompt hole from the other side.
                proc.environment = Self.gitEnv(token: token, backend: backend)
                let stdinPipe = Pipe()
                if stdin != nil {
                    proc.standardInput = stdinPipe
                } else {
                    proc.standardInput = FileHandle.nullDevice
                }

                let stdout = Pipe()
                let stderr = Pipe()
                proc.standardOutput = stdout
                proc.standardError = stderr

                // Resume the continuation exactly once — the timeout watchdog
                // and the normal exit path race, so guard with a lock.
                let lock = NSLock()
                var resumed = false
                func finish(_ result: Result<(String, String), Error>) {
                    lock.lock(); defer { lock.unlock() }
                    if resumed { return }
                    resumed = true
                    continuation.resume(with: result)
                }

                // Drain both pipes concurrently. With waitUntilExit() before
                // reading, a git that writes more than the ~64KB pipe buffer
                // (e.g. clone progress on stderr) blocks writing while we block
                // on exit — a classic deadlock. Reading both ends in parallel
                // lets git keep writing; reads hit EOF when the process exits
                // (or is terminated) and closes its write ends.
                var outData = Data()
                var errData = Data()
                let readGroup = DispatchGroup()
                readGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    outData = stdout.fileHandleForReading.readDataToEndOfFile()
                    readGroup.leave()
                }
                readGroup.enter()
                DispatchQueue.global(qos: .userInitiated).async {
                    errData = stderr.fileHandleForReading.readDataToEndOfFile()
                    readGroup.leave()
                }

                // Write stdin concurrently with the stdout/stderr drains,
                // all set up before proc.run() — exactly the same
                // deadlock-avoidance shape this function already uses for
                // reading (see the doc comment on the reads above): a
                // large patch could otherwise fill the stdin pipe buffer
                // while this thread is blocked writing it, with nothing
                // yet reading stdout to unblock the child.
                // A broken pipe is an ordinary outcome here — git rejecting a
                // malformed hunk and exiting early before reading all of
                // stdin — so this uses the throwing `write(contentsOf:)`,
                // not the legacy `write(_:)`, which raises an uncaught
                // exception on SIGPIPE and would crash the process.
                if let stdin {
                    readGroup.enter()
                    DispatchQueue.global(qos: .userInitiated).async {
                        try? stdinPipe.fileHandleForWriting.write(contentsOf: stdin)
                        try? stdinPipe.fileHandleForWriting.close()
                        readGroup.leave()
                    }
                }

                do {
                    try proc.run()
                } catch {
                    finish(.failure(RepoError.commandFailed(Self.redact(error.localizedDescription, token: token))))
                    return
                }

                // Optional watchdog, only when a caller passed an explicit
                // timeout (cap == 0 means unlimited). SIGTERM closes the write
                // ends, so the concurrent reads above unblock and
                // waitUntilExit() returns.
                var timer: DispatchSourceTimer?
                if cap > 0 {
                    let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
                    t.schedule(deadline: .now() + cap)
                    t.setEventHandler {
                        if proc.isRunning {
                            proc.terminate()
                            finish(.failure(RepoError.commandFailed("git \(args.first ?? "command") timed out after \(Int(cap))s")))
                        }
                    }
                    t.resume()
                    timer = t
                }
                // Unbounded runs are still bounded by the machine: the guard
                // terminates git if the system hits sustained memory pressure.
                // It only SIGTERMs — SIGTERM closes the write ends, the reads
                // above unblock, and waitUntilExit() below reports the non-zero
                // status through the normal failure path. Deliberately not
                // calling `finish` here: that local function captures mutable
                // state, so handing it to a @Sendable closure would be a Swift 6
                // data race, and routing through the existing exit path is both
                // safer and one less way to resume the continuation.
                let guardToken = ResourceGuardService.shared.register(
                    label: "git \(args.first ?? "command")"
                ) { _ in
                    if proc.isRunning { proc.terminate() }
                }
                defer { guardToken.cancel() }

                proc.waitUntilExit()
                readGroup.wait()
                timer?.cancel()

                let out = String(data: outData, encoding: .utf8) ?? ""
                let err = String(data: errData, encoding: .utf8) ?? ""
                if proc.terminationStatus == 0 {
                    finish(.success((out, err)))
                } else {
                    // If the watchdog already resumed with a timeout error,
                    // finish() is a no-op here.
                    let raw = err.isEmpty ? out : err
                    finish(.failure(RepoError.commandFailed(Self.redact(raw, token: token))))
                }
            }
        }
    }

    /// Generate a safe branch name from a title string.
    static func branchName(issueIid: Int, title: String) -> String {
        let slug = title
            .lowercased()
            .components(separatedBy: .alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .prefix(6)
            .joined(separator: "-")
        return "issue-\(issueIid)-\(slug)"
    }
}
