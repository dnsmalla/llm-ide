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
    private nonisolated static func authEnv(token: String, backend: Backend) -> [String: String] {
        let header: String
        switch backend {
        case .gitlab:
            // GitLab accepts the PRIVATE-TOKEN header for HTTPS git ops.
            header = "PRIVATE-TOKEN: \(token)"
        case .github:
            // GitHub uses HTTP Basic with x-access-token as the username.
            let basic = Data("x-access-token:\(token)".utf8).base64EncodedString()
            header = "Authorization: Basic \(basic)"
        }
        return [
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": header,
            // Never let git launch an interactive credential prompt; fail fast.
            "GIT_TERMINAL_PROMPT": "0",
        ]
    }

    /// Redact a secret from text before it is surfaced in an error/log.
    /// `nonisolated` because it's pure string work and is called from the
    /// background git queue (outside the main actor).
    private nonisolated static func redact(_ text: String, token: String?) -> String {
        guard let token, !token.isEmpty else { return text }
        let basic = Data("x-access-token:\(token)".utf8).base64EncodedString()
        return text
            .replacingOccurrences(of: token, with: "***")
            .replacingOccurrences(of: basic, with: "***")
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

    /// Run git. When `token` is supplied, credentials are injected via the
    /// process environment (see `authEnv`) and redacted from any error text.
    @discardableResult
    private func git(_ args: [String], cwd: URL, token: String? = nil, backend: Backend = .gitlab, timeout: TimeInterval? = nil) async throws -> (String, String) {
        // Network subcommands (clone/fetch/pull/push) can take a while on
        // large repos; local plumbing should always be quick. Cap accordingly
        // so a hung git can never leak the continuation forever.
        let networkVerbs: Set<String> = ["clone", "fetch", "pull", "push"]
        let cap = timeout ?? (networkVerbs.contains(args.first ?? "") ? 120 : 30)

        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/git")
                proc.arguments = args
                proc.currentDirectoryURL = cwd

                // Inherit the parent environment (git needs PATH/HOME) and
                // layer credential config on top when authenticating.
                if let token, !token.isEmpty {
                    var env = ProcessInfo.processInfo.environment
                    for (k, v) in Self.authEnv(token: token, backend: backend) { env[k] = v }
                    proc.environment = env
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

                do {
                    try proc.run()
                } catch {
                    finish(.failure(RepoError.commandFailed(Self.redact(error.localizedDescription, token: token))))
                    return
                }

                // Watchdog: terminate a hung git so the continuation can't leak.
                // SIGTERM closes the write ends, so the concurrent reads above
                // unblock and waitUntilExit() returns.
                let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
                timer.schedule(deadline: .now() + cap)
                timer.setEventHandler {
                    if proc.isRunning {
                        proc.terminate()
                        finish(.failure(RepoError.commandFailed("git \(args.first ?? "command") timed out after \(Int(cap))s")))
                    }
                }
                timer.resume()

                proc.waitUntilExit()
                readGroup.wait()
                timer.cancel()

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
