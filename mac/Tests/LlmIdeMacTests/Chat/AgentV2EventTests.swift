import Testing
import Foundation
@testable import LlmIdeMacLib

/// Wire fixtures for `AgentV2Event.decode(fromJSON:)`.  Every JSON literal
/// is copied field-for-field from what the server actually emits: the SDK
/// message mapper (extension/llm_agent/sdk/events.mjs) for init/delta/
/// tool_*/usage/result/sdk, the engine (sdk/engine.mjs) for the approval
/// pair, and the route (routes/agent-v2.mjs) for mode_set/error.  The keys
/// are camelCase on the wire — `sessionId`, `costUsd`, `partialJson`, … —
/// NOT snake_case.
@Suite("AgentV2Event decode")
struct AgentV2EventTests {

    private func decode(_ json: String) -> AgentV2Event? {
        AgentV2Event.decode(fromJSON: Data(json.utf8))
    }

    // --- init -------------------------------------------------------------

    @Test("init decodes all fields")
    func initFull() {
        let evt = decode(#"""
        {"type":"init","sessionId":"sdk-1","claudeCodeVersion":"2.1.207","model":"claude-sonnet-4-5","tools":["read-file","web-search"],"capabilities":["skills"],"mcpServers":[{"name":"llmide","status":"connected"}]}
        """#)
        #expect(evt == .init_(AgentV2Init(
            sessionId: "sdk-1",
            claudeCodeVersion: "2.1.207",
            model: "claude-sonnet-4-5",
            tools: ["read-file", "web-search"],
            capabilities: ["skills"],
            mcpServers: [AgentV2McpServer(name: "llmide", status: "connected")],
        )))
    }

    @Test("init with nulls and empty arrays (events.mjs ?? null emissions)")
    func initNulls() {
        let evt = decode(#"""
        {"type":"init","sessionId":null,"claudeCodeVersion":null,"model":null,"tools":[],"capabilities":[],"mcpServers":[]}
        """#)
        #expect(evt == .init_(AgentV2Init(
            sessionId: nil, claudeCodeVersion: nil, model: nil,
            tools: [], capabilities: [], mcpServers: [],
        )))
    }

    /// Spec §4 forward-compatibility rule: unknown fields are ignored, so a
    /// newer server can add fields without breaking this client.
    @Test("unknown fields are ignored")
    func unknownFieldsIgnored() {
        let evt = decode(#"""
        {"type":"delta","text":"hi","futureField":123}
        """#)
        #expect(evt == .delta("hi"))
    }

    // --- delta / tool stream -----------------------------------------------

    @Test("delta decodes text")
    func delta() {
        #expect(decode(#"{"type":"delta","text":"Hello"}"#) == .delta("Hello"))
    }

    @Test("tool_use_start decodes id and name")
    func toolUseStart() {
        #expect(decode(#"{"type":"tool_use_start","id":"tu_1","name":"read-file"}"#)
                == .toolUseStart(id: "tu_1", name: "read-file"))
    }

    @Test("tool_use_start tolerates null id/name (block.id ?? null)")
    func toolUseStartNulls() {
        #expect(decode(#"{"type":"tool_use_start","id":null,"name":null}"#)
                == .toolUseStart(id: nil, name: nil))
    }

    @Test("tool_args_delta decodes index + partialJson")
    func toolArgsDelta() {
        #expect(decode(#"{"type":"tool_args_delta","index":2,"partialJson":"{\"path\":\"a"}"#)
                == .toolArgsDelta(index: 2, partialJson: "{\"path\":\"a"))
    }

    @Test("tool_result decodes success and error/truncated shapes")
    func toolResult() {
        #expect(decode(#"{"type":"tool_result","toolUseId":"tu_1","isError":false,"text":"file contents","truncated":false}"#)
                == .toolResult(AgentV2ToolResult(toolUseId: "tu_1", isError: false,
                                                 text: "file contents", truncated: false)))
        #expect(decode(#"{"type":"tool_result","toolUseId":"tu_2","isError":true,"text":"boom","truncated":true}"#)
                == .toolResult(AgentV2ToolResult(toolUseId: "tu_2", isError: true,
                                                 text: "boom", truncated: true)))
    }

    // --- usage --------------------------------------------------------------

    @Test("usage decodes with contextPercent (spec §4 shape)")
    func usageWithPercent() {
        #expect(decode(#"{"type":"usage","inputTokens":100,"outputTokens":50,"cacheReadTokens":10,"contextPercent":42.5}"#)
                == .usage(AgentV2Usage(inputTokens: 100, outputTokens: 50,
                                       cacheReadTokens: 10, contextPercent: 42.5)))
    }

    /// events.mjs does not emit contextPercent yet (the spec table reserves
    /// it) — the field must be optional so today's stream still decodes.
    @Test("usage decodes without contextPercent (current events.mjs output)")
    func usageWithoutPercent() {
        #expect(decode(#"{"type":"usage","inputTokens":7,"outputTokens":3,"cacheReadTokens":0}"#)
                == .usage(AgentV2Usage(inputTokens: 7, outputTokens: 3,
                                       cacheReadTokens: 0, contextPercent: nil)))
    }

    // --- approvals ------------------------------------------------------------

    @Test("approval_request decodes the pinned AskUserQuestion shape")
    func approvalRequest() {
        let evt = decode(#"""
        {"type":"approval_request","requestId":"r1","kind":"AskUserQuestion","questions":[{"question":"Pick?","header":"Pick","options":[{"label":"A","description":"aye"}],"multiSelect":false}]}
        """#)
        #expect(evt == .approvalRequest(AgentV2Approval(
            requestId: "r1",
            kind: "AskUserQuestion",
            questions: [AgentV2ApprovalQuestion(
                question: "Pick?", header: "Pick",
                options: [AgentV2ApprovalOption(label: "A", description: "aye")],
                multiSelect: false)],
        )))
    }

    @Test("approval_request tolerates missing header/description")
    func approvalRequestSparse() {
        let evt = decode(#"""
        {"type":"approval_request","requestId":"r2","kind":"AskUserQuestion","questions":[{"question":"Q?","header":null,"options":[{"label":"B","description":null}],"multiSelect":true}]}
        """#)
        #expect(evt == .approvalRequest(AgentV2Approval(
            requestId: "r2",
            kind: "AskUserQuestion",
            questions: [AgentV2ApprovalQuestion(
                question: "Q?", header: nil,
                options: [AgentV2ApprovalOption(label: "B", description: nil)],
                multiSelect: true)],
        )))
    }

    @Test("approval_resolved decodes requestId + outcome")
    func approvalResolved() {
        #expect(decode(#"{"type":"approval_resolved","requestId":"r1","outcome":"answer"}"#)
                == .approvalResolved(requestId: "r1", outcome: "answer"))
    }

    // --- tasks / tasks_progress ---------------------------------------------

    @Test("tasks decodes the list plus continueNeeded")
    func tasksTerminal() {
        #expect(decode(#"{"type":"tasks","tasks":[{"id":"1","title":"Add the scheme","status":"completed"}],"continueNeeded":true}"#)
                == .tasks(tasks: [AgentTask(id: "1", title: "Add the scheme", status: .completed)],
                          continueNeeded: true))
    }

    @Test("tasks_progress decodes the list; it carries no continueNeeded")
    func tasksProgress() {
        #expect(decode(#"{"type":"tasks_progress","tasks":[{"id":"1","title":"Add the scheme","status":"completed"},{"id":"2","title":"Wire the test target","status":"in_progress"}]}"#)
                == .tasksProgress([
                    AgentTask(id: "1", title: "Add the scheme", status: .completed),
                    AgentTask(id: "2", title: "Wire the test target", status: .inProgress),
                ]))
    }

    // --- mode_set / result / error / sdk ------------------------------------

    @Test("mode_set decodes the resolved mode")
    func modeSet() {
        #expect(decode(#"{"type":"mode_set","mode":"plan"}"#) == .modeSet("plan"))
    }

    @Test("result decodes all fields")
    func resultFull() {
        #expect(decode(#"{"type":"result","subtype":"success","costUsd":0.12,"numTurns":3,"durationMs":4500,"sessionId":"sdk-1","stopReason":"end_turn"}"#)
                == .result(AgentV2Result(subtype: "success", costUsd: 0.12, numTurns: 3,
                                         durationMs: 4500, sessionId: "sdk-1",
                                         stopReason: "end_turn")))
    }

    @Test("result tolerates nulls (events.mjs ?? null emissions)")
    func resultNulls() {
        #expect(decode(#"{"type":"result","subtype":null,"costUsd":null,"numTurns":null,"durationMs":null,"sessionId":null,"stopReason":null}"#)
                == .result(AgentV2Result(subtype: nil, costUsd: nil, numTurns: nil,
                                         durationMs: nil, sessionId: nil, stopReason: nil)))
    }

    @Test("error decodes code + message")
    func errorEvent() {
        #expect(decode(#"{"type":"error","code":"ENGINE_ERROR","message":"boom"}"#)
                == .error(code: "ENGINE_ERROR", message: "boom"))
    }

    /// The route's SESSION_UNRESUMABLE error carries a `retryable` flag this
    /// model doesn't model yet — extra fields must not break the decode.
    @Test("error tolerates the route's retryable field")
    func errorWithRetryable() {
        #expect(decode(#"{"type":"error","code":"SESSION_UNRESUMABLE","message":"gone","retryable":true}"#)
                == .error(code: "SESSION_UNRESUMABLE", message: "gone"))
    }

    @Test("sdk passthrough carries the upstream sdkType")
    func sdkPassthrough() {
        #expect(decode(#"{"type":"sdk","sdkType":"compact_boundary","subtype":null,"raw":{"anything":1}}"#)
                == .sdk("compact_boundary"))
        #expect(decode(#"{"type":"sdk","sdkType":null,"subtype":null,"raw":{}}"#)
                == .sdk(nil))
    }

    // --- forward compatibility / robustness ---------------------------------

    @Test("unknown event type decodes to .sdk(rawTypeString)")
    func unknownType() {
        #expect(decode(#"{"type":"brand_new_thing","payload":123}"#) == .sdk("brand_new_thing"))
    }

    @Test("malformed JSON returns nil")
    func malformed() {
        #expect(decode(#"{"type":"delta""#) == nil)
        #expect(decode("not json at all") == nil)
    }

    @Test("empty data returns nil")
    func emptyData() {
        #expect(AgentV2Event.decode(fromJSON: Data()) == nil)
        #expect(decode("") == nil)
    }

    @Test("known type with missing/invalid fields returns nil")
    func knownTypeDecodeFailures() {
        #expect(decode(#"{"type":"delta"}"#) == nil)                       // missing text
        #expect(decode(#"{"type":"tool_args_delta","partialJson":"x"}"#) == nil) // missing index
        #expect(decode(#"{"type":"result","costUsd":"high"}"#) == nil)     // type mismatch
        #expect(decode(#"{"type":"approval_request"}"#) == nil)            // missing payload
        #expect(decode(#"{"type":"mode_set"}"#) == nil)                    // missing mode
        #expect(decode(#"{"type":"error","code":"E"}"#) == nil)            // missing message
    }

    @Test("object without a type key returns nil")
    func noTypeKey() {
        #expect(decode(#"{"foo":1}"#) == nil)
    }
}
