import Foundation
import os.log

/// Mirrors Settings → GitLab credentials into the `glab` CLI so terminal
/// agents never need a separate `glab auth login`. Settings / Keychain
/// remain the single source of truth; this is a best-effort push target.
enum GlabAuthSync {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "GlabAuthSync")

    static func sync(host: String, token: String) {
        guard Self.isSafeHost(host) else { return }
        guard let hostname = hostname(from: host) else { return }

        if token.isEmpty {
            logout(hostname: hostname)
            return
        }

        runGlab([
            "auth", "login",
            "--hostname", hostname,
            "--token", token,
            "--api-protocol", "https",
        ], successMessage: "Synced GitLab token to glab for \(hostname)")
    }

    private static func logout(hostname: String) {
        runGlab(["auth", "logout", "--hostname", hostname],
                successMessage: "Cleared glab credentials for \(hostname)")
    }

    private static func hostname(from host: String) -> String? {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let url = URL(string: trimmed), let h = url.host, !h.isEmpty { return h }
        return trimmed
    }

    /// Same allowlist as `GitLabClient.isSafeBaseURL` — duplicated here so
    /// background sync does not hop to the main actor.
    private static func isSafeHost(_ raw: String) -> Bool {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(), !host.isEmpty else { return false }
        if scheme == "https" { return true }
        if scheme == "http" {
            return host == "localhost" || host == "127.0.0.1" || host == "::1"
        }
        return false
    }

    private static func runGlab(_ args: [String], successMessage: String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["glab"] + args
        proc.standardInput = FileHandle.nullDevice
        let errPipe = Pipe()
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = errPipe

        do {
            try proc.run()
            proc.waitUntilExit()
            if proc.terminationStatus == 0 {
                log.info("\(successMessage, privacy: .public)")
            } else {
                let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(),
                                 encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                log.warning("glab \(args.first ?? "cmd", privacy: .public) exited \(proc.terminationStatus): \(err, privacy: .public)")
            }
        } catch {
            log.debug("glab unavailable for auth sync: \(error.localizedDescription, privacy: .public)")
        }
    }
}
