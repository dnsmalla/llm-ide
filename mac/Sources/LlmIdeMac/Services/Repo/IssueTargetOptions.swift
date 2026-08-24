import Foundation

struct IssueTargetOption: Identifiable, Hashable {
    let id: String
    let kind: RepoBackendKind
    let projectId: String
    let label: String
    let isActive: Bool
}

enum IssueTargetOptions {
    @MainActor
    static func all(config: AppConfig) -> [IssueTargetOption] {
        var options: [IssueTargetOption] = []
        if !config.gitLabToken.isEmpty {
            for project in config.gitLabSavedProjects {
                guard let resolvedId = project.resolvedId else { continue }
                let display = !project.displayName.isEmpty
                    ? project.displayName
                    : (URL(string: project.url)?.lastPathComponent ?? "project")
                options.append(IssueTargetOption(
                    id: "gitlab:\(resolvedId)",
                    kind: .gitlab,
                    projectId: String(resolvedId),
                    label: "\(display) (GitLab)",
                    isActive: project.isActive
                ))
            }
        }
        if !config.gitHubToken.isEmpty {
            for repo in config.gitHubSavedRepos {
                guard let (owner, name) = GitHubClient.ownerAndName(from: repo.url) else { continue }
                let pid = "\(owner)/\(name)"
                options.append(IssueTargetOption(
                    id: "github:\(pid)",
                    kind: .github,
                    projectId: pid,
                    label: "\(pid) (GitHub)",
                    isActive: repo.isActive
                ))
            }
        }
        return options
    }
}
