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
    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws
}

/// Production adapter — sends a structured repair instruction through
/// the same code-assist surface the rest of the app uses. The agent has
/// write tools in this deployment, so it can edit the repo directly.
final class AgentFaultRepairer: FaultRepairer {
    private let api: LlmIdeAPIClient
    private let language: String

    init(api: LlmIdeAPIClient, language: String = "en") {
        self.api = api
        self.language = language
    }

    func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws {
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
        _ = try await api.codeAssist(
            message: prompt, language: language, model: nil,
            history: [], attachments: [], agentContext: nil
        )
    }
}
