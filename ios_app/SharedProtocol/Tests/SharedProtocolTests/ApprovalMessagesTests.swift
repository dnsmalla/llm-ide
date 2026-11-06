import Testing
import Foundation
import SharedProtocol

/// The mid-turn question cards: the answer shape the host passes through to the SDK, and the mapping
/// from the Host API v1 events.
@Suite struct ApprovalMessagesTests {

    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    @Test func requestRoundTripsWithEveryQuestionField() throws {
        let request = ApprovalRequest(
            commandId: "cmd-1",
            requestId: "req-9",
            questions: [
                MobileApprovalQuestion(
                    question: "Which should I write the plan for?",
                    header: "Scope",
                    options: [
                        MobileApprovalOption(label: "Phase 2", description: "the removal workflow"),
                        MobileApprovalOption(label: "Both", description: nil),
                    ],
                    multiSelect: false),
                MobileApprovalQuestion(
                    question: "Which areas?",
                    header: nil,
                    options: [MobileApprovalOption(label: "Mac", description: nil)],
                    multiSelect: true),
            ])
        #expect(try roundTrip(request) == request)
    }

    /// Answers are keyed by the QUESTION TEXT, and a multi-select answer is sorted and comma-joined; the
    /// server passes it through verbatim to the SDK.
    @Test func answerKeysAreQuestionTextAndMultiSelectIsCommaJoined() {
        let request = ApprovalRequest(commandId: "c", requestId: "r", questions: [
            MobileApprovalQuestion(question: "Which areas?", header: nil,
                                   options: [MobileApprovalOption(label: "Mac", description: nil),
                                             MobileApprovalOption(label: "Extension", description: nil)],
                                   multiSelect: true)])
        #expect(request.answers(from: [0: ["Mac", "Extension"]]) == ["Which areas?": "Extension,Mac"])
        #expect(request.answers(from: [0: []]).isEmpty)
    }

    @Test func clearedCarriesAnOptionalReason() throws {
        let withReason = ApprovalCleared(commandId: "c", requestId: "r", reason: "Answered on the Mac")
        #expect(try roundTrip(withReason) == withReason)
        let bare = ApprovalCleared(commandId: "c", requestId: "r")
        #expect(try roundTrip(bare) == bare)
        #expect(nil == bare.reason)
    }

    @Test func v1EventsMapOntoTheCardModels() throws {
        let e = HostApiApprovalRequestEvent(commandId: "u-1", questions: [
            .init(header: "Approve", multiSelect: false,
                  options: [.init(description: "now", label: "Yes"), .init(description: nil, label: "No")], question: "Run it?")],
                                            requestId: "r-1")
        #expect(ApprovalRequest(event: e) == ApprovalRequest(commandId: "u-1", requestId: "r-1", questions: [
            MobileApprovalQuestion(question: "Run it?", header: "Approve",
                                   options: [MobileApprovalOption(label: "Yes", description: "now"),
                                             MobileApprovalOption(label: "No", description: nil)],
                                   multiSelect: false)]))
        #expect(ApprovalCleared(event: HostApiApprovalClearedEvent(commandId: "u-1", reason: "Answered", requestId: "r-1"))
                == ApprovalCleared(commandId: "u-1", requestId: "r-1", reason: "Answered"))
        let t = HostApiToolApprovalRequestEvent(command: nil, commandId: "u-1", contentPreview: nil, filePath: "a.swift",
                                                newString: "b", oldString: "a", overwrites: nil, replaceAll: false,
                                                requestId: "r-2", summary: "Edit a.swift", toolName: "Edit", truncated: false)
        #expect(ToolApprovalRequest(event: t) == ToolApprovalRequest(
            commandId: "u-1", requestId: "r-2", toolName: "Edit", summary: "Edit a.swift", filePath: "a.swift",
            oldString: "a", newString: "b", contentPreview: nil, command: nil, truncated: false, replaceAll: false, overwrites: nil))
    }
}
