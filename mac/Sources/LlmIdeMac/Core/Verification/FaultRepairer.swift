// Drives the agent (with write access) to fix a confirmed regression.
// The repairer edits the working tree in place; the resulting diff is
// read separately from git by the caller. Repair is a multi-file code
// edit, so the production adapter uses the FULL chat model, not the
// sub-model tier.

import Foundation

protocol FaultRepairer: AnyObject {
    /// Attempt to fix `fault`, given the failing verify output. Returns
    /// when the agent has finished editing (or made no change). Throws
    /// only on transport/CLI failure — "made no edit" is not an error
    /// (the caller re-verifies to decide the verdict).
    ///
    /// Returns the agent run's result (reply, changed paths, …) so a caller
    /// can keep what the agent said it did.
    @discardableResult
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws -> LoopAgentResult
}

/// Production adapter — sends a structured repair instruction as a headless,
/// confined agent run (`LoopAgentRunning` → POST /kb/loop/agent-run) rooted
/// at `repoRoot`, so the agent can actually edit files there (and only there).
/// It used to go through `/code-assist` with no agent context, which the
/// server answers with no tools at all — no repair could edit anything.
final class AgentFaultRepairer: FaultRepairer {
    private let agent: LoopAgentRunning

    init(agent: LoopAgentRunning) {
        self.agent = agent
    }

    convenience init(api: LlmIdeAPIClient, language: String = "en") {
        self.init(agent: APILoopAgentRunner(api: api, language: language))
    }

    @discardableResult
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws -> LoopAgentResult {
        let prompt = """
        A previously-fixed fault has regressed. Fix it in the codebase at \(repoRoot.path).

        Original fault:
        \(fault.prompt)

        What the fix looked like when it was last working:
        \(String(fault.response.prefix(4_000)))

        The verify command now FAILS with this output:
        \(String(failureOutput.prefix(4_000)))

        Edit the code so the verify command passes again. Make the minimal
        change required. Do not modify the verify command itself.
        """
        return try await agent.run(message: prompt, skills: [], repoRoot: repoRoot, timeout: nil)
    }
}
