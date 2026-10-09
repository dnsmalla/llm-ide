import Testing
import Foundation
@testable import LlmIdeMacLib

/// Classic-engine (GLM / DeepSeek / Custom) turns report their summed model
/// tokens in `usage` (server API v72). They get the same per-reply label and
/// the composer's token chip that Agent-engine turns already had.
@MainActor
@Suite("Classic turn tokens")
struct ClassicTurnTokensTests {
    @Test("v72 usage decodes to a turn total; an older server's usage decodes to none")
    func decode() throws {
        let v72 = #"{"attachmentCount":0,"attachmentChars":0,"paths":[],"inputTokens":1200,"outputTokens":80,"cacheReadTokens":900,"modelCalls":3}"#
        let usage = try JSONDecoder().decode(LlmIdeAPIClient.CodeAssistResponse.Usage.self, from: Data(v72.utf8))
        #expect(usage.turnTokenUsage == AgentV2Usage(inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900,
                                                     cacheCreationTokens: nil, contextPercent: nil))
        #expect(usage.modelCalls == 3)

        let old = #"{"attachmentCount":0,"attachmentChars":0,"paths":[],"memoryApproxTokens":0}"#
        let oldUsage = try JSONDecoder().decode(LlmIdeAPIClient.CodeAssistResponse.Usage.self, from: Data(old.utf8))
        #expect(oldUsage.turnTokenUsage == nil)
    }

    @Test("a classic turn labels its reply and feeds the composer chip")
    func engineKeepsClassicTokens() async throws {
        let t = ScriptedChatTransport()
        let engine = ChatEngine(scope: .explorer, transport: t)
        engine.hooks.resolveTransportInput = { msg, history, _, skills in
            ChatTransportInput(message: msg, history: history, attachments: [], skills: skills,
                               agentContext: nil, language: "en", model: nil, provider: "deepseek", mode: "auto")
        }
        let json = #"{"attachmentCount":0,"attachmentChars":0,"paths":[],"inputTokens":500,"outputTokens":40}"#
        let usage = try JSONDecoder().decode(LlmIdeAPIClient.CodeAssistResponse.Usage.self, from: Data(json.utf8))
        t.result = .init(reply: "hi", pendingTool: nil, tasks: nil, continueNeeded: nil,
                         usage: usage, mode: nil, tokenUsage: nil)

        await engine.runTurn("hello")

        #expect(engine.messages.last?.metadata?.tokenUsage?.inputTokens == 500)
        #expect(engine.lastTurnTokenUsage?.outputTokens == 40)
        #expect(engine.lastContextUsage == nil, "classic turns have no context meter")
    }
}
