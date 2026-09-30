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
    /// - Parameter timeout: Wall-clock budget for the agent run; `nil` = the
    ///   server's default.
    @discardableResult
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL,
                timeout: TimeInterval?) async throws -> LoopAgentResult

    /// Same, on a chosen model (`nil` = the app's default). Defaults to the
    /// model-less call for conformers that predate model tiers.
    @discardableResult
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL,
                timeout: TimeInterval?, model: String?) async throws -> LoopAgentResult
}

extension FaultRepairer {
    @discardableResult
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL,
                timeout: TimeInterval?, model: String?) async throws -> LoopAgentResult {
        try await repair(fault: fault, failureOutput: failureOutput, repoRoot: repoRoot, timeout: timeout)
    }
}

/// Wraps one fault repair so the caller can check what it changed.
///
/// `RegressionRunner` hands the guard the repo root and the repair to run; the
/// guard runs it (it may retry it, snapshot the tree around it, revert what it
/// touched) and returns `true` to keep the repair — the fault is then
/// re-verified — or `false` when it rejected the repair, in which case the
/// fault is recorded `.repairFailed` WITHOUT re-verifying (a re-verify after a
/// rejected edit to a test would observe the pass the edit bought). Errors
/// from the repair propagate. A closure, not a Loop type, because Core must
/// never import a feature: the Loop's protected-path guard is passed in.
///
/// The guard calls `repair` with the agent-run timeout it allows (the Loop
/// bounds it by the stage timeout and the run's remaining time budget) and
/// gets back the agent's result — its reported changed paths are part of
/// what the guard checks.
typealias FaultRepairGuard = @MainActor (
    _ repoRoot: URL,
    _ repair: (_ timeout: TimeInterval?) async throws -> LoopAgentResult
) async throws -> Bool

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
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL,
                timeout: TimeInterval?) async throws -> LoopAgentResult {
        try await repair(fault: fault, failureOutput: failureOutput, repoRoot: repoRoot,
                         timeout: timeout, model: nil)
    }

    @discardableResult
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL,
                timeout: TimeInterval?, model: String?) async throws -> LoopAgentResult {
        let prompt = """
        A previously-fixed fault has regressed. Fix it in the codebase at \(repoRoot.path).

        Original fault:
        \(fault.prompt)

        What the fix looked like when it was last working:
        \(String(fault.response.prefix(4_000)))

        The verify command now FAILS with this output:
        \(TestFailureExtractor.repairExcerpt(failureOutput, budget: 12_000))

        Edit the code so the verify command passes again. Make the minimal
        change required. Do not modify the verify command itself.
        """
        return try await agent.run(message: prompt, skills: [], repoRoot: repoRoot, extraRoots: [],
                                   timeout: timeout, model: model)
    }
}
