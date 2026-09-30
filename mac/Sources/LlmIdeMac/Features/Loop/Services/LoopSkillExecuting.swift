import Foundation

/// Runs a `.skill` (generate) Loop stage by invoking a chosen central skill as
/// a headless, confined agent run (`LoopAgentRunning` → POST
/// /kb/loop/agent-run) rooted at the run's git root. The server resolves the
/// skill id ("<family>/<dir>") to its SKILL.md and frames it as a trusted
/// instruction; an id it cannot find comes back in `unresolvedSkills` and the
/// agent is not run — the runner fails the stage on that. The stage's
/// `targetPath` is already part of the composed `message`.
protocol LoopSkillExecuting: AnyObject {
    /// - Parameter repoRoot: The git root the run uses — the worktree when the
    ///   run was redirected into one. The agent is confined to it (and to
    ///   `extraRoots`).
    /// - Parameter extraRoots: The project's `llm-doc/` when it lies outside
    ///   `repoRoot` (split layout), so plan/doc skills can reach it.
    /// - Parameter timeout: Wall-clock budget for the agent run; `nil` = the
    ///   server's default.
    func execute(skillId: String, targetPath: String?, message: String,
                 repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult
}

/// Production adapter. Mirrors `AgentLoopStageRepairer`: one confined agent
/// run with `skills: [skillId]`, returning the result — "made no edit" is not
/// an error (the loop's verify stages re-check).
@MainActor
final class AgentLoopSkillExecutor: LoopSkillExecuting {
    private let agent: LoopAgentRunning

    init(agent: LoopAgentRunning) {
        self.agent = agent
    }

    convenience init(api: LlmIdeAPIClient, language: String = "en") {
        self.init(agent: APILoopAgentRunner(api: api, language: language))
    }

    func execute(skillId: String, targetPath: String?, message: String,
                 repoRoot: URL, extraRoots: [URL], timeout: TimeInterval?) async throws -> LoopAgentResult {
        try await agent.run(message: message, skills: skillId.isEmpty ? [] : [skillId],
                            repoRoot: repoRoot, extraRoots: extraRoots, timeout: timeout)
    }
}
