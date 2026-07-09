import Foundation

/// Snapshot of client-side state attached to every Code Assistant
/// request. Server inlines it into the system prompt so the agent
/// doesn't have to ask "which project" or "what repos".
struct AgentContext: Codable, Equatable {
    var activeProject: Project?
    var indexedRepos: [IndexedRepo]
    var recentIssues: [RecentIssue]?
    /// Absolute or "~/"-relative path of the folder open in the Explorer. The
    /// server scopes the read-only file tools (list-files / read-file) to this
    /// root plus the indexed repos. Optional for back-compat.
    var workspaceRoot: String?
    /// Opaque session identifier forwarded to the backend task store so
    /// multi-turn agentic loops can be correlated across requests.
    var sessionId: String?
    /// Current git branch for the active repo (if any). Populated so the agent
    /// can answer "what branch am I on?" without a git-op tool call.
    var currentBranch: String?
    /// Git status summary for the active repo (if any). Simplified version
    /// of porcelain status with counts of staged/unstaged files.
    var gitStatus: GitStatus?

    struct Project: Codable, Equatable {
        var name: String
        var url: String
        var defaultBranch: String?
        /// Human-readable issue-tracker provider ("GitLab" | "GitHub").
        /// Inlined into the system prompt so the agent knows which tracker
        /// to file issues against — without it the issue skill assumes
        /// GitLab and refuses to act on GitHub projects.
        var provider: String?
    }

    struct IndexedRepo: Codable, Equatable {
        var name: String
        var path: String?
    }

    /// Compact snapshot of a recent GitLab issue. Server inlines these
    /// into the system prompt so the agent can answer "fix issue #42"
    /// without a separate read tool. Kept small on purpose — long
    /// descriptions blow the prompt size cap when many issues are
    /// open. Agents that need full body call a future get-issue tool.
    struct RecentIssue: Codable, Equatable {
        var iid: Int
        var title: String
        var state: String              // "opened" | "closed"
        var labels: [String]
        var snippet: String?           // first ~160 chars of description
        var updatedAt: String?         // ISO-8601
    }

    /// Simplified git status summary. Counts are small integers; a full
    /// file list would blow the prompt budget. Agents that need details
    /// call the git-op status tool.
    struct GitStatus: Codable, Equatable {
        var staged: Int                // staged files count
        var unstaged: Int              // unstaged files count
        var ahead: Int                 // commits ahead of upstream
        var behind: Int                // commits behind upstream
        var hasUpstream: Bool          // whether branch tracks remote
    }
}

struct AgentTask: Codable, Identifiable {
    let id: String
    let title: String
    let status: String  // "pending" | "in_progress" | "completed" | "skipped"
}

/// A write tool the agent wants to run. The Mac client renders a
/// confirm sheet based on `name`; once the user confirms, the Mac
/// executes the action locally (no server round-trip needed).
struct PendingTool: Codable, Equatable {
    var name: String
    /// Raw arguments as JSON — we decode the typed view lazily based
    /// on `name`. Keeps the type extensible without a polymorphic enum.
    var arguments: AnyArguments

    /// Codable wrapper that round-trips the raw JSON object payload of
    /// `arguments`. Stored as Data so a typed accessor (see
    /// `createIssueArgs`) can re-decode it into a concrete struct.
    struct AnyArguments: Codable, Equatable {
        let raw: Data

