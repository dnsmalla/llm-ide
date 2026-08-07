// Attempts to fix a failing Loop Engineering stage. Generalizes
// FaultRepairer (which is tied to a single FaultReport) to an arbitrary
// named stage + command + failure output, so it can drive repair for any
// LoopStage (regression sweep or user-added shell command) rather than
// only the fixed regression-fault flow.

import Foundation

/// Attempts to fix a failing Loop Engineering stage. Generalizes
/// `FaultRepairer` (which is tied to a single `FaultReport`) to an
/// arbitrary named stage + command + failure output.
protocol LoopStageRepairer: AnyObject {
    /// Attempt to fix the stage named `stageName`, given the failing output.
    /// Returns when the agent has finished editing (or made no change).
    /// Throws only on transport/CLI failure — "made no edit" is not an
    /// error (the caller re-verifies to decide the verdict).
    func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws
}

/// Production adapter — same `api.codeAssist` transport `AgentFaultRepairer`
/// uses; the agent has write tools in this deployment and edits the working
/// tree directly.
final class AgentLoopStageRepairer: LoopStageRepairer {
    private let api: LlmIdeAPIClient
    private let language: String

    init(api: LlmIdeAPIClient, language: String = "en") {
        self.api = api
        self.language = language
    }

    private static let maxFailureOutputChars = 4_000

    /// Builds the repair prompt. Factored out as a `static func` (unlike
    /// `AgentFaultRepairer`, which inlines its prompt) so it is
    /// unit-testable without a network call.
    static func buildPrompt(stageName: String, command: String?, failureOutput: String, repoRoot: URL) -> String {
        let commandLine = command.map { "Command: \($0)\n" } ?? ""
        return """
        The "\(stageName)" stage of a Loop Engineering run is failing in the codebase at \(repoRoot.path).

        \(commandLine)Failure output:
        \(String(failureOutput.prefix(maxFailureOutputChars)))

        Edit the code so this stage passes. Make the minimal change required.
        """
    }

    func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws {
        let prompt = Self.buildPrompt(stageName: stageName, command: command,
                                       failureOutput: failureOutput, repoRoot: repoRoot)
        _ = try await api.codeAssist(
            message: prompt, language: language, model: nil,
            history: [], attachments: [], agentContext: nil
        )
    }
}
