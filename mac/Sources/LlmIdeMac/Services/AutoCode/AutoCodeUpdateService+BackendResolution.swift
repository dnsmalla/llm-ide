import Foundation

// Split out of AutoCodeUpdateService.swift (which had grown to the largest
// file in the app) — the private implementation details of backend/repo
// resolution. `ResolvedRepo`, `resolveBackendAndProject()`, and
// `hasResolvableBackend` stay in the main file (they're the small,
// entry-point surface everything else calls); this file holds what those
// two entry points delegate to. Widened from `private` to internal
// (default) since both entry points, plus AutoCodeUpdateService+PipelineTasks.swift's
// runSourcesToIssue/runImplementIssues (which call fetchAllIssues), live in
// different files now — see the access-control note at the top of
// AutoCodeUpdateService.swift.
extension AutoCodeUpdateService {

    /// Pure resolution attempt, no side effects — the single source of
    /// truth shared by `resolveBackendAndProject()` (which additionally
    /// records a diagnosis on failure, for real task-run error
    /// messages) and `hasResolvableBackend` (which must not).
    func attemptResolveBackendAndProject() -> ResolvedRepo? {
        // Test override: inject a stub backend for tests
        if let backend = backendOverride {
            return resolveWithBackend(backend)
        }

        // Active project's linkedRepo is authoritative when set
        if let active = projectStore?.activeProject,
           let linked = active.bundle.settings.linkedRepo {
            return resolveLinkedRepo(active, linked: linked)
        }

        // Legacy fallback: the active CLONED saved repo, GitLab first then
        // GitHub. Restores behavior lost when this method was extracted
        // during the utilities-centralization pass (the docstring above
        // still describes this step; the code silently stopped doing it) —
        // without it, a project with no linkedRepo reports "no usable
        // backend" even when an active cloned repo exists.
        let guardedGitLab = RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
        if let resolved = resolveWithBackend(guardedGitLab) { return resolved }
        let guardedGitHub = RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
        return resolveWithBackend(guardedGitHub)
    }

    func resolveWithBackend(_ backend: RepoBackend) -> ResolvedRepo? {
        switch backend.kind {
        case .gitlab:
            guard let p = config.gitLabSavedProjects.first(where: { $0.isActive }),
                  let id = p.resolvedId,
                  let local = p.localPath, !local.isEmpty else { return nil }
            return .init(client: backend, projectId: String(id),
                         gitRoot: local,
                         projectRoot: projectStore?.activeProject?.localPath ?? local)
        case .github:
            guard let r = config.gitHubSavedRepos.first(where: { $0.isActive }),
                  let (owner, name) = GitHubClient.ownerAndName(from: r.url),
                  let local = r.localPath, !local.isEmpty else { return nil }
            return .init(client: backend, projectId: "\(owner)/\(name)",
                         gitRoot: local,
                         projectRoot: projectStore?.activeProject?.localPath ?? local)
        }
    }

    func resolveLinkedRepo(_ active: ProjectStore.ActiveProject, linked: ProjectSettings.LinkedRepo) -> ResolvedRepo? {
        let projectRoot = active.localPath
        let kind = linked.kind
        let token = kind == .gitlab ? config.gitLabToken : config.gitHubToken
        let tokenName = kind == .gitlab ? "GitLab" : "GitHub"

        guard !token.isEmpty else {
            // No @Published write here — this can run from a SwiftUI view
            // body via hasResolvableBackend. resolveBackendAndProject()'s
            // caller records the diagnosis uniformly (resolveDiagnosis()
            // already reports token state), so real task-run failures
            // still get a diagnosis; the view path stays side-effect-free.
            log.warning("Active project linkedRepo is \(tokenName) but token is empty — skipping run")
            return nil
        }

        let client = backendOverride ?? RepoBackendFactory.guarded(
            kind == .gitlab ? GitLabClient(config: config) : GitHubClient(config: config),
            config: config
        )
        // gitRoot: the bound saved repo's clone path when one exists — the
        // app clones into `<project>/code/<repo>`, so the git working tree
        // lives there, not at the project root. Falls back to the project
        // root for the "project-is-a-repo" / "opened the clone as its own
        // project" cases where there is no saved-repo entry.
        let gitRoot = savedRepoClonePath(for: linked) ?? projectRoot
        return .init(client: client, projectId: linked.remoteId, gitRoot: gitRoot, projectRoot: projectRoot)
    }

    /// Local clone path of the saved repo bound via `linkedRepo`, so auto-
    /// tasks run in the repo's working tree rather than the project root.
    /// Returns nil when no matching saved repo exists or it hasn't been
    /// cloned yet; callers fall back to the project root.
    func savedRepoClonePath(for linked: ProjectSettings.LinkedRepo) -> String? {
        switch linked.kind {
        case .github:
            guard let repo = config.gitHubSavedRepos.first(where: {
                guard let (owner, name) = GitHubClient.ownerAndName(from: $0.url) else { return false }
                return "\(owner)/\(name)" == linked.remoteId
            }), let path = repo.localPath, !path.isEmpty else { return nil }
            return path
        case .gitlab:
            guard let p = config.gitLabSavedProjects
                .first(where: { String($0.resolvedId ?? 0) == linked.remoteId }),
                let path = p.localPath, !path.isEmpty else { return nil }
            return path
        }
    }

    /// One-line summary of why `resolveBackendAndProject()` found no usable
    /// backend — shown in the task log so a misconfiguration is obvious.
    func resolveDiagnosis() -> String {
        let glToken = config.gitLabToken.isEmpty ? "empty" : "set"
        let ghToken = config.gitHubToken.isEmpty ? "empty" : "set"
        let activeName = projectStore?.activeProject?.bundle.displayName ?? "none"
        let linked: String = {
            guard let l = projectStore?.activeProject?.bundle.settings.linkedRepo else { return "none" }
            return "\(l.kind) remoteId=\(l.remoteId)"
        }()
        let glClone = config.gitLabSavedProjects.first(where: { $0.isActive })?.localPath ?? "(none / empty)"
        let ghClone = config.gitHubSavedRepos.first(where: { $0.isActive })?.localPath ?? "(none / empty)"
        return "No usable backend — GitLab token=\(glToken); GitHub token=\(ghToken); active project='\(activeName)' (linkedRepo=\(linked)); active GitLab project clone=\(glClone); active GitHub repo clone=\(ghClone). Need an active project/repo with a matching token + a non-empty local clone path."
    }

    /// Paginated fetch — walks `listIssues` until a page returns fewer
    /// rows than the expected page size or we hit a hard ceiling. State
    /// `.all` so the dedupe step sees closed issues too.
    ///
    /// Page-size note: both adapters now request 100/page (GitLab
    /// per_page=100, GitHub per_page=50 with client-side PR filtering).
    /// We track "saw at least one full-ish page" rather than a hard
    /// threshold so a GitHub page that's shortened by PR filtering
    /// doesn't false-stop pagination — we only stop when the page is
    /// clearly the last (< 10 items) or empty.
    func fetchAllIssues(client: RepoBackend, projectId: String) async throws -> [RepoIssue] {
        let filter = RepoIssueFilter(state: .all)
        let maxPages = 20
        var out: [RepoIssue] = []
        for page in 1...maxPages {
            let batch = try await client.listIssues(projectId: projectId, filter: filter, page: page)
            out.append(contentsOf: batch)
            // Empty page = nothing more upstream. A small-but-nonzero
            // page on GitHub can occur when many PRs were filtered out
            // client-side; keep walking until we see truly empty.
            if batch.isEmpty { break }
        }
        return out
    }
}
