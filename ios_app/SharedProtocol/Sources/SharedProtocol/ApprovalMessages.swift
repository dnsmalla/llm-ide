import Foundation

// MARK: - Mid-turn questions (AskUserQuestion)

/// A parked question the agent is blocking on, and the phone's answer to it.
///
/// The agent can stop mid-turn to ask (`AskUserQuestion`) — which is most of
/// what the planning modes DO, since stage one of a plan is questioning. The
/// Mac renders those as a card of labelled options you tap. The phone had no
/// such channel: it only saw the note "⏸ Question pending on Mac…" streamed
/// into its progress line, and the turn stayed parked until someone walked
/// over to the Mac (or the server's 15-minute park expired).
///
/// So the question travels, and the answer comes back. Tapping a label is the
/// whole interaction — typing is for when none of the offered answers is the
/// one you mean.

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

/// Mac → phone: the turn identified by `commandId` is parked on these
/// questions. `requestId` is the server-side decision id and must come back
/// unchanged — it is what the answer is matched against.
public struct ApprovalRequest: Codable, Equatable {
    public let type = MobileProtocol.Tag.approvalRequest
    public let commandId: String
    public let requestId: String
    public let questions: [MobileApprovalQuestion]
    public init(commandId: String, requestId: String, questions: [MobileApprovalQuestion]) {
        self.commandId = commandId; self.requestId = requestId; self.questions = questions
    }
    private enum CodingKeys: String, CodingKey { case type, commandId, requestId, questions }
}

/// Phone → Mac: the user's answers, keyed by the QUESTION TEXT — the same
/// contract the Mac's own card uses (`ApprovalQuestionCard.answers`), which
/// the server passes through to the SDK's `updatedInput.answers`. A
/// multi-select answer is the chosen labels sorted and comma-joined, so the
/// value does not depend on tap order.
public struct ApprovalAnswer: Codable, Equatable {
    public let type = MobileProtocol.Tag.approvalAnswer
    public let commandId: String
    public let requestId: String
    public let answers: [String: String]
    public init(commandId: String, requestId: String, answers: [String: String]) {
        self.commandId = commandId; self.requestId = requestId; self.answers = answers
    }
    private enum CodingKeys: String, CodingKey { case type, commandId, requestId, answers }
}

/// Mac → phone: this question is no longer answerable — answered on the Mac,
/// expired server-side, or the turn ended. Sent so the phone takes the card
/// down instead of leaving a tappable question whose answer can no longer
/// land anywhere.
public struct ApprovalCleared: Codable, Equatable {
    public let type = MobileProtocol.Tag.approvalCleared
    public let commandId: String
    public let requestId: String
    /// Shown to the user when present ("Answered on the Mac", an error, …).
    public let reason: String?
    public init(commandId: String, requestId: String, reason: String? = nil) {
        self.commandId = commandId; self.requestId = requestId; self.reason = reason
    }
    private enum CodingKeys: String, CodingKey { case type, commandId, requestId, reason }
}
