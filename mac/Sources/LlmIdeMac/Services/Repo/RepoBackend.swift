// Backend abstraction for the issue / PR / project surface.
//
// History: the app started GitLab-only with GitLabClient (351 lines, 20+
// methods) wired directly into IssueBoardView, GanttView, autoCode, and
// the agent sheets. Adding GitHub as a second provider would either
// duplicate that surface or, the chosen path here, route every issue-
// related call through a small protocol both providers implement.
//
// This v1 covers READ paths only — list projects / issues / labels /
// milestones / members / get-one-issue. Write paths (create, update,
// comments, branches, MR/PR creation) stay GitLab-only for now; the
// `canWriteIssues` capability flag lets call sites disable those UI
// affordances when the active backend can't service them.

import Foundation

// MARK: - Backend identity

enum RepoBackendKind: String, Sendable, Hashable, CaseIterable, Codable {
    case gitlab
    case github

    var displayName: String {
        switch self {
        case .gitlab: return "GitLab"
        case .github: return "GitHub"
        }
    }

    var sfSymbol: String {
        switch self {
        case .gitlab: return "checklist"
        case .github: return "chevron.left.forwardslash.chevron.right"
        }
    }
}

// MARK: - Neutral models
//
// IDs are strings throughout: GitLab uses Int, GitHub uses Int — but
// neither needs arithmetic on the value, and stringifying keeps the
// protocol portable to future providers (Linear, Jira, …) without
// breaking the type signature.

struct RepoProject: Identifiable, Hashable, Sendable {
    let id: String
    /// Plain project / repo name (e.g. "meet-notes").
    let name: String
    /// Qualified name with the owner / namespace (e.g. "acme/meet-notes").
    let fullName: String
    let webUrl: String
    let avatarUrl: String?
    let description: String?
    let openIssuesCount: Int?
    let backend: RepoBackendKind
}

struct RepoUser: Identifiable, Hashable, Sendable {
    let id: String
    let username: String
    let displayName: String
    let avatarUrl: String?
}

struct RepoLabel: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    /// "#rrggbb" — GitLab returns this, GitHub returns hex without the
    /// hash; backends normalise to "#rrggbb" form.
    let color: String
    let description: String?
}

struct RepoMilestone: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    /// "active" / "closed" (matches GitLab's vocabulary; GitHub's "open"
    /// is translated to "active" by the adapter).
    let state: String
    let dueDate: String?
    let startDate: String?
    let description: String?
}

struct RepoIssue: Identifiable, Hashable, Sendable {
    let id: String
    /// Per-project issue number — `iid` in GitLab, `number` in GitHub.
    /// Stable + user-visible (used in URLs and 'Issue #N' labels).
    let number: Int
    let title: String
    let body: String?
    /// "opened" / "closed". Adapter maps GitHub's "open" → "opened" so
    /// existing IssueFilter state values keep working.
    let state: String
    let labels: [String]
    let milestone: RepoMilestone?
    let assignees: [RepoUser]
    let author: RepoUser
    let createdAt: String
    let updatedAt: String
    let closedAt: String?
    let webUrl: String
    let commentCount: Int
    let dueDate: String?

    var isOpen: Bool { state == "opened" }

    /// Return a copy with a delta applied to `commentCount`. Used by
    /// the detail sheet after a successful comment post so the row in
    /// the list reflects the new total without a refetch.
    func bumping(commentCount delta: Int) -> RepoIssue {
        RepoIssue(
            id: id, number: number, title: title, body: body, state: state,
            labels: labels, milestone: milestone, assignees: assignees,
            author: author, createdAt: createdAt, updatedAt: updatedAt,
            closedAt: closedAt, webUrl: webUrl,
            commentCount: max(0, commentCount + delta),
            dueDate: dueDate
        )
    }
}

struct RepoNote: Identifiable, Hashable, Sendable {
    let id: String
    let body: String
    let author: RepoUser
    let createdAt: String
    /// GitLab marks system-generated notes via this flag; GitHub doesn't
    /// have a direct equivalent (most are inferable by author == 'github')
    /// — adapter sets false unless it can confidently identify a system
    /// note.
    let isSystem: Bool
}

