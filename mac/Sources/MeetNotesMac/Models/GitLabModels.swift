import Foundation

// MARK: - Core entities

struct GitLabProject: Identifiable, Codable, Hashable {
    let id: Int
    let name: String
    let nameWithNamespace: String
    let webUrl: String
    let avatarUrl: String?
    let description: String?
    let openIssuesCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, description
        case nameWithNamespace = "name_with_namespace"
        case webUrl = "web_url"
        case avatarUrl = "avatar_url"
        case openIssuesCount = "open_issues_count"
    }
}

struct GitLabUser: Identifiable, Codable, Hashable {
    let id: Int
    let username: String
    let name: String
    let avatarUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, username, name
        case avatarUrl = "avatar_url"
    }
}

struct GitLabLabel: Identifiable, Codable, Hashable {
    let id: Int
    let name: String
    let color: String
    let description: String?
}

struct GitLabMilestone: Identifiable, Codable, Hashable {
    let id: Int
    let iid: Int?
    let title: String
    let state: String
    let dueDate: String?
    let startDate: String?
    let description: String?

    enum CodingKeys: String, CodingKey {
        case id, iid, title, state, description
        case dueDate = "due_date"
        case startDate = "start_date"
    }
}

struct GitLabIssue: Identifiable, Codable, Hashable {
    let id: Int
    let iid: Int
    let title: String
    let description: String?
    let state: String           // "opened" | "closed"
    let labels: [String]
    let milestone: GitLabMilestone?
    let assignees: [GitLabUser]
    let author: GitLabUser
    let createdAt: String
    let updatedAt: String
    let closedAt: String?
    let webUrl: String
    let userNotesCount: Int
    let upvotes: Int
    let downvotes: Int
    let dueDate: String?
    let weight: Int?

    var isOpen: Bool { state == "opened" }

    enum CodingKeys: String, CodingKey {
        case id, iid, title, description, state, labels, milestone, assignees, author
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case closedAt = "closed_at"
        case webUrl = "web_url"
        case userNotesCount = "user_notes_count"
        case upvotes, downvotes
        case dueDate = "due_date"
        case weight
    }
}

struct GitLabNote: Identifiable, Codable, Hashable {
    let id: Int
    let body: String
    let author: GitLabUser
    let createdAt: String
    let updatedAt: String
    let system: Bool

    enum CodingKeys: String, CodingKey {
        case id, body, author, system
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

// MARK: - Filter state

struct IssueFilter: Equatable {
    var state: IssueState = .opened
    var search: String = ""
    var labelName: String = ""
    var milestoneId: Int? = nil
    var assigneeId: Int? = nil

    enum IssueState: String, CaseIterable, Identifiable {
        case opened, closed, all
        var id: String { rawValue }
        var displayName: String {
            switch self {
            case .opened: return "Open"
            case .closed: return "Closed"
            case .all:    return "All"
            }
        }
    }

    var queryItems: [URLQueryItem] {
        var items: [URLQueryItem] = []
        if state != .all { items.append(.init(name: "state", value: state.rawValue)) }
        if !search.isEmpty { items.append(.init(name: "search", value: search)) }
        if !labelName.isEmpty { items.append(.init(name: "labels", value: labelName)) }
        if let mid = milestoneId { items.append(.init(name: "milestone_id", value: "\(mid)")) }
        if let aid = assigneeId { items.append(.init(name: "assignee_id", value: "\(aid)")) }
        items.append(.init(name: "per_page", value: "50"))
        items.append(.init(name: "order_by", value: "updated_at"))
        return items
    }
}

struct GitLabBranch: Identifiable, Codable, Hashable {
    var id: String { name }
    let name: String
    let merged: Bool
    let `protected`: Bool
    let `default`: Bool
    let webUrl: String

    enum CodingKeys: String, CodingKey {
        case name, merged, `protected`, `default`
        case webUrl = "web_url"
    }
}

struct GitLabMergeRequest: Identifiable, Codable, Hashable {
    let id: Int
    let iid: Int
    let title: String
    let description: String?
    let state: String
    let sourceBranch: String
    let targetBranch: String
    let webUrl: String
    let author: GitLabUser

    enum CodingKeys: String, CodingKey {
        case id, iid, title, description, state, author
        case sourceBranch = "source_branch"
        case targetBranch = "target_branch"
        case webUrl = "web_url"
    }
}

struct GitLabMergeRequestPayload: Encodable {
    var title: String
    var description: String?
    var sourceBranch: String
    var targetBranch: String
    var removeSourceBranch: Bool = true
    var labels: String?
    var assigneeId: Int?

    enum CodingKeys: String, CodingKey {
        case title, description, labels
        case sourceBranch = "source_branch"
        case targetBranch = "target_branch"
        case removeSourceBranch = "remove_source_branch"
        case assigneeId = "assignee_id"
    }
}

// MARK: - Create/update payloads

struct GitLabIssuePayload: Encodable {
    var title: String
    var description: String?
    var labels: String?          // comma-separated
    var milestoneId: Int?
    var assigneeIds: [Int]?
    var dueDate: String?
    var stateEvent: String?      // "close" | "reopen"

    enum CodingKeys: String, CodingKey {
        case title, description, labels
        case milestoneId = "milestone_id"
        case assigneeIds = "assignee_ids"
        case dueDate = "due_date"
        case stateEvent = "state_event"
    }
}
