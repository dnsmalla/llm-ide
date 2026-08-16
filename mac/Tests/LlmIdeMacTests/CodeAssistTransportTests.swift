import Testing
import Foundation
@testable import LlmIdeMacLib

/// Scripts one turn: events are delivered in order; `error` (if set) is
/// thrown after the events. Records the input for assertions.
///
/// Not exercised by the fallback-policy tests below — this is
/// forward-looking test infrastructure for Tasks 4, 11, and 12, which drive
/// a `ChatEngine`/session flow purely off a scripted transport instead of a
/// live server.
@MainActor
final class ScriptedChatTransport: ChatTransport, @unchecked Sendable {
    enum Step: Sendable { case progress(String, String?); case chunk(String) }  // (label, tool)
    var scripted: [Step] = []
    var result = ChatTransportResult(reply: "", pendingTool: nil, tasks: nil,
                                     continueNeeded: nil, usage: nil, mode: nil)
    var thrownError: Error?
    private(set) var receivedInputs: [ChatTransportInput] = []
    private(set) var progressCountWithSideEffects = 0

    func roundTrip(_ input: ChatTransportInput,
                   onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
                   onChunk: @escaping @MainActor (String) -> Void) async throws -> ChatTransportResult {
        receivedInputs.append(input)
        for step in scripted {
            switch step {
            case .progress(let label, let tool):
                onProgress(.init(label: label, phase: "tool", tool: tool, detail: nil))
            case .chunk(let text): onChunk(text)
            }
        }
        if let e = thrownError { throw e }
        return result
    }
}

@Suite("CodeAssistTransport fallback policy")
struct CodeAssistTransportTests {
    @Test("makeProvider passes custom:uuid verbatim")
    func customProvider() {
        #expect(ChatTransportInput.makeProvider(selectedProvider: "custom:ABC-123") == "custom:ABC-123")
    }

    @Test("makeProvider maps a built-in tool id to its provider string")
    func builtinProvider() {
        let p = ChatTransportInput.makeProvider(selectedProvider: AICliTool.claudeCode.rawValue)
        #expect(p == AICliTool.claudeCode.provider)
    }

    @Test("Fallback policy: .http with no progress → retry buffered; anything else → rethrow")
    func fallbackPolicy() {
        #expect(CodeAssistTransport.shouldFallbackBuffered(error: APIError.http(status: 502, code: "BAD", message: "x", details: nil),
                                                           sawProgress: false) == true)
        #expect(CodeAssistTransport.shouldFallbackBuffered(error: APIError.http(status: 502, code: "BAD", message: "x", details: nil),
                                                           sawProgress: true) == false)
        #expect(CodeAssistTransport.shouldFallbackBuffered(error: APIError.agent(message: "server agent error"),
                                                           sawProgress: false) == false)
    }
}
