import Foundation

// MARK: - Mid-turn questions (AskUserQuestion)

/// A parked question the agent is blocking on (`AskUserQuestion`), as the chat card renders it. The host
/// sends it as Host API v1 `approval.request` (`init(event:)`); the phone answers with `approvals.answer`.
/// Tapping a label is the whole interaction — typing is for when none of the offered answers is the one you mean.

public struct MobileApprovalOption: Codable, Equatable, Hashable {
    public let label: String
    public let description: String?
    public init(label: String, description: String?) {
        self.label = label; self.description = description
    }
}

public struct MobileApprovalQuestion: Codable, Equatable, Hashable {
    public let question: String
    /// Short category label (≤ 12 chars by the card's own rules); may be absent.
    public let header: String?
    public let options: [MobileApprovalOption]
    /// When true the user may pick several labels; the answer joins them with
    /// commas, which is the wire form the server passes through verbatim.
    public let multiSelect: Bool
    public init(question: String, header: String?, options: [MobileApprovalOption], multiSelect: Bool) {
        self.question = question; self.header = header
        self.options = options; self.multiSelect = multiSelect
    }
}

/// The turn identified by `commandId` is parked on these
/// questions. `requestId` is the server-side decision id and must come back
/// unchanged — it is what the answer is matched against.
public struct ApprovalRequest: Codable, Equatable {
    public let commandId: String
    public let requestId: String
    public let questions: [MobileApprovalQuestion]
    public init(commandId: String, requestId: String, questions: [MobileApprovalQuestion]) {
        self.commandId = commandId; self.requestId = requestId; self.questions = questions
    }

    /// Chosen labels per question index → the `answers` dictionary.
    ///
    /// Keyed by the QUESTION TEXT, multi-select sorted and comma-joined: the host passes the result through
    /// verbatim to the SDK, so keying by header or index would answer the wrong question with a perfectly
    /// successful request.
    public func answers(from selection: [Int: Set<String>]) -> [String: String] {
        var answers: [String: String] = [:]
        for (index, question) in questions.enumerated() {
            guard let labels = selection[index], !labels.isEmpty else { continue }
            answers[question.question] = labels.sorted().joined(separator: ",")
        }
        return answers
    }
}

/// This question is no longer answerable — answered on the desktop,
/// expired server-side, or the turn ended. Sent so the phone takes the card
/// down instead of leaving a tappable question whose answer can no longer
/// land anywhere.
public struct ApprovalCleared: Codable, Equatable {
    public let commandId: String
    public let requestId: String
    /// Shown to the user when present ("Answered on the desktop", an error, …).
    public let reason: String?
    public init(commandId: String, requestId: String, reason: String? = nil) {
        self.commandId = commandId; self.requestId = requestId; self.reason = reason
    }
}

// Host API v1 event payloads mapped onto the structs the chat cards render.

public extension ApprovalRequest {
    init(event e: HostApiApprovalRequestEvent) {
        self.init(commandId: e.commandId, requestId: e.requestId, questions: e.questions.map { q in
            MobileApprovalQuestion(question: q.question, header: q.header,
                                   options: q.options.map { MobileApprovalOption(label: $0.label, description: $0.description) },
                                   multiSelect: q.multiSelect)
        })
    }
}

public extension ApprovalCleared {
    init(event e: HostApiApprovalClearedEvent) {
        self.init(commandId: e.commandId, requestId: e.requestId, reason: e.reason)
    }
}
