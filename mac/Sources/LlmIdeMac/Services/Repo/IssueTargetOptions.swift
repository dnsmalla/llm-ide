// Multi-target generalization of `CodeAssistantPanel.resolveIssueTarget()`.
//
// The Code panel's "Also file as issue" toggle only ever needs the single
// *active* repo target. The email to-do review panel (Phase 2) needs to let
// the user pick *any* configured repo, so this lists every eligible
// GitHub/GitLab target instead of just the active one. `isActive` mirrors
// the saved record so callers can default their picker selection to it.

import Foundation

/// One repo the user could file an issue against.
struct IssueTargetOption: Identifiable, Hashable {
    let id: String
    let kind: RepoBackendKind
    let projectId: String
    let label: String
    let isActive: Bool
}

enum IssueTargetOptions {
    /// All configured, eligible issue targets across GitLab and GitHub.
    /// A provider is skipped entirely when its token is empty. Individual
    /// saved projects/repos are skipped when they're missing the bits
    /// needed to file an issue (a resolved numeric ID for GitLab, a
    /// parseable owner/name for GitHub).
    @MainActor
    static func all(config: AppConfig) -> [IssueTargetOption] {
        var options: [IssueTargetOption] = []

        if !config.gitLabToken.isEmpty {
            for p in config.gitLabSavedProjects {
                guard let resolvedId = p.resolvedId else { continue }
                let display = !p.displayName.isEmpty ? p.displayName
                    : (URL(string: p.url)?.lastPathComponent ?? "project")
                options.append(
                    IssueTargetOption(
                        id: p.id,
                        kind: .gitlab,
                        projectId: String(resolvedId),
                        label: "\(display) (GitLab)",
                        isActive: p.isActive
                    )
                )
            }
        }

        if !config.gitHubToken.isEmpty {
            for r in config.gitHubSavedRepos {
                guard let (owner, name) = GitHubClient.ownerAndName(from: r.url) else { continue }
                let projectId = "\(owner)/\(name)"
                options.append(
                    IssueTargetOption(
                        id: r.id,
                        kind: .github,
                        projectId: projectId,
                        label: "\(projectId) (GitHub)",
                        isActive: r.isActive
                    )
                )
            }
        }

        return options
    }
}
