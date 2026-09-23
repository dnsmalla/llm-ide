import Testing
import Foundation
@testable import LlmIdeMacLib

/// The orphaned-turn recovery in `agentV2Stream`: when a send keeps getting
/// TURN_IN_PROGRESS while the app's own chat is idle, it cancels that chat's
/// server-side turn (POST /agent/v2/cancel) — which needs the chat id out of
/// the untyped request body.
@Suite("agent/v2 orphaned turn lock")
struct AgentV2OrphanLockTests {
    @Test("The chat id is read from agentContext.chatSessionId")
    func readsChatId() {
        let body: [String: Any] = ["message": "hi", "agentContext": ["chatSessionId": "C-1", "workspaceRoot": "/w"]]
        #expect(LlmIdeAPIClient.chatSessionId(inAgentV2Body: body) == "C-1")
    }

    @Test("No usable chat id → no cancel attempted")
    func noChatId() {
        #expect(LlmIdeAPIClient.chatSessionId(inAgentV2Body: ["message": "hi"]) == nil)
        #expect(LlmIdeAPIClient.chatSessionId(inAgentV2Body: ["agentContext": ["chatSessionId": ""]]) == nil)
        #expect(LlmIdeAPIClient.chatSessionId(inAgentV2Body: ["agentContext": "nope"]) == nil)
    }
}
