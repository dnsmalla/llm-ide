import Foundation

/// Runs a `.skill` (generate) Loop stage by invoking a chosen central skill
/// via the same one-shot agent path `AgentLoopStageRepairer` and the chat "/"
/// menu use (`LlmIdeAPIClient.codeAssist` → POST /code-assist). The server
/// resolves the skill id ("<family>/<dir>") to its SKILL.md and frames it as a
/// trusted instruction. A skill stage has no pass/fail of its own — it always
/// "completes" (or throws on a transport error, which the runner logs without
/// ending the run); the loop's verify stages gate termination.
protocol LoopSkillExecuting: AnyObject {
    func execute(skillId: String, targetPath: String?, message: String) async throws
}

/// Production adapter. Mirrors `AgentLoopStageRepairer`: holds the API client
/// + language, calls `codeAssist` with `skills: [skillId]`, and discards the
/// reply — "made no edit" is not an error (the caller re-verifies via the loop).
@MainActor
final class AgentLoopSkillExecutor: LoopSkillExecuting {
    private let api: LlmIdeAPIClient
    private let language: String

    init(api: LlmIdeAPIClient, language: String = "en") {
        self.api = api
        self.language = language
    }

    func execute(skillId: String, targetPath: String?, message: String) async throws {
        _ = try await api.codeAssist(
            message: message, language: language, model: nil,
            history: [], attachments: [], skills: [skillId], agentContext: nil)
    }
}
