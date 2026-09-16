// Repair is a multi-file code edit, so the production adapter uses the
// FULL chat model, not the sub-model tier (mirrors AgentFaultRepairer).

import Foundation

/// What the loop learned from the previous repair attempt on this stage.
///
/// A loop that hands the agent the same failure output every iteration invites
/// the same failed fix every iteration — the agent has no way to know its last
/// edit did nothing, because nothing tells it. Passing the measured effect of
/// the previous attempt is what turns a retry into an iteration: the agent is
/// asked to account for evidence rather than to guess again.
struct RepairEvidence: Equatable {
    /// 1-based attempt number for this stage within this run.
    let attempt: Int
    /// Failing count before the previous repair, when the runner's output was
    /// recognised by `StageOutputParser`.
    let previousScore: Int?
    /// Failing count now.
    let currentScore: Int?
    /// False when this failure is no better than the previous one.
    let improved: Bool
    /// Consecutive non-improving attempts, counting this one.
    let streak: Int
}

/// Attempts to fix a failing Loop Engineering stage. Generalizes
/// `FaultRepairer` (which is tied to a single `FaultReport`) to an
/// arbitrary named stage + command + failure output.
protocol LoopStageRepairer: AnyObject {
    /// Attempt to fix the stage named `stageName`, given the failing output.
    /// Returns when the agent has finished editing (or made no change).
    /// Throws only on transport/CLI failure — "made no edit" is not an
    /// error (the caller re-verifies to decide the verdict).
    ///
    /// - Parameter evidence: What the previous attempt on this stage achieved,
    ///   or `nil` on the first attempt.
    func repair(stageName: String, command: String?, failureOutput: String,
                evidence: RepairEvidence?, repoRoot: URL) async throws
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

    static let maxFailureOutputChars = 4_000

    /// Builds the repair prompt. Factored out as a `static func` (unlike
    /// `AgentFaultRepairer`, which inlines its prompt) so it is
    /// unit-testable without a network call.
    static func buildPrompt(stageName: String, command: String?, failureOutput: String,
                            repoRoot: URL, evidence: RepairEvidence? = nil) -> String {
        let commandLine = command.map { "Command: \($0)\n" } ?? ""
        return """
        The "\(stageName)" stage of an automated verify-and-repair loop is failing in the codebase at \(repoRoot.path).

        \(commandLine)Failure output:
        \(String(failureOutput.suffix(maxFailureOutputChars)))
        \(evidenceBlock(evidence))
        Edit the code so this stage passes. Make the minimal change required.
        Do not modify the stage command, weaken or delete tests/assertions, or skip cases to make it pass.
        Edits to test files, build configuration, and the project's system/ directory are reverted \
        automatically and will not make the stage pass.
        """
    }

    /// The evidence paragraph, or "" on a first attempt. Built separately so the
    /// wording for each case is visible in one place and directly testable.
    private static func evidenceBlock(_ evidence: RepairEvidence?) -> String {
        guard let evidence else { return "" }
        var lines = ["", "This is attempt \(evidence.attempt) for this stage in this run."]

        if let previous = evidence.previousScore, let current = evidence.currentScore {
            if current < previous {
                lines.append("Your last change reduced the failure count from \(previous) to \(current) — "
                             + "it helped. Continue in the same direction for the remaining failures.")
            } else if current == previous {
                lines.append("The failure count is unchanged at \(current) after your last change — "
                             + "that change did not work. Do not repeat it; find a different root cause.")
            } else {
                lines.append("The failure count rose from \(previous) to \(current) after your last change — "
                             + "it made things worse. Reconsider that edit before adding another.")
            }
        } else if !evidence.improved {
            lines.append("The failure is identical to the previous attempt — your last change had no effect. "
                         + "Do not repeat it; find a different root cause.")
        }

        if evidence.streak >= 2 {
            lines.append("\(evidence.streak) consecutive attempts have not improved this stage. "
                         + "State the root cause explicitly before editing, rather than adjusting the same code again.")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    func repair(stageName: String, command: String?, failureOutput: String,
                evidence: RepairEvidence?, repoRoot: URL) async throws {
        let prompt = Self.buildPrompt(stageName: stageName, command: command,
                                       failureOutput: failureOutput, repoRoot: repoRoot,
                                       evidence: evidence)
        _ = try await api.codeAssist(
            message: prompt, language: language, model: nil,
            history: [], attachments: [], agentContext: nil
        )
    }
}
