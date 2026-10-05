import Foundation

/// Whether the edits in a working tree can be shipped, and by what.
enum ChangeShippingAvailability {
    case available(ChangeShipping)
    /// Why not — shown to the user as it is, so it must say what to do.
    case unavailable(reason: String)
}

/// Finds the project a working tree belongs to and builds the shipper for it.
///
/// The repo is found by the LOCAL PATH: the saved GitLab project / GitHub repo
/// whose clone is exactly `gitRoot`. That ties the edits and the request
/// together — the request is opened in the project those edits came from, never
/// in whichever project happens to be "active" elsewhere in the app.
@MainActor
enum ChangeShippingFactory {
    static func make(for gitRoot: URL, config: AppConfig) -> ChangeShippingAvailability {
        let here = canonical(gitRoot)

        if let project = config.gitLabSavedProjects.first(where: { saved in
            guard let local = saved.localPath, !local.isEmpty else { return false }
            return canonical(URL(fileURLWithPath: local)) == here
        }) {
            guard let id = project.resolvedId else {
                return .unavailable(reason: "the GitLab project “\(project.displayName)” has no resolved id yet — open it once in Source Control.")
            }
            guard !config.gitLabToken.isEmpty else {
                return .unavailable(reason: "no GitLab token is set — add one in Settings → GitLab / GitHub.")
            }
            return .available(shipper(
                backend: RepoBackendFactory.guarded(GitLabClient(config: config), config: config),
                projectId: String(id), hint: project.defaultBranch, expectedRemote: project.url,
                token: config.gitLabToken, pushBackend: .gitlab, kind: .gitlab, config: config))
        }

        if let repo = config.gitHubSavedRepos.first(where: { saved in
            guard let local = saved.localPath, !local.isEmpty else { return false }
            return canonical(URL(fileURLWithPath: local)) == here
        }) {
            guard let (owner, name) = GitHubClient.ownerAndName(from: repo.url) else {
                return .unavailable(reason: "cannot read the GitHub owner and name from “\(repo.url)”.")
            }
            guard !config.gitHubToken.isEmpty else {
                return .unavailable(reason: "no GitHub token is set — add one in Settings → GitLab / GitHub.")
            }
            return .available(shipper(
                backend: RepoBackendFactory.guarded(GitHubClient(config: config), config: config),
                projectId: "\(owner)/\(name)", hint: repo.defaultBranch, expectedRemote: repo.url,
                token: config.gitHubToken, pushBackend: .github, kind: .github, config: config))
        }

        return .unavailable(reason: "no GitLab project or GitHub repo is linked to this folder — clone it from Source Control.")
    }

    private static func shipper(backend: RepoBackend, projectId: String, hint: String?, expectedRemote: String,
                                token: String, pushBackend: RepoManager.Backend, kind: RepoBackendKind,
                                config: AppConfig) -> ChangeShipping {
        GitChangeShipper(
            git: RepoManagerShipGit(repo: RepoManager(), token: token, backend: pushBackend),
            backend: backend, projectId: projectId, defaultBranchHint: hint,
            expectedRemote: expectedRemote,
            isAllowed: { config.isAllowed($0, provider: kind) })
    }

    private static func canonical(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path
    }
}
