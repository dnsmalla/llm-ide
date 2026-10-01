import Foundation
import SharedProtocol

/// The active project's issue tracker as the phone sees it. Auth stays inside the Mac's
/// `RepoBackend` clients (tokens are read from `AppConfig` there and never leave); this only picks
/// the tracker and shapes issue text — capped and redacted — for the wire.
enum PhoneIssues {
    static let maxIssues = 50
    static let maxBody = 4_000
    static let maxComments = 30
    static let maxComment = 2_000
    static let maxPostedComment = 4_000

    struct Target: Equatable {
        let kind: RepoBackendKind
        let projectId: String
        var providerName: String { kind.displayName }
    }

    /// GitLab first, GitHub second — the same order the Mac chat panel's `resolveIssueTarget` uses.
    @MainActor
    static func target(config: AppConfig) -> Target? {
        if !config.gitLabToken.isEmpty,
           let project = config.gitLabSavedProjects.first(where: { $0.isActive }),
           let pid = project.resolvedId {
            return Target(kind: .gitlab, projectId: String(pid))
        }
        if !config.gitHubToken.isEmpty,
           let repo = config.gitHubSavedRepos.first(where: { $0.isActive }),
           let (owner, name) = GitHubClient.ownerAndName(from: repo.url) {
            return Target(kind: .github, projectId: "\(owner)/\(name)")
        }
        return nil
    }

    nonisolated static func summary(_ i: RepoIssue) -> IssueSummary {
        IssueSummary(number: i.number, title: PhoneRedaction.short(i.title, limit: 200), state: i.state,
                     labels: i.labels.prefix(8).map { String($0.prefix(40)) },
                     assignee: i.assignees.first.map { String($0.username.prefix(60)) },
                     commentCount: i.commentCount, updatedAt: i.updatedAt)
    }

    nonisolated static func summaries(_ issues: [RepoIssue]) -> [IssueSummary] {
        issues.sorted { $0.updatedAt > $1.updatedAt }.prefix(maxIssues).map(summary)
    }

    /// Only http(s) links are offered to the phone.
    nonisolated static func safeURL(_ s: String) -> String? {
        guard let url = URL(string: s), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return s
    }

    nonisolated static func detail(_ i: RepoIssue, notes: [RepoNote], canComment: Bool,
                                   message: String? = nil, error: String? = nil) -> IssueDetail {
        IssueDetail(
            number: i.number, title: PhoneRedaction.short(i.title, limit: 200), state: i.state,
            body: i.body.flatMap { $0.isEmpty ? nil : PhoneRedaction.lines($0, maxChars: maxBody).text },
            labels: i.labels.prefix(12).map { String($0.prefix(40)) },
            author: String(i.author.username.prefix(60)),
            assignees: i.assignees.prefix(8).map { String($0.username.prefix(60)) },
            comments: notes.filter { !$0.isSystem }.suffix(maxComments).map {
                IssueNote(id: $0.id, author: String($0.author.username.prefix(60)),
                          body: PhoneRedaction.lines($0.body, maxChars: maxComment).text, createdAt: $0.createdAt)
            },
            webUrl: safeURL(i.webUrl), canComment: canComment, message: message, error: error)
    }

    /// `nil` = allowed to post. Pure so a test pins every refusal.
    nonisolated static func commentRefusal(switchOn: Bool, body: String) -> String? {
        guard switchOn else { return PhoneAccess.issueComment.deniedMessage }
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "The comment is empty." }
        if trimmed.count > maxPostedComment { return "The comment is too long (max \(maxPostedComment) characters)." }
        return nil
    }
}
