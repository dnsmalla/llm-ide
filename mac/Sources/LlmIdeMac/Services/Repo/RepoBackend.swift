// Backend abstraction for the issue / PR / project surface.
//
// History: the app started GitLab-only with GitLabClient wired directly
// into provider-specific views. A shared protocol (this file) now routes
// every issue-related call so both GitLab and GitHub use the same UI
// layer (RepoIssuesView, GanttContainerView) without duplication.
//
// Both READ and WRITE paths are covered for GitLab and GitHub.
// MR/PR creation remains GitLab-only; `canCreateMergeRequests` gates
// that affordance in the UI.

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

    /// "Merge Request" (GitLab) / "Pull Request" (GitHub) — the provider's
    /// own name for a change-review request, so the Code workflow copy reads
    /// natively whichever backend is active.
    var changeRequestNoun: String {
        switch self {
        case .gitlab: return "Merge Request"
        case .github: return "Pull Request"
        }
    }

    /// Short form: "MR" / "PR".
    var changeRequestAbbrev: String {
        switch self {
        case .gitlab: return "MR"
        case .github: return "PR"
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

    /// Placeholder for a deleted/ghost account. GitHub returns `user: null`
    /// (and GitLab a "Ghost User") for issues/comments authored by accounts
    /// that no longer exist — without this, one such record would crash the
    /// whole list decode. Used as the author fallback in the adapters.
    static let ghost = RepoUser(id: "ghost", username: "ghost",
                                displayName: "(deleted user)", avatarUrl: nil)
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
    /// GitLab native issue weight; nil on GitHub.
    let weight: Int?

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
            dueDate: dueDate,
            weight: weight
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
    /// GitLab-only numeric weight. GitHub adapters silently ignore (no-op).
    var weight: Int?

    enum StateChange { case close, reopen }

    init(title: String? = nil, body: String? = nil, labels: [String]? = nil,
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
struct RepoMergeRequestPayload: Sendable {
    var title: String
    var description: String?
    var sourceBranch: String
    var targetBranch: String
    /// Open as a draft. GitHub sends `draft: true`; GitLab has no create-time
    /// flag, so its adapter prefixes the title with "Draft:" (its native
    /// draft mechanism).
    var draft: Bool

    init(title: String, description: String? = nil, sourceBranch: String,
         targetBranch: String, draft: Bool = false) {
        self.title = title
        self.description = description
        self.sourceBranch = sourceBranch
        self.targetBranch = targetBranch
        self.draft = draft
    }
}

struct RepoMergeRequest: Identifiable, Hashable, Sendable {
    let id: String
    /// Per-project number — `iid` (GitLab) / `number` (GitHub).
    let number: Int
    let title: String
    /// "opened" / "merged" / "closed" (GitLab vocabulary; the GitHub adapter
    /// maps "open" → "opened").
    let state: String
    let sourceBranch: String
    let targetBranch: String
    let webUrl: String
    let isDraft: Bool
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
// Main-actor-isolated: both conformers (GitLabClient/GitHubClient) are
// @MainActor — they read main-mutated AppConfig live — and every consumer is
// a SwiftUI view. Isolating the protocol to match avoids the Swift 6
// conformance-isolation warning without faking Sendability.
@MainActor
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

    /// Labels and milestones feed the filter dropdowns.
    func listLabels(projectId: String) async throws -> [RepoLabel]
    func listMilestones(projectId: String) async throws -> [RepoMilestone]
    /// Assignable project members, for the assignee editor. Each `RepoUser.id`
    /// is in the form the backend's `updateIssue(assigneeIds:)` expects
    /// (GitLab: numeric id; GitHub: login).
    func listMembers(projectId: String) async throws -> [RepoUser]

    /// Capability flags — call sites read these to gate UI.
    /// Phase 2 implements issue writes on both backends, so
    /// `canWriteIssues` is now true everywhere. MR/PR creation is still
    /// GitLab-only until a separate phase adds GitHub PR support.
    var canWriteIssues: Bool { get }
    var canCreateMergeRequests: Bool { get }
    /// True when issues carry a native numeric weight (GitLab). Views show a weight badge/editor only when true.
    var supportsWeight: Bool { get }
    /// True when issue start/due dates come from our /kb/issue-schedule overlay instead of native fields (GitHub).
    var usesScheduleOverlay: Bool { get }

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

    /// Create branch `name` from existing branch `ref`. Idempotent: returns
    /// `true` when a new branch was created, `false` when it already existed
    /// (so callers reuse it instead of failing). Throws on other errors.
    /// Needed by the AI code-change workflow (issue → branch → commit → MR).
    @discardableResult
    func createBranch(projectId: String, name: String, ref: String) async throws -> Bool

    /// Create a merge request / pull request. Returns the created MR/PR.
    func createMergeRequest(projectId: String, payload: RepoMergeRequestPayload) async throws -> RepoMergeRequest

    /// Open merge requests / pull requests for a project — used to dedup
    /// before creating, since both backends reject a duplicate for the same
    /// source/head branch.
    func listOpenMergeRequests(projectId: String) async throws -> [RepoMergeRequest]
}
