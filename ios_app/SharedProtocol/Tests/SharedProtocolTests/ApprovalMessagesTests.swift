import Testing
import Foundation
import SharedProtocol

/// Wire-shape guard for the mid-turn question channel. Both ends decode these,
/// and a turn is PARKED on the other side of them — a field rename that slips
/// through here doesn't degrade the feature, it hangs the turn until the
/// server's 15-minute park expires.
///
/// swift-testing, not XCTest: this toolchain ships no XCTest, so the sibling
/// XCTest suites in this directory compile but never RUN here (`swift test`
/// reports "0 tests"). A guard that doesn't execute where the code is written
/// is not a guard.
@Suite struct ApprovalMessagesTests {

    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    @Test func tagsAreStable() {
        #expect(MobileProtocol.Tag.approvalRequest == "approval_request")
        #expect(MobileProtocol.Tag.approvalAnswer == "approval_answer")
        #expect(MobileProtocol.Tag.approvalCleared == "approval_cleared")
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

    /// The `type` discriminator has to be ON the wire — the receive loop reads
    /// it off the raw JSON before it knows which struct to decode.
    @Test func typeIsEncoded() throws {
        let data = try JSONEncoder().encode(
            ApprovalAnswer(commandId: "c", requestId: "r", answers: ["q": "a"]))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["type"] as? String == "approval_answer")
        #expect(json["requestId"] as? String == "r")
    }

    /// Answers are keyed by the QUESTION TEXT, and a multi-select answer is
    /// comma-joined — the contract the Mac's own card produces
    /// (`ApprovalQuestionCard.answers`) and the server passes through verbatim
    /// to the SDK. A phone answer that keyed by header or index would post
    /// successfully and answer the wrong thing.
    @Test func answerKeysAreQuestionTextAndMultiSelectIsCommaJoined() throws {
        let answer = ApprovalAnswer(
            commandId: "c", requestId: "r",
            answers: ["Which areas?": "Extension,Mac"])
        let restored = try roundTrip(answer)
        #expect(restored.answers["Which areas?"] == "Extension,Mac")
    }

    @Test func clearedCarriesAnOptionalReason() throws {
        let withReason = ApprovalCleared(commandId: "c", requestId: "r", reason: "Answered on the Mac")
        #expect(try roundTrip(withReason) == withReason)
        let bare = ApprovalCleared(commandId: "c", requestId: "r")
        #expect(try roundTrip(bare) == bare)
        #expect(nil == bare.reason)
    }
}
