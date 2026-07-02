// RepoKit — the provider-neutral data contract for the issue / PR / project
// surface, extracted into its own SwiftPM target so the boundary is compiler-
// enforced (no accidental reach into app internals). This target has ZERO app
// dependencies (Foundation only): it defines the protocol + value types; the
// concrete GitLab/GitHub clients live in the app and conform to `RepoBackend`.
//
// Both READ and WRITE paths are covered for GitLab and GitHub. MR/PR creation
// remains GitLab-only; `canCreateMergeRequests` gates that affordance in the UI.

import Foundation

// MARK: - Backend identity

public enum RepoBackendKind: String, Sendable, Hashable, CaseIterable, Codable {
    case gitlab
    case github

    public var displayName: String {
        switch self {
        case .gitlab: return "GitLab"
        case .github: return "GitHub"
        }
    }

    public var sfSymbol: String {
        switch self {
        case .gitlab: return "checklist"
        case .github: return "chevron.left.forwardslash.chevron.right"
        }
    }

    /// "Merge Request" (GitLab) / "Pull Request" (GitHub) — the provider's
    /// own name for a change-review request, so the Code workflow copy reads
    /// natively whichever backend is active.
    public var changeRequestNoun: String {
        switch self {
        case .gitlab: return "Merge Request"
        case .github: return "Pull Request"
        }
    }

    /// Short form: "MR" / "PR".
    public var changeRequestAbbrev: String {
        switch self {
        case .gitlab: return "MR"
        case .github: return "PR"
        }
    }
}

// MARK: - Neutral models
//
// IDs are strings throughout: GitLab uses Int, GitHub uses Int — but neither
// needs arithmetic on the value, and stringifying keeps the protocol portable
// to future providers without breaking the type signature.

public struct RepoProject: Identifiable, Hashable, Sendable {
    public let id: String
    /// Plain project / repo name (e.g. "meet-notes").
    public let name: String
    /// Qualified name with the owner / namespace (e.g. "acme/meet-notes").
    public let fullName: String
    public let webUrl: String
    public let avatarUrl: String?
    public let description: String?
    public let openIssuesCount: Int?
    public let backend: RepoBackendKind

    public init(id: String, name: String, fullName: String, webUrl: String,
                avatarUrl: String?, description: String?, openIssuesCount: Int?,
                backend: RepoBackendKind) {
        self.id = id; self.name = name; self.fullName = fullName; self.webUrl = webUrl
        self.avatarUrl = avatarUrl; self.description = description
        self.openIssuesCount = openIssuesCount; self.backend = backend
    }
}

public struct RepoUser: Identifiable, Hashable, Sendable {
    public let id: String
    public let username: String
    public let displayName: String
    public let avatarUrl: String?

    public init(id: String, username: String, displayName: String, avatarUrl: String?) {
        self.id = id; self.username = username
        self.displayName = displayName; self.avatarUrl = avatarUrl
    }

    /// Placeholder for a deleted/ghost account. GitHub returns `user: null`
    /// (and GitLab a "Ghost User") for issues/comments authored by accounts
    /// that no longer exist — without this, one such record would crash the
    /// whole list decode. Used as the author fallback in the adapters.
    public static let ghost = RepoUser(id: "ghost", username: "ghost",
                                       displayName: "(deleted user)", avatarUrl: nil)
}

public struct RepoLabel: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    /// "#rrggbb" — GitLab returns this, GitHub returns hex without the hash;
    /// backends normalise to "#rrggbb" form.
    public let color: String
    public let description: String?

    public init(id: String, name: String, color: String, description: String?) {
        self.id = id; self.name = name; self.color = color; self.description = description
    }
}

public struct RepoMilestone: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    /// "active" / "closed" (matches GitLab's vocabulary; GitHub's "open" is
    /// translated to "active" by the adapter).
    public let state: String
    public let dueDate: String?
    public let startDate: String?
    public let description: String?

    public init(id: String, title: String, state: String, dueDate: String?,
                startDate: String?, description: String?) {
        self.id = id; self.title = title; self.state = state
        self.dueDate = dueDate; self.startDate = startDate; self.description = description
    }
}

