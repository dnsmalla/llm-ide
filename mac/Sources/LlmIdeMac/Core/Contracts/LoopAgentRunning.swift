import Foundation

/// What one headless, confined Loop agent run did (`POST /kb/loop/agent-run`).
///
/// The server runs the agent NON-INTERACTIVELY with file read/search/edit/write
/// tools only, rooted at `repoRoot` — no shell, no network, and a tool that
/// would need approval is denied rather than parked. The Loop verifies the
/// result by running its own stages.
///
/// Lives in `Core/Contracts` because three callers in two layers need it: the
/// Loop's skill executor and stage repairer (`Features/Loop`) and the fault
/// repairer (`Core/Verification`) — a feature-local type would be a
/// Core → Feature edge.
struct LoopAgentResult: Equatable, Sendable {
    struct Usage: Codable, Equatable, Sendable {
        var inputTokens: Int?
        var outputTokens: Int?
        var cacheReadTokens: Int?
        var cacheCreationTokens: Int?
        var costUsd: Double?
        var numTurns: Int?
        var durationMs: Int?
    }

    /// A tool call the confinement refused (outside the root, a shell tool, …).
    struct Denial: Codable, Equatable, Sendable {
        let toolName: String
        let reason: String
    }

    /// The agent's final text — kept (not discarded) so a later attempt can be
    /// told what the previous one said it did.
    var reply: String
    /// Files the agent edited, relative to `repoRoot`.
    var changedPaths: [String]
    var usage: Usage?
    var resolvedSkills: [String]
    /// Skill ids the server could not find. Non-empty means the server did
    /// NOT run the agent (`ran == false`).
    var unresolvedSkills: [String]
    var truncatedSkills: [String]
    var ran: Bool
    /// The SDK's result subtype ("success", "error_max_turns", …), nil when
    /// the agent never ran.
    var resultSubtype: String?
    var denied: [Denial]

    init(reply: String = "", changedPaths: [String] = [], usage: Usage? = nil,
         resolvedSkills: [String] = [], unresolvedSkills: [String] = [],
         truncatedSkills: [String] = [], ran: Bool = true,
         resultSubtype: String? = "success", denied: [Denial] = []) {
        self.reply = reply
        self.changedPaths = changedPaths
        self.usage = usage
        self.resolvedSkills = resolvedSkills
        self.unresolvedSkills = unresolvedSkills
        self.truncatedSkills = truncatedSkills
        self.ran = ran
        self.resultSubtype = resultSubtype
        self.denied = denied
    }
}

/// Runs one headless, confined agent step rooted at `repoRoot`.
///
/// `repoRoot` is the directory the agent may edit — for a Loop run, the git
/// root the run actually uses (the WORKTREE when the run was redirected into
/// one), never the prompt text alone. Throws on transport / server failure;
/// "made no edit" is not an error.
protocol LoopAgentRunning: AnyObject {
    /// - Parameter timeout: Wall-clock budget for the run; `nil` = the
    ///   server's default (30 min).
    func run(message: String, skills: [String], repoRoot: URL,
             timeout: TimeInterval?) async throws -> LoopAgentResult
}
