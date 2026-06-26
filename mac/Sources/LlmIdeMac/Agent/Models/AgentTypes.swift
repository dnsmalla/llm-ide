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

    struct Project: Codable, Equatable {
        var name: String
        var url: String
        var defaultBranch: String?
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

    /// Typed view for the create-gitlab-issue variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var createIssueArgs: CreateIssueArgs? {
        guard name == "create-gitlab-issue" else { return nil }
        return try? AppJSON.decoder.decode(CreateIssueArgs.self, from: arguments.raw)
    }

    struct CreateIssueArgs: Codable, Equatable {
        var title: String
        var description: String
        var labels: [String]?
        var assignee: String?
    }

    /// Typed view for the comment-gitlab-issue variant. Returns nil if
    /// `name` is different or the payload doesn't fit the schema.
    var commentIssueArgs: CommentIssueArgs? {
        guard name == "comment-gitlab-issue" else { return nil }
        return try? AppJSON.decoder.decode(CommentIssueArgs.self, from: arguments.raw)
    }

    struct CommentIssueArgs: Codable, Equatable {
        var iid: Int
        var body: String
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
}

enum GitOpTier { case read, write, destructive }

enum GitOp: String, Codable, CaseIterable {
    case status, log, diff, branch
    case add, commit, create_branch, checkout, pull_ff, push
    case merge, revert, reset, stash, clean, merge_to_main

    var tier: GitOpTier {
        switch self {
        case .status, .log, .diff, .branch: return .read
        case .add, .commit, .create_branch, .checkout, .pull_ff, .push: return .write
        case .merge, .revert, .reset, .stash, .clean, .merge_to_main: return .destructive
        }
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