public struct RepoIssue: Identifiable, Hashable, Sendable {
    public let id: String
    /// Per-project issue number — `iid` in GitLab, `number` in GitHub.
    /// Stable + user-visible (used in URLs and 'Issue #N' labels).
    public let number: Int
    public let title: String
    public let body: String?
    /// "opened" / "closed". Adapter maps GitHub's "open" → "opened" so
    /// existing IssueFilter state values keep working.
    public let state: String
    public let labels: [String]
    public let milestone: RepoMilestone?
    public let assignees: [RepoUser]
    public let author: RepoUser
    public let createdAt: String
    public let updatedAt: String
    public let closedAt: String?
    public let webUrl: String
    public let commentCount: Int
    public let dueDate: String?
    /// GitLab native issue weight; nil on GitHub.
    public let weight: Int?

    public init(id: String, number: Int, title: String, body: String?, state: String,
                labels: [String], milestone: RepoMilestone?, assignees: [RepoUser],
                author: RepoUser, createdAt: String, updatedAt: String, closedAt: String?,
                webUrl: String, commentCount: Int, dueDate: String?, weight: Int?) {
        self.id = id; self.number = number; self.title = title; self.body = body
        self.state = state; self.labels = labels; self.milestone = milestone
        self.assignees = assignees; self.author = author; self.createdAt = createdAt
        self.updatedAt = updatedAt; self.closedAt = closedAt; self.webUrl = webUrl
        self.commentCount = commentCount; self.dueDate = dueDate; self.weight = weight
    }

    public var isOpen: Bool { state == "opened" }

    /// Return a copy with a delta applied to `commentCount`. Used by the detail
    /// sheet after a successful comment post so the row in the list reflects the
    /// new total without a refetch.
    public func bumping(commentCount delta: Int) -> RepoIssue {
        RepoIssue(
            id: id, number: number, title: title, body: body, state: state,
            labels: labels, milestone: milestone, assignees: assignees,
            author: author, createdAt: createdAt, updatedAt: updatedAt,
            closedAt: closedAt, webUrl: webUrl,
            commentCount: max(0, commentCount + delta),
            dueDate: dueDate, weight: weight
        )
    }
}

public struct RepoNote: Identifiable, Hashable, Sendable {
    public let id: String
    public let body: String
    public let author: RepoUser
    public let createdAt: String
    /// GitLab marks system-generated notes via this flag; GitHub doesn't have a
    /// direct equivalent — adapter sets false unless it can confidently
    /// identify a system note.
    public let isSystem: Bool

    public init(id: String, body: String, author: RepoUser, createdAt: String, isSystem: Bool) {
        self.id = id; self.body = body; self.author = author
        self.createdAt = createdAt; self.isSystem = isSystem
    }
}

// MARK: - Write payloads

/// Neutral create / update payload. Both backends accept a partial update: any
/// non-nil field is sent, any nil field is left unchanged server-side.
public struct RepoIssuePayload {
    public var title: String?
    public var body: String?
    /// Label names (not IDs). Both backends accept names directly.
    public var labels: [String]?
    /// Stringified milestone ID (GitLab numeric, GitHub milestone number for
    /// write). Nil leaves it unchanged; "" / "0" clears it.
    public var milestoneId: String?
    /// Stringified assignee IDs (usernames on GitHub, numeric IDs on GitLab).
    public var assigneeIds: [String]?
    /// "yyyy-MM-dd" ISO date. GitLab-only field — GitHub adapters silently
    /// ignore (GitHub has no per-issue due date).
    public var dueDate: String?
    /// Open / close transition. nil = no change.
    public var stateChange: StateChange?
    /// GitLab-only numeric weight. GitHub adapters silently ignore (no-op).
    public var weight: Int?

    public enum StateChange { case close, reopen }

    public init(title: String? = nil, body: String? = nil, labels: [String]? = nil,
                milestoneId: String? = nil, assigneeIds: [String]? = nil,
                dueDate: String? = nil, stateChange: StateChange? = nil,
                weight: Int? = nil) {
        self.title = title; self.body = body; self.labels = labels
        self.milestoneId = milestoneId; self.assigneeIds = assigneeIds
        self.dueDate = dueDate; self.stateChange = stateChange
        self.weight = weight
    }
}

// MARK: - Merge / pull request

