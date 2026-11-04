import Foundation
import SharedProtocol

struct HostApiV1EventOut: Equatable {
    let command: String
    let payload: Data
}

struct HostApiV1Translation: Equatable {
    let events: [HostApiV1EventOut]
    /// The v1 command is over: the gateway stops routing frames for it.
    let terminal: Bool
}

/// Turns one v2 Mac → phone frame (for a v1-owned command) into the v1 events the spec defines. Pure.
enum HostApiV2Translator {
    static let deltaChunk = 100_000

    static func translate(_ v2Frame: Data, external commandId: String, cancelledByClient: Bool) -> HostApiV1Translation {
        struct Envelope: Decodable { let type: String }
        let decoder = JSONDecoder()
        let none = HostApiV1Translation(events: [], terminal: false)
        guard let type = (try? decoder.decode(Envelope.self, from: v2Frame))?.type else { return none }
        switch type {
        case MobileProtocol.Tag.output:
            guard let o = try? decoder.decode(Output.self, from: v2Frame), o.payload.done else { return none }
            let deltas = chunks(o.payload.stream ?? "").map { event("chat.delta", HostApiChatDeltaEvent(text: $0)) }
            return .init(events: deltas + [event("chat.done", HostApiChatDoneEvent(requestId: commandId))], terminal: true)
        case MobileProtocol.Tag.error:
            if cancelledByClient {
                return .init(events: [event("chat.done", HostApiChatDoneEvent(requestId: commandId, stopReason: "cancelled"))], terminal: true)
            }
            let message = (try? decoder.decode(CommandError.self, from: v2Frame))?.message ?? ""
            let text = HostApiFrame.clamp(message.isEmpty ? "The Mac could not finish this request." : message, maxUTF16: 2_000)
            return .init(events: [event("chat.error", HostApiChatErrorEvent(message: text, retryable: false))], terminal: true)
        case MobileProtocol.Tag.approvalRequest:
            guard let r = try? decoder.decode(ApprovalRequest.self, from: v2Frame), let rid = canonicalId(r.requestId) else { return none }
            // Schema needs minLength:1 text and minItems:1 options, so drop what cannot be rendered. If no
            // question survives, emit nothing: the Mac user still answers it at the desk.
            let questions = r.questions.compactMap { q -> HostApiApprovalRequestEventQuestionsItem? in
                let options = q.options.filter { !$0.label.isEmpty }.prefix(20).map { opt in
                    HostApiApprovalRequestEventQuestionsItemOptionsItem(
                        description: opt.description.map { HostApiFrame.clamp($0, maxUTF16: 500) },
                        label: HostApiFrame.clamp(opt.label, maxUTF16: 200))
                }
                guard !q.question.isEmpty, !options.isEmpty else { return nil }
                return HostApiApprovalRequestEventQuestionsItem(
                    header: q.header.map { HostApiFrame.clamp($0, maxUTF16: 12) },
                    multiSelect: q.multiSelect,
                    options: Array(options),
                    question: HostApiFrame.clamp(q.question, maxUTF16: 2_000))
            }.prefix(10)
            guard !questions.isEmpty else { return none } // v2 never sends zero questions; an unrenderable approval stays parked for the Mac user.
            let ev = HostApiApprovalRequestEvent(commandId: commandId, questions: Array(questions), requestId: rid)
            return .init(events: [event("approval.request", ev)], terminal: false)
        case MobileProtocol.Tag.approvalCleared:
            guard let c = try? decoder.decode(ApprovalCleared.self, from: v2Frame), let rid = canonicalId(c.requestId) else { return none }
            let ev = HostApiApprovalClearedEvent(commandId: commandId,
                                                 reason: c.reason.map { HostApiFrame.clamp($0, maxUTF16: 500) },
                                                 requestId: rid)
            return .init(events: [event("approval.cleared", ev)], terminal: false)
        case MobileProtocol.Tag.toolApprovalRequest:
            guard let t = try? decoder.decode(ToolApprovalRequest.self, from: v2Frame), let rid = canonicalId(t.requestId) else { return none }
            // Caps are the events.schema.json maxLength values for toolApproval.request.
            var clamped = false
            func cap(_ s: String?, _ n: Int) -> String? {
                guard let s else { return nil }
                let c = HostApiFrame.clamp(s, maxUTF16: n)
                if c != s { clamped = true }
                return c
            }
            let toolName = cap(t.toolName.isEmpty ? "tool" : t.toolName, 200) ?? "tool"
            let summary = cap(t.summary, 2_000)
            let filePath = cap(t.filePath, 2_000)
            let oldString = cap(t.oldString, 20_000)
            let newString = cap(t.newString, 20_000)
            let contentPreview = cap(t.contentPreview, 20_000)
            let command = cap(t.command, 2_000)
            let ev = HostApiToolApprovalRequestEvent(
                command: command, commandId: commandId, contentPreview: contentPreview, filePath: filePath,
                newString: newString, oldString: oldString, overwrites: t.overwrites, replaceAll: t.replaceAll,
                requestId: rid, summary: summary, toolName: toolName,
                truncated: t.truncated || clamped)
            return .init(events: [event("toolApproval.request", ev)], terminal: false)
        default:
            return none
        }
    }

    /// `text` cut into pieces of at most `deltaChunk` UTF-16 units, on Character boundaries.
    static func chunks(_ text: String) -> [String] {
        var out: [String] = [], current = "", n = 0
        for ch in text {
            let w = String(ch).utf16.count
            if n + w > deltaChunk { out.append(current); current = ""; n = 0 }
            current.append(ch); n += w
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    /// The id as the schema accepts it (1–64 UTF-16 units), or nil: a truncated id would name a different request.
    private static func canonicalId(_ s: String) -> String? {
        (1...64).contains(s.utf16.count) ? s : nil
    }

    private static func event<P: Encodable>(_ command: String, _ payload: P) -> HostApiV1EventOut {
        HostApiV1EventOut(command: command, payload: (try? JSONEncoder().encode(payload)) ?? Data("{}".utf8))
    }
}
