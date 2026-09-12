import Foundation

/// Agent-turn / issue-context / Q&A-nudge metadata for `CodeAssistantPanel`.
/// `agentSessionId`/`agentIsAutonomous`/`agentStopRequested`/`agentPendingTasks`
/// and `pendingTool` are reset inside `resetTransientSessionState()` — the
/// SAME synchronous call switchSession/createNewSession already make before
/// persisting (see docs/explanation/invariants.md's "macOS Code Assistant
/// panel" section on invariant #3); moving them here does not change that
/// ordering, since @Observable mutations are just as synchronous as @State.
@Observable
final class CodeAssistantAgentState {
    var pendingTool: PendingTool?
    /// Snapshot of recent issues for the active project, refreshed on
    /// panel mount and every ~60s. Bundled into agentContext so the
    /// agent recognises references like "fix the colourful icons issue".
    var recentIssues: [AgentContext.RecentIssue] = []
    /// Captured at the moment the banner appears so Save uses the
    /// prompt+answer that triggered the threshold, not whatever the
    /// user types next.
    var nudgePrompt: String?
    var savingQA = false
    var qaSaveError: String?
    var agentSessionId: String = UUID().uuidString
    var agentIsAutonomous: Bool = false
    var agentStopRequested: Bool = false
    var agentPendingTasks: [AgentTask] = []
    /// Active plan execute session — drives step-by-step progress UI and the
    /// completion Review/Commit card. Cleared when the user dismisses or commits.
    var planExecution: PlanExecutionTracker?

    /// Tracks one saved-plan execute run in the chat UI.
    struct PlanExecutionTracker: Equatable {
        enum Phase: String, Equatable {
            case running
            case finished
            case failed
        }

        var planTitle: String
        var steps: [String]
        var planCardMessageId: UUID
        var phase: Phase = .running
        /// Snapshot kept when execution ends (live `agentPendingTasks` clears on the next turn).
        var lastTasks: [AgentTask] = []

        /// Where the post-execution code review has got to. Separate from
        /// `phase` on purpose: the review is a turn that runs AFTER the
        /// execution tracker has already settled, and `updatePlanExecution`
        /// only touches a `.running` tracker — so the finish card stays up,
        /// unchanged, while its own review streams underneath it.
        enum ReviewPhase: String, Equatable {
            case none
            case running
            case done
        }

        var reviewPhase: ReviewPhase = .none
        /// The review reply, kept so the verdict strip can show the findings
        /// without hunting the transcript for the message again.
        var reviewSummary: String = ""
        /// Parsed from `reviewSummary` by `PlanReviewPolicy.verdict(from:)`.
        var reviewVerdict: PlanReviewVerdict?
        /// The branch the review was taken against ("main"), for wording.
        var reviewBaseBranch: String?

        /// Push is offered once a review has RUN — see
        /// `PlanReviewPolicy.allowsPush(reviewed:)`.
        var hasReviewed: Bool { reviewPhase == .done }

        var totalSteps: Int { max(steps.count, lastTasks.count) }
    }
    /// Per-request project-memory overhead from the last turn, surfaced on the
    /// 🧠 button so the always-on memory block's token cost is visible.
    var lastMemoryTokens: Int?
    var lastMemoryHasChat = false
}
