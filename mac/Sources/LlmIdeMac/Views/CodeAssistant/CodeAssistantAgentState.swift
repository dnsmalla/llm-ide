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
    /// Per-request project-memory overhead from the last turn, surfaced on the
    /// 🧠 button so the always-on memory block's token cost is visible.
    var lastMemoryTokens: Int?
    var lastMemoryHasChat = false
}