// MARK: - Write payloads

/// Neutral create / update payload. Both backends accept a partial
/// update: any non-nil field is sent, any nil field is left unchanged
/// server-side. `stateChange` is the only field that has to be the
/// dedicated state-event verb on GitLab and a state-string on GitHub —
/// the adapters translate.
struct RepoIssuePayload {
    var title: String?
    var body: String?
    /// Label names (not IDs). Both backends accept names directly.
    var labels: [String]?
    /// Stringified milestone ID (GitLab numeric, GitHub uses milestone
    /// number for write). Nil leaves it unchanged; "" clears it.
    var milestoneId: String?
    /// Stringified assignee IDs (usernames on GitHub, numeric IDs on
    /// GitLab). The adapter handles the protocol shape.
    var assigneeIds: [String]?
    /// "yyyy-MM-dd" ISO date. GitLab-only field — GitHub adapters
    /// silently ignore (GitHub has no per-issue due date). Set on
    /// create / update.
    var dueDate: String?
    /// Open / close transition. nil = no change.
    var stateChange: StateChange?

    enum StateChange { case close, reopen }

    init(title: String? = nil, body: String? = nil, labels: [String]? = nil,
         milestoneId: String? = nil, assigneeIds: [String]? = nil,
         dueDate: String? = nil, stateChange: StateChange? = nil) {
        self.title = title; self.body = body; self.labels = labels
        self.milestoneId = milestoneId; self.assigneeIds = assigneeIds
        self.dueDate = dueDate; self.stateChange = stateChange
    }
}

// MARK: - Filter (neutral, replaces GitLab's IssueFilter for protocol use)

struct RepoIssueFilter: Equatable, Sendable {
    var state: IssueState
    var search: String
    var labelName: String
    var milestoneId: String?
    var assigneeId: String?

    enum IssueState: String, Sendable, CaseIterable, Identifiable {
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

    init(state: IssueState = .opened,
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

/// Minimal read-shaped contract. Per-call errors throw; the caller
/// decides how to surface them.
protocol RepoBackend: Sendable {
    var kind: RepoBackendKind { get }

    /// All projects / repos the configured credentials can see.
    func listProjects() async throws -> [RepoProject]

    /// One project by its backend-native ID (stringified).
    func getProject(id: String) async throws -> RepoProject

    /// Issues for a project, paginated. `page` is 1-based.
    func listIssues(projectId: String, filter: RepoIssueFilter, page: Int) async throws -> [RepoIssue]

    /// Single issue by its per-project number.
    func getIssue(projectId: String, number: Int) async throws -> RepoIssue

    /// Labels and milestones feed the filter dropdowns. A `listMembers`
    /// equivalent existed earlier but had no callers in the neutral
    /// views (the legacy IssueBoardView still calls the GitLab-typed
    /// listMembers directly). It can be reintroduced once a neutral
    /// assignee filter lands on RepoIssuesView / RepoGanttView.
    func listLabels(projectId: String) async throws -> [RepoLabel]
    func listMilestones(projectId: String) async throws -> [RepoMilestone]

    /// Capability flags — call sites read these to gate UI.
    /// Phase 2 implements issue writes on both backends, so
    /// `canWriteIssues` is now true everywhere. MR/PR creation is still
    /// GitLab-only until a separate phase adds GitHub PR support.
    var canWriteIssues: Bool { get }
    var canCreateMergeRequests: Bool { get }

    // MARK: - Writes

    /// Create a new issue. Returns the created issue (with its assigned
    /// number / id populated).
    func createIssue(projectId: String, payload: RepoIssuePayload) async throws -> RepoIssue

    /// Patch an existing issue. Only non-nil fields in `payload` are
    /// sent — both backends treat absent fields as "leave unchanged".
    func updateIssue(projectId: String, number: Int, payload: RepoIssuePayload) async throws -> RepoIssue

    /// All comments / notes on an issue, ordered oldest → newest.
    func listNotes(projectId: String, number: Int) async throws -> [RepoNote]

    /// Post a comment. Returns the created note.
    func createNote(projectId: String, number: Int, body: String) async throws -> RepoNote
}
