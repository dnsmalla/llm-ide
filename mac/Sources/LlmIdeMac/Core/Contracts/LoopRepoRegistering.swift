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
