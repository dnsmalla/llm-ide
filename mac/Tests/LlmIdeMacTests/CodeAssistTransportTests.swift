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
                                     continueNeeded: nil, usage: nil, mode: nil, tokenUsage: nil)
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
        // Regression: a 4xx is the server refusing THIS request — re-POSTing
        // it burned another rate-limit token on 429 and failed again on 400.
        for status in [400, 401, 403, 409, 413, 429] {
            #expect(CodeAssistTransport.shouldFallbackBuffered(
                error: APIError.http(status: status, code: "X", message: "x", details: nil),
                sawProgress: false) == false, "\(status)")
        }
        #expect(CodeAssistTransport.shouldFallbackBuffered(
            error: APIError.http(status: 0, code: "NO_RESPONSE", message: "x", details: nil),
            sawProgress: false) == true)
    }

    @Test("A refused stream surfaces the server's own error, redacted")
    func serverErrorFromBody() {
        let structured = Data(#"{"error":{"code":"SLASH_COMMAND_FAILED","message":"unknown command /foo"}}"#.utf8)
        let e = LlmIdeAPIClient.serverError(fromBody: structured)
        #expect(e?.code == "SLASH_COMMAND_FAILED")
        #expect(e?.message == "unknown command /foo")
        let flat = LlmIdeAPIClient.serverError(fromBody: Data(#"{"error":"nope"}"#.utf8))
        #expect(flat?.code == nil && flat?.message == "nope")
        #expect(LlmIdeAPIClient.serverError(fromBody: Data("<html>".utf8)) == nil)
        let secret = LlmIdeAPIClient.serverError(
            fromBody: Data(#"{"error":{"message":"bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789"}}"#.utf8))
        #expect(secret?.message.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789") == false)
    }

    @Test("planWrite rides the legacy request only when set")
    func planWriteEncoded() throws {
        func body(_ planWrite: Bool?) throws -> [String: Any] {
            var req = LlmIdeAPIClient.CodeAssistRequest(
                message: "m", language: nil, model: nil, provider: nil, tier: nil,
                history: [], attachments: [], skills: [], agentContext: nil, mode: nil,
                planExecute: nil)
            req.planWrite = planWrite
            let data = try JSONEncoder().encode(req)
            return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        }
        // Regression: the field didn't exist, so "Write full plan" in a legacy
        // chat re-ran stage-1 discovery.
        #expect(try body(true)["planWrite"] as? Bool == true)
        #expect(try body(nil)["planWrite"] == nil)
    }
}
