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

    @Test("the chat's total sums every reply, weighted exactly like the replies' own labels")
    func sessionTotal() {
        let a = AgentV2Usage(inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000,
                             cacheCreationTokens: 800, contextPercent: nil)
        let b = AgentV2Usage(inputTokens: 300, outputTokens: 50, cacheReadTokens: 0,
                             cacheCreationTokens: nil, contextPercent: nil)
        let total = AgentV2Usage.total([a, b])
        #expect(total == AgentV2Usage(inputTokens: 1300, outputTokens: 250, cacheReadTokens: 4000,
                                      cacheCreationTokens: 800, contextPercent: nil))
        #expect(total?.billableTokens == a.billableTokens + b.billableTokens)
        #expect(AgentV2Usage.total([]) == nil)

        let engine = ChatEngine(scope: .explorer, transport: ScriptedChatTransport())
        func reply(_ u: AgentV2Usage?) -> ChatMessage {
            var m = ChatMessage(role: .assistant, content: "r", status: .done, createdAt: Date())
            if let u { m.metadata = ChatMessage.Metadata(tokenUsage: u) }
            return m
        }
        let user = ChatMessage(role: .user, content: "q", status: .done, createdAt: Date())
        engine.messages = [user, reply(a), user, reply(nil), user, reply(b)]   // a turn with no token data is skipped
        #expect(engine.sessionTokenUsage == total)
        engine.messages = [user, reply(nil)]
        #expect(engine.sessionTokenUsage == nil)
    }
}
