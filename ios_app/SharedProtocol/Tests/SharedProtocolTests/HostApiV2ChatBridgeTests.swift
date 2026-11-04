import Testing
import Foundation
import SharedProtocol

@Suite("HostApiV2ChatBridge")
struct HostApiV2ChatBridgeTests {
    private let enc: JSONEncoder = { let e = JSONEncoder(); e.outputFormatting = .sortedKeys; return e }()
    private func json(_ d: Data) -> [String: Any] { try! JSONSerialization.jsonObject(with: d) as! [String: Any] }
    private func inbound<T: Encodable>(_ v: T, type: String) throws -> [HostEvent] {
        let d = try enc.encode(v)
        return HostApiV2ChatBridge.inbound(type: type, json: json(d), data: d)
    }
    /// Every v1 event the bridge emits must be a valid v1 event frame.
    private func assertValid(_ events: [HostEvent]) throws {
        for case .event(let name, let payload, let replyTo) in events {
            let value = try JSONDecoder().decode(HostApiJSONValue.self, from: payload)
            _ = try HostApiFrame.event(name.rawValue, payload: value, rev: 1, replyTo: replyTo)
        }
    }

    @Test("outbound v2 frames are byte-identical to what LlmIdeChatStore sent before")
    func outboundBytes() throws {
        let send = try enc.encode(HostApiChatSendRequest(attachments: [.init(name: "a.md", text: "x")], text: "hi"))
        #expect(try HostApiV2ChatBridge.outbound(.chatSend, payload: send, id: "u-1", cancelTarget: nil)
                == enc.encode(LlmIdeChat(commandId: "u-1", text: "hi", files: [ChatFileText(name: "a.md", text: "x")])))
        let plain = try enc.encode(HostApiChatSendRequest(text: "hi"))
        #expect(try HostApiV2ChatBridge.outbound(.chatSend, payload: plain, id: "u-2", cancelTarget: nil)
                == enc.encode(LlmIdeChat(commandId: "u-2", text: "hi", files: [])))
        #expect(try HostApiV2ChatBridge.outbound(.chatCancel, payload: enc.encode(HostApiChatCancelRequest()), id: "x", cancelTarget: "u-1")
                == enc.encode(LlmIdeCancel(commandId: "u-1")))
        #expect(try HostApiV2ChatBridge.outbound(.chatCancel, payload: enc.encode(HostApiChatCancelRequest()), id: "x", cancelTarget: nil) == nil)
        #expect(try HostApiV2ChatBridge.outbound(.chatSnapshot, payload: enc.encode(HostApiChatSnapshotRequest(limit: 50)), id: "x", cancelTarget: nil)
                == enc.encode(LlmIdeChatHistoryList(limit: 50)))
        #expect(try HostApiV2ChatBridge.outbound(.chatHistoryClear, payload: enc.encode(HostApiChatHistoryClearRequest()), id: "x", cancelTarget: nil)
                == enc.encode(LlmIdeChatHistoryClear()))
        #expect(try HostApiV2ChatBridge.outbound(.approvalsAnswer, payload: enc.encode(HostApiApprovalsAnswerRequest(answers: ["Q": "Yes"], commandId: "u-1", requestId: "r-1")), id: "x", cancelTarget: nil)
                == enc.encode(ApprovalAnswer(commandId: "u-1", requestId: "r-1", answers: ["Q": "Yes"])))
        for (decision, allow) in [("allow_once", true), ("deny", false)] {
            #expect(try HostApiV2ChatBridge.outbound(.toolApprovalsAnswer, payload: enc.encode(HostApiToolApprovalsAnswerRequest(commandId: "u-1", decision: decision, requestId: "r-2")), id: "x", cancelTarget: nil)
                    == enc.encode(ToolApprovalAnswer(commandId: "u-1", requestId: "r-2", allow: allow)))
        }
        #expect(try HostApiV2ChatBridge.outbound(.hostPing, payload: enc.encode(HostApiHostPingRequest()), id: "x", cancelTarget: nil) == nil)
    }

    @Test("output: progress stays progress; done becomes delta + done; empty chunks emit nothing")
    func output() throws {
        #expect(try inbound(Output(commandId: "u-1", payload: .init(stream: "Reading file…", done: false)), type: "output")
                == [.progress(replyTo: "u-1", text: "Reading file…")])
        #expect(try inbound(Output(commandId: "u-1", payload: .init(stream: "", done: false)), type: "output").isEmpty)
        let done = try inbound(Output(commandId: "u-1", payload: .init(stream: "The answer", done: true)), type: "output")
        #expect(done == [.event(.chatDelta, payload: try enc.encode(HostApiChatDeltaEvent(text: "The answer")), replyTo: "u-1"),
                         .event(.chatDone, payload: try enc.encode(HostApiChatDoneEvent(requestId: "u-1")), replyTo: "u-1")])
        try assertValid(done)
        #expect(try inbound(Output(commandId: "u-1", payload: .init(stream: nil, done: true)), type: "output")
                == [.event(.chatDone, payload: try enc.encode(HostApiChatDoneEvent(requestId: "u-1")), replyTo: "u-1")])
    }

    @Test("error frames become chat.error, with or without a command id")
    func errors() throws {
        let owned = try inbound(CommandError(commandId: "u-1", message: "Boom"), type: "error")
        #expect(owned == [.event(.chatError, payload: try enc.encode(HostApiChatErrorEvent(message: "Boom")), replyTo: "u-1")])
        let global = try inbound(CommandError(commandId: nil, message: "Down"), type: "error")
        #expect(global == [.event(.chatError, payload: try enc.encode(HostApiChatErrorEvent(message: "Down")), replyTo: nil)])
    }

    @Test("approval frames round-trip v2 → v1 event → the same v2 view model")
    func approvals() throws {
        let request = ApprovalRequest(commandId: "u-1", requestId: "r-1", questions: [
            MobileApprovalQuestion(question: "Run it?", header: "Approve",
                                   options: [MobileApprovalOption(label: "Yes", description: "now"), MobileApprovalOption(label: "No", description: nil)],
                                   multiSelect: false)])
        let events = try inbound(request, type: MobileProtocol.Tag.approvalRequest)
        try assertValid(events)
        guard case .event(.approvalRequest, let p, "u-1") = events.first else { Issue.record("approval.request"); return }
        #expect(HostApiV2ChatBridge.approvalRequest(try JSONDecoder().decode(HostApiApprovalRequestEvent.self, from: p)) == request)

        let tool = ToolApprovalRequest(commandId: "u-1", requestId: "r-2", toolName: "Edit", summary: "Edit a.swift",
                                       filePath: "a.swift", oldString: "a", newString: "b", contentPreview: nil,
                                       command: nil, truncated: false, replaceAll: false, overwrites: nil)
        let toolEvents = try inbound(tool, type: MobileProtocol.Tag.toolApprovalRequest)
        try assertValid(toolEvents)
        guard case .event(.toolApprovalRequest, let tp, _) = toolEvents.first else { Issue.record("toolApproval.request"); return }
        #expect(HostApiV2ChatBridge.toolApprovalRequest(try JSONDecoder().decode(HostApiToolApprovalRequestEvent.self, from: tp)) == tool)

        let cleared = ApprovalCleared(commandId: "u-1", requestId: "r-1", reason: "Answered on the Mac")
        let clearedEvents = try inbound(cleared, type: MobileProtocol.Tag.approvalCleared)
        try assertValid(clearedEvents)
        guard case .event(.approvalCleared, let cp, _) = clearedEvents.first else { Issue.record("approval.cleared"); return }
        #expect(HostApiV2ChatBridge.approvalCleared(try JSONDecoder().decode(HostApiApprovalClearedEvent.self, from: cp)) == cleared)
    }

    @Test("history reply and clear ack map to their v1 results; other frames map to nothing")
    func replies() throws {
        let reply = try enc.encode(LlmIdeChatHistoryReply(messages: [ChatTurn(role: "user", content: "hi"), ChatTurn(role: "assistant", content: "yo")]))
        #expect(HostApiV2ChatBridge.snapshotResult(reply) == HostApiChatSnapshotResult(messages: [.init(content: "hi", role: "user"), .init(content: "yo", role: "assistant")]))
        #expect(HostApiV2ChatBridge.clearResult(try enc.encode(LlmIdeChatHistoryClearAck(ok: false))) == HostApiChatHistoryClearResult(cleared: false))
        #expect(HostApiV2ChatBridge.inbound(type: "loop_state", json: [:], data: Data("{}".utf8)).isEmpty)
    }
}
