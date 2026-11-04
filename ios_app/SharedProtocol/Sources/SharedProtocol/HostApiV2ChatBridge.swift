import Foundation

/// The chat + approvals slice of MobileProtocol v2, spoken in Host API v1 vocabulary, so a store behind
/// `HostConnection` sees the same commands and events on a v1 host and on the v2 fallback. This is the
/// inverse of the Mac's `HostApiV2Translator`. It is pure: no socket, no state.
public enum HostApiV2ChatBridge {
    /// The v2 frame for a v1 command, or nil when the command has no v2 form here. `cancelTarget` is the
    /// chat request a v2 `Cancel` names; v1 `chat.cancel` names none.
    public static func outbound(_ command: HostApiCommand, payload: Data, id: String, cancelTarget: String?) throws -> Data? {
        let d = JSONDecoder(), e = JSONEncoder()
        e.outputFormatting = .sortedKeys // deterministic bytes; key order is meaningless to JSON readers
        switch command {
        case .chatSend:
            let p = try d.decode(HostApiChatSendRequest.self, from: payload)
            return try e.encode(LlmIdeChat(commandId: id, text: p.text,
                                           files: (p.attachments ?? []).map { ChatFileText(name: $0.name, text: $0.text) }))
        case .chatCancel:
            return try cancelTarget.map { try e.encode(LlmIdeCancel(commandId: $0)) }
        case .chatSnapshot:
            let p = try d.decode(HostApiChatSnapshotRequest.self, from: payload)
            return try e.encode(LlmIdeChatHistoryList(limit: p.limit ?? HostApi.limits.defaultListItems))
        case .chatHistoryClear:
            return try e.encode(LlmIdeChatHistoryClear())
        case .approvalsAnswer:
            let p = try d.decode(HostApiApprovalsAnswerRequest.self, from: payload)
            return try e.encode(ApprovalAnswer(commandId: p.commandId, requestId: p.requestId, answers: p.answers))
        case .toolApprovalsAnswer:
            let p = try d.decode(HostApiToolApprovalsAnswerRequest.self, from: payload)
            return try e.encode(ToolApprovalAnswer(commandId: p.commandId, requestId: p.requestId, allow: p.decision == "allow_once"))
        default:
            return nil
        }
    }

    /// The v1 events for one inbound v2 frame of the chat slice; [] for any other frame type.
    public static func inbound(type: String, json: [String: Any], data: Data) -> [HostEvent] {
        let d = JSONDecoder()
        func event<P: Encodable>(_ name: HostApiEvent, _ payload: P, _ replyTo: String?) -> HostEvent? {
            (try? JSONEncoder().encode(payload)).map { .event(name, payload: $0, replyTo: replyTo) }
        }
        switch type {
        case MobileProtocol.Tag.output:
            guard let id = json["commandId"] as? String, let p = json["payload"] as? [String: Any] else { return [] }
            let text = p["stream"] as? String ?? ""
            guard p["done"] as? Bool == true else { return text.isEmpty ? [] : [.progress(replyTo: id, text: text)] }
            return [text.isEmpty ? nil : event(.chatDelta, HostApiChatDeltaEvent(text: text), id),
                    event(.chatDone, HostApiChatDoneEvent(requestId: id), id)].compactMap { $0 }
        case MobileProtocol.Tag.error:
            guard let e = try? d.decode(CommandError.self, from: data) else { return [] }
            return [event(.chatError, HostApiChatErrorEvent(message: e.message), e.commandId)].compactMap { $0 }
        case MobileProtocol.Tag.approvalRequest:
            guard let r = try? d.decode(ApprovalRequest.self, from: data) else { return [] }
            let questions = r.questions.map { q in
                HostApiApprovalRequestEventQuestionsItem(
                    header: q.header, multiSelect: q.multiSelect,
                    options: q.options.map { .init(description: $0.description, label: $0.label) }, question: q.question)
            }
            return [event(.approvalRequest, HostApiApprovalRequestEvent(commandId: r.commandId, questions: questions,
                                                                        requestId: r.requestId), r.commandId)].compactMap { $0 }
        case MobileProtocol.Tag.approvalCleared:
            guard let c = try? d.decode(ApprovalCleared.self, from: data) else { return [] }
            return [event(.approvalCleared, HostApiApprovalClearedEvent(commandId: c.commandId, reason: c.reason,
                                                                        requestId: c.requestId), c.commandId)].compactMap { $0 }
        case MobileProtocol.Tag.toolApprovalRequest:
            guard let t = try? d.decode(ToolApprovalRequest.self, from: data) else { return [] }
            return [event(.toolApprovalRequest, HostApiToolApprovalRequestEvent(
                command: t.command, commandId: t.commandId, contentPreview: t.contentPreview, filePath: t.filePath,
                newString: t.newString, oldString: t.oldString, overwrites: t.overwrites, replaceAll: t.replaceAll,
                requestId: t.requestId, summary: t.summary, toolName: t.toolName, truncated: t.truncated), t.commandId)].compactMap { $0 }
        default:
            return []
        }
    }

    public static func snapshotResult(_ data: Data) -> HostApiChatSnapshotResult? {
        (try? JSONDecoder().decode(LlmIdeChatHistoryReply.self, from: data)).map {
            HostApiChatSnapshotResult(messages: $0.messages.map { .init(content: $0.content, role: $0.role) })
        }
    }

    public static func clearResult(_ data: Data) -> HostApiChatHistoryClearResult? {
        (try? JSONDecoder().decode(LlmIdeChatHistoryClearAck.self, from: data)).map { HostApiChatHistoryClearResult(cleared: $0.ok) }
    }

    // v1 event payloads mapped onto the v2 structs the chat views already render.

    public static func approvalRequest(_ e: HostApiApprovalRequestEvent) -> ApprovalRequest {
        ApprovalRequest(commandId: e.commandId, requestId: e.requestId, questions: e.questions.map { q in
            MobileApprovalQuestion(question: q.question, header: q.header,
                                   options: q.options.map { MobileApprovalOption(label: $0.label, description: $0.description) },
                                   multiSelect: q.multiSelect)
        })
    }

    public static func toolApprovalRequest(_ e: HostApiToolApprovalRequestEvent) -> ToolApprovalRequest {
        ToolApprovalRequest(commandId: e.commandId, requestId: e.requestId, toolName: e.toolName, summary: e.summary,
                            filePath: e.filePath, oldString: e.oldString, newString: e.newString,
                            contentPreview: e.contentPreview, command: e.command, truncated: e.truncated,
                            replaceAll: e.replaceAll, overwrites: e.overwrites)
    }

    public static func approvalCleared(_ e: HostApiApprovalClearedEvent) -> ApprovalCleared {
        ApprovalCleared(commandId: e.commandId, requestId: e.requestId, reason: e.reason)
    }
}