        init(raw: Data) { self.raw = raw }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            let value = try container.decode(AnyCodable.self)
            self.raw = try AppJSON.encoder.encode(value)
        }
        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            if let object = try? JSONSerialization.jsonObject(with: raw) {
                try container.encode(AnyCodable(object))
            } else {
                try container.encodeNil()
            }
        }

        static func == (lhs: AnyArguments, rhs: AnyArguments) -> Bool {
            lhs.raw == rhs.raw
        }
    }

    /// Typed view for the create-issue variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    /// Supports both "create-gitlab-issue" (legacy) and "create-issue" (provider-agnostic).
    var createIssueArgs: CreateIssueArgs? {
        guard name == "create-gitlab-issue" || name == "create-issue" else { return nil }
        return try? AppJSON.decoder.decode(CreateIssueArgs.self, from: arguments.raw)
    }

    struct CreateIssueArgs: Codable, Equatable {
        var title: String
        var description: String
        var labels: [String]?
        var assignee: String?
    }

    /// Typed view for the comment-issue variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    /// Supports both "comment-gitlab-issue" (legacy) and "comment-issue" (provider-agnostic).
    var commentIssueArgs: CommentIssueArgs? {
        guard name == "comment-gitlab-issue" || name == "comment-issue" else { return nil }
        return try? AppJSON.decoder.decode(CommentIssueArgs.self, from: arguments.raw)
    }

    struct CommentIssueArgs: Codable, Equatable {
        var iid: Int
        var body: String
    }

    /// Typed view for the get-issue variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var getIssueArgs: GetIssueArgs? {
        guard name == "get-issue" else { return nil }
        return try? AppJSON.decoder.decode(GetIssueArgs.self, from: arguments.raw)
    }

    struct GetIssueArgs: Codable, Equatable {
        var iid: Int
    }

    /// Typed view for the update-issue variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var updateIssueArgs: UpdateIssueArgs? {
        guard name == "update-issue" else { return nil }
        return try? AppJSON.decoder.decode(UpdateIssueArgs.self, from: arguments.raw)
    }

    struct UpdateIssueArgs: Codable, Equatable {
        var iid: Int
        var title: String?
        var description: String?
        var state: String?           // "opened" | "closed"
        var labels: [String]?
    }

    /// Typed view for the list-issues variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var listIssuesArgs: ListIssuesArgs? {
        guard name == "list-issues" else { return nil }
        return try? AppJSON.decoder.decode(ListIssuesArgs.self, from: arguments.raw)
    }

    struct ListIssuesArgs: Codable, Equatable {
        var search: String?           // search query
        var state: String?            // "opened" | "closed"
        var label: String?            // filter by label
    }

    /// Typed view for the create-branch variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var createBranchArgs: CreateBranchArgs? {
        guard name == "create-branch" else { return nil }
        return try? AppJSON.decoder.decode(CreateBranchArgs.self, from: arguments.raw)
    }

    struct CreateBranchArgs: Codable, Equatable {
        var branch: String            // branch name to create
        var startPoint: String?      // optional: starting ref (default: current HEAD)
    }

    /// Typed view for the create-pr (create-mr) variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    /// Supports both "create-gitlab-mr" (legacy) and "create-pr" (provider-agnostic).
    var createPRArgs: CreatePRArgs? {
        guard name == "create-gitlab-mr" || name == "create-pr" else { return nil }
        return try? AppJSON.decoder.decode(CreatePRArgs.self, from: arguments.raw)
    }

    struct CreatePRArgs: Codable, Equatable {
        var title: String             // PR/MR title
        var description: String       // PR/MR description
        var sourceBranch: String      // branch containing changes
        var targetBranch: String      // branch to merge into (e.g., main, develop)
        var labels: [String]?         // optional labels
        var assignee: String?         // optional assignee username
    }

    /// Typed view for the trigger-review-code variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var triggerReviewCodeArgs: TriggerReviewCodeArgs? {
        guard name == "trigger-review-code" else { return nil }
        return try? AppJSON.decoder.decode(TriggerReviewCodeArgs.self, from: arguments.raw)
    }

    struct TriggerReviewCodeArgs: Codable, Equatable {
        var plan: String
        var iid: Int
    }

    /// Typed view for the update-file variant. Returns nil if `name`
    /// is different or the payload doesn't fit the schema.
    var updateFileArgs: UpdateFileArgs? {
        guard name == "update-file" else { return nil }
        return try? AppJSON.decoder.decode(UpdateFileArgs.self, from: arguments.raw)
    }

    struct UpdateFileArgs: Codable, Equatable {
        var path: String
        var content: String
    }

    /// Typed view for the git-op variant. Returns nil if `name`
    /// is different or the payload doesn't fit the schema.
    var gitOpArgs: GitOpArgs? {
        guard name == "git-op" else { return nil }
        return try? AppJSON.decoder.decode(GitOpArgs.self, from: arguments.raw)
    }

    /// Typed view for the bash execution variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var bashArgs: BashArgs? {
        guard name == "bash" else { return nil }
        return try? AppJSON.decoder.decode(BashArgs.self, from: arguments.raw)
    }
}

struct GitOpArgs: Codable {
    let op: GitOp
    let message: String?
    let branch: String?
    let ref: String?
    let mode: String?
    let slug: String?
}

/// Bash execution arguments
struct BashArgs: Codable, Equatable {
    let command: String
    let workingDirectory: String?
}

enum GitOpTier { case read, write, destructive }

enum GitOp: String, Codable, CaseIterable {
    case status, log, diff, branch
    case add, commit, create_branch, checkout, pull_ff, push
    case merge, revert, reset, stash, clean, merge_to_main, clone

    var tier: GitOpTier {
        switch self {
        case .status, .log, .diff, .branch: return .read
        case .add, .commit, .create_branch, .checkout, .pull_ff, .push: return .write
        case .merge, .revert, .reset, .stash, .clean, .merge_to_main, .clone: return .destructive
        }
    }
}
