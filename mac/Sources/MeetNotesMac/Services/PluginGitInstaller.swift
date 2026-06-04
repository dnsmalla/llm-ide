import Foundation
import os.log

/// Clones a public Git URL (GitHub, GitLab, …) into a temp dir, zips
/// it, and hands the bytes to the existing `installPlugin(zipURL:)`
/// pipeline so the server-side install/validate/move path is reused
/// unchanged. Doing the clone client-side preserves the server's
/// "no URL fetching" SSRF posture — explicitly documented in
/// `extension/plugins/installer.mjs` and worth keeping.
enum PluginGitInstaller {
    private static let log = Logger(subsystem: "com.meetnotes.macapp", category: "PluginGitInstaller")

    /// What went wrong, in user-facing language. The caller surfaces
    /// `localizedDescription`; we never throw cryptic git/zip errors
    /// at the user.
    enum InstallError: LocalizedError {
        case invalidURL
        case unsupportedScheme(String)
        case cloneFailed(String)
        case zipFailed(String)
        case noGitCLI

        var errorDescription: String? {
            switch self {
            case .invalidURL: return "That doesn't look like a valid Git URL."
            case .unsupportedScheme(let s):
                return "URL scheme '\(s)' not supported. Use https:// or git@."
            case .cloneFailed(let msg): return "Clone failed: \(msg)"
            case .zipFailed(let msg):   return "Could not package the cloned repo: \(msg)"
            case .noGitCLI:             return "Git is not installed or not on PATH."
            }
        }
    }

    /// Result of a successful clone-and-zip — the file at `zipURL`
    /// is the caller's responsibility to delete (or leave for the OS
    /// to clean up; it lives under `/tmp` already).
    struct StagedPackage {
        let zipURL: URL
        let cleanup: () -> Void
    }

    /// Normalize and validate a user-pasted URL. Accepts common
    /// shapes:
    ///   - https://github.com/owner/repo
    ///   - https://github.com/owner/repo.git
    ///   - https://gitlab.com/owner/repo
    ///   - git@github.com:owner/repo.git
    /// Anything else (file://, ssh:// to a random host, javascript:,
    /// etc.) gets rejected before we touch the shell.
    static func normalize(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw InstallError.invalidURL }

