import Foundation

/// Puts a repo on the server's per-user repo allow-list (`POST /auth/me/repos`).
///
/// `POST /kb/loop/agent-run` refuses a `repoRoot` outside that list (400
/// `REPO_ROOT_NOT_ALLOWED`); a Loop worktree is accepted only as a linked
/// worktree of a listed repo. The Loop registers the run's MAIN git root once
/// per run, before its first agent call, so a project the app never indexed
/// (or a repo opened some other way) still works. Registration is idempotent
/// on the server.
protocol LoopRepoRegistering: AnyObject {
    func register(repoRoot: URL) async throws
}

/// Production `LoopRepoRegistering` — the same call `AppShell` makes for the
/// active project.
final class APILoopRepoRegistrar: LoopRepoRegistering {
    private let api: LlmIdeAPIClient

    init(api: LlmIdeAPIClient) {
        self.api = api
    }

    func register(repoRoot: URL) async throws {
        _ = try await api.addUserRepo(path: repoRoot.standardizedFileURL.path)
    }
}

/// The registration rule shared by the Loop and the Auto Task sweep guard.
enum LoopRepoRoot {

    /// A root so broad that allow-listing it would let an agent roam most of
    /// the disk (`/`, the home folder, `/Users`, `/etc`, …). Mirrors the
    /// server's `isTooBroadRoot` (`extension/core/broad-root.mjs`).
    static func isTooBroad(_ url: URL, home: String = NSHomeDirectory()) -> Bool {
        func canon(_ p: String) -> String { URL(fileURLWithPath: p).resolvingSymlinksInPath().path }
        let path = canon(url.path)
        let homePath = canon(home)
        if path == "/" || path.lowercased() == homePath.lowercased() { return true }
        let segs = path.split(separator: "/").map(String.init)
        if segs.count <= 1 { return true }
        let top = "/" + segs[0]
        let system = ["/etc", "/usr", "/var", "/bin", "/sbin", "/System", "/Library", "/private", "/opt"]
        return system.contains(top) && segs.count <= 2
    }

    struct TooBroadError: LocalizedError, Equatable {
        let path: String
        var errorDescription: String? {
            "repo root \(path) is too broad for a Loop agent (e.g. your home folder)"
        }
    }

    /// Registers `root` unless it is too broad (then throws `TooBroadError`
    /// without contacting the server).
    static func register(_ registrar: LoopRepoRegistering, root: URL) async throws {
        guard !isTooBroad(root) else { throw TooBroadError(path: root.standardizedFileURL.path) }
        try await registrar.register(repoRoot: root)
    }
}