/// Neutral create payload for a merge request (GitLab) / pull request (GitHub).
public struct RepoMergeRequestPayload: Sendable {
    public var title: String
    public var description: String?
    public var sourceBranch: String
    public var targetBranch: String
    /// Open as a draft. GitHub sends `draft: true`; GitLab has no create-time
    /// flag, so its adapter prefixes the title with "Draft:".
    public var draft: Bool

    public init(title: String, description: String? = nil, sourceBranch: String,
                targetBranch: String, draft: Bool = false) {
        self.title = title
        self.description = description
        self.sourceBranch = sourceBranch
        self.targetBranch = targetBranch
        self.draft = draft
    }
}

public struct RepoMergeRequest: Identifiable, Hashable, Sendable {
    public let id: String
    /// Per-project number — `iid` (GitLab) / `number` (GitHub).
    public let number: Int
    public let title: String
    /// "opened" / "merged" / "closed" (GitLab vocabulary; the GitHub adapter
    /// maps "open" → "opened").
    public let state: String
    public let sourceBranch: String
    public let targetBranch: String
    public let webUrl: String
    public let isDraft: Bool

    public init(id: String, number: Int, title: String, state: String,
                sourceBranch: String, targetBranch: String, webUrl: String, isDraft: Bool) {
        self.id = id; self.number = number; self.title = title; self.state = state
        self.sourceBranch = sourceBranch; self.targetBranch = targetBranch
        self.webUrl = webUrl; self.isDraft = isDraft
    }
}

// MARK: - Filter (neutral)

public struct RepoIssueFilter: Equatable, Sendable {
    public var state: IssueState
    public var search: String
    public var labelName: String
    public var milestoneId: String?
    public var assigneeId: String?

    public enum IssueState: String, Sendable, CaseIterable, Identifiable {
        case opened, closed, all
        public var id: String { rawValue }
        public var displayName: String {
            switch self {
            case .opened: return "Open"
            case .closed: return "Closed"
            case .all:    return "All"
            }
        }
    }

    public init(state: IssueState = .opened,
                search: String = "",
                labelName: String = "",
                milestoneId: String? = nil,
                assigneeId: String? = nil) {
        self.state = state
        self.search = search
        self.labelName = labelName
        self.milestoneId = milestoneId
        self.assigneeId = assigneeId
    }
}

// MARK: - Protocol

/// Minimal read+write contract. Per-call errors throw; the caller decides how
/// to surface them. Main-actor-isolated because both conformers
/// (GitLabClient/GitHubClient) are @MainActor and every consumer is a SwiftUI
/// view. Protocol requirements are implicitly public (the protocol is public).
@MainActor
public protocol RepoBackend: Sendable {
    var kind: RepoBackendKind { get }

    /// All projects / repos the configured credentials can see.
    func listProjects() async throws -> [RepoProject]

    /// One project by its backend-native ID (stringified).
    func getProject(id: String) async throws -> RepoProject

    /// Issues for a project, paginated. `page` is 1-based.
    func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue]

    /// Single issue by its per-project number.
    func getIssue(projectId: String, number: Int) async throws -> RepoIssue

    /// Labels and milestones feed the filter dropdowns.
    func listLabels(projectId: String) async throws -> [RepoLabel]
    func listMilestones(projectId: String) async throws -> [RepoMilestone]
    /// Assignable project members, for the assignee editor. Each `RepoUser.id`
    /// is in the form the backend's `updateIssue(assigneeIds:)` expects.
    func listMembers(projectId: String) async throws -> [RepoUser]

    /// Capability flags — call sites read these to gate UI.
    var canWriteIssues: Bool { get }
    var canCreateMergeRequests: Bool { get }
    /// True when issues carry a native numeric weight (GitLab).
    var supportsWeight: Bool { get }
    /// True when issue start/due dates come from the /kb/issue-schedule overlay
    /// instead of native fields (GitHub).
    var usesScheduleOverlay: Bool { get }

    // MARK: - Writes

    func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue
    func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue
    func listNotes(projectId: String, number: Int) async throws -> [RepoNote]
    func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote

    /// Create branch `name` from `ref`. Idempotent: `true` when created,
    /// `false` when it already existed. Throws on other errors.
    @discardableResult
    func createBranch(projectId: String, name: String, ref: String) async throws -> Bool

    func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest
    func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest]
}