        // Allow git@host:owner/repo shorthand verbatim.
        if trimmed.hasPrefix("git@") {
            guard trimmed.contains(":") else { throw InstallError.invalidURL }
            return trimmed
        }

        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else {
            throw InstallError.invalidURL
        }
        guard scheme == "https" || scheme == "http" else {
            throw InstallError.unsupportedScheme(scheme)
        }
        guard let host = url.host?.lowercased(), !host.isEmpty else {
            throw InstallError.invalidURL
        }
        // Block obviously local hosts to keep things sane.
        if host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local") {
            throw InstallError.unsupportedScheme("local hosts not supported")
        }
        return trimmed
    }

    /// Clone shallowly, zip, return the zip URL. `ref` optional —
    /// branch or tag, default branch when nil.
    static func cloneAndZip(url rawURL: String, ref: String? = nil) async throws -> StagedPackage {
        let normalizedURL = try normalize(rawURL)

        let stage = try makeTempDir(prefix: "meetnotes-plugin-git-")
        let clonedDir = stage.appendingPathComponent("repo", isDirectory: true)
        let zipURL    = stage.appendingPathComponent("plugin.zip")

        // Shallow clone — we don't need history for installing.
        var args = ["clone", "--depth", "1", "--single-branch"]
        if let ref, !ref.isEmpty { args += ["--branch", ref] }
        // `--` terminates option parsing — a URL starting with `-` can't be
        // smuggled in as a git flag (arg-injection guard).
        args += ["--", normalizedURL, clonedDir.path]

        let cloneRes = try await runProcess("/usr/bin/git", args: args, timeoutSec: 60)
        guard cloneRes.code == 0 else {
            // Strip the temp path from stderr so we don't leak it.
            let stderr = cloneRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            log.error("git clone failed: \(stderr, privacy: .public)")
            throw InstallError.cloneFailed(stderr.isEmpty ? "git exited \(cloneRes.code)" : stderr)
        }

        // Drop .git so the zip stays small and reproducible. Failure
        // here is non-fatal — the resulting zip would just be larger.
        try? FileManager.default.removeItem(at: clonedDir.appendingPathComponent(".git"))

        // Zip the cloned dir's contents (not the wrapping dir itself —
        // the installer accepts plugin.json at the zip root OR inside
        // a single subdir, so either shape works). Using -r with cd
        // into clonedDir gives us a clean zip without the parent path.
        let zipRes = try await runProcess(
            "/usr/bin/zip",
            args: ["-rq", zipURL.path, "."],
            cwd: clonedDir,
            timeoutSec: 30
        )
        guard zipRes.code == 0 else {
            let stderr = zipRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            log.error("zip failed: \(stderr, privacy: .public)")
            throw InstallError.zipFailed(stderr.isEmpty ? "zip exited \(zipRes.code)" : stderr)
        }

        let cleanup: () -> Void = {
            try? FileManager.default.removeItem(at: stage)
        }
        return StagedPackage(zipURL: zipURL, cleanup: cleanup)
    }

    // MARK: - Internals

    private static func makeTempDir(prefix: String) throws -> URL {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    private struct ProcessResult {
        let code: Int32
        let stdout: String
        let stderr: String
    }

    /// Run a subprocess with a hard wall-clock timeout. On timeout the
    /// process is terminated and we return code = -1 with stderr =
    /// "timeout".  Errors that mean "couldn't even spawn" surface as
    /// InstallError.noGitCLI for git, generic .cloneFailed otherwise.
    private static func runProcess(_ launchPath: String, args: [String], cwd: URL? = nil, timeoutSec: TimeInterval) async throws -> ProcessResult {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<ProcessResult, Error>) in
            let proc = Process()
            proc.launchPath = launchPath
            proc.arguments = args
            if let cwd { proc.currentDirectoryURL = cwd }
            let outPipe = Pipe()
            let errPipe = Pipe()
            proc.standardOutput = outPipe
            proc.standardError  = errPipe

            let timeoutItem = DispatchWorkItem {
                if proc.isRunning { proc.terminate() }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeoutSec, execute: timeoutItem)

            do {
                try proc.run()
            } catch {
                timeoutItem.cancel()
                if launchPath.hasSuffix("/git") {
                    cont.resume(throwing: InstallError.noGitCLI)
                } else {
                    cont.resume(throwing: InstallError.cloneFailed(error.localizedDescription))
                }
                return
            }

            // Drain both pipes concurrently. Reading them only after exit (the
            // old terminationHandler approach) deadlocks when a clone writes more
            // than the ~64KB pipe buffer to stderr — git blocks on write and never
            // exits. The background reads hit EOF when the process closes the pipes.
            final class OutBox: @unchecked Sendable { var s = "" }
            let outBox = OutBox(), errBox = OutBox()
            let group = DispatchGroup()
            let rq = DispatchQueue.global(qos: .utility)
            group.enter(); rq.async {
                outBox.s = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                group.leave()
            }
            group.enter(); rq.async {
                errBox.s = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                group.leave()
            }
            group.notify(queue: rq) {
                timeoutItem.cancel()
                cont.resume(returning: ProcessResult(code: proc.terminationStatus, stdout: outBox.s, stderr: errBox.s))
            }
        }
    }
}

extension MeetNotesAPIClient {
    /// Convenience: clone a public Git URL → zip → upload through the
    /// existing install endpoint. Caller surfaces the install result
    /// the same way as the .zip-upload path.
    func installPluginFromGit(url: String, ref: String? = nil, replace: Bool = false) async throws -> PluginInstallResponse {
        let staged = try await PluginGitInstaller.cloneAndZip(url: url, ref: ref)
        defer { staged.cleanup() }
        return try await installPlugin(zipURL: staged.zipURL, replace: replace)
    }
}
