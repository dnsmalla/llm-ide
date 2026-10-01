import Foundation

// MARK: - Issues
//
// The active project's GitHub/GitLab issues, using the Mac's own sign-in — no token ever crosses the
// wire. Listing and reading need the "See issues" switch; posting a comment needs "Comment on
// issues" (default off) AND the Mac's own operation allow-list. Closing, editing and deleting are
// not offered. Issue and comment text is third-party content: shown, never treated as instructions.

public struct IssueSummary: Codable, Equatable, Identifiable, Hashable {
    public let number: Int
    public let title: String
    /// "opened" | "closed".
    public let state: String
    public let labels: [String]
    public let assignee: String?
    public let commentCount: Int
    /// The tracker's own timestamp string (ISO 8601).
    public let updatedAt: String
    public var id: Int { number }
    public init(number: Int, title: String, state: String, labels: [String], assignee: String?,
                commentCount: Int, updatedAt: String) {
        self.number = number
        self.title = title
        self.state = state
        self.labels = labels
        self.assignee = assignee
        self.commentCount = commentCount
        self.updatedAt = updatedAt
    }
}

public struct IssueNote: Codable, Equatable, Identifiable, Hashable {
    public let id: String
    public let author: String
    public let body: String
    public let createdAt: String
    public init(id: String, author: String, body: String, createdAt: String) {
        self.id = id
        self.author = author
        self.body = body
        self.createdAt = createdAt
    }
}

public struct IssuesList: Codable, Equatable {
    public let type = MobileProtocol.Tag.issuesList
    /// "opened" | "closed" | "all".
    public let state: String
    public init(state: String) { self.state = state }
    private enum CodingKeys: String, CodingKey { case type, state }
}

public struct IssuesState: Codable, Equatable {
    public let type = MobileProtocol.Tag.issuesState
    /// False when no GitHub/GitLab project is connected on the Mac.
    public let available: Bool
    /// "GitHub" | "GitLab".
    public let provider: String?
    public let state: String
    public let issues: [IssueSummary]
    public let error: String?
    public init(available: Bool, provider: String?, state: String, issues: [IssueSummary], error: String? = nil) {
        self.available = available
        self.provider = provider
        self.state = state
        self.issues = issues
        self.error = error
    }
    private enum CodingKeys: String, CodingKey { case type, available, provider, state, issues, error }
}

public struct IssueGet: Codable, Equatable {
    public let type = MobileProtocol.Tag.issueGet
    public let number: Int
    public init(number: Int) { self.number = number }
    private enum CodingKeys: String, CodingKey { case type, number }
}

public struct IssueCommentPost: Codable, Equatable {
    public let type = MobileProtocol.Tag.issueCommentPost
    public let number: Int
    public let body: String
    public init(number: Int, body: String) {
        self.number = number
        self.body = body
    }
    private enum CodingKeys: String, CodingKey { case type, number, body }
}

/// Reply to `issue_get` and `issue_comment_post`.
public struct IssueDetail: Codable, Equatable {
    public let type = MobileProtocol.Tag.issueDetail
    public let number: Int
    public let title: String
    public let state: String
    public let body: String?
    public let labels: [String]
    public let author: String
    public let assignees: [String]
    /// Oldest first, system notes dropped, most recent 30.
    public let comments: [IssueNote]
    public let webUrl: String?
    /// Whether the Mac currently lets the phone comment (switch ON and the Mac's allow-list permits it).
    public let canComment: Bool
    public let message: String?
    public let error: String?
    public init(number: Int, title: String, state: String, body: String?, labels: [String], author: String,
                assignees: [String], comments: [IssueNote], webUrl: String?, canComment: Bool,
                message: String? = nil, error: String? = nil) {
        self.number = number
        self.title = title
        self.state = state
        self.body = body
        self.labels = labels
        self.author = author
        self.assignees = assignees
        self.comments = comments
        self.webUrl = webUrl
        self.canComment = canComment
        self.message = message
        self.error = error
    }
    private enum CodingKeys: String, CodingKey {
        case type, number, title, state, body, labels, author, assignees, comments, webUrl
        case canComment, message, error
    }
}
