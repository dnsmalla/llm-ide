import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

final class MobileToolApprovalTests: XCTestCase {
    private func approval(_ args: AgentV2ApprovalArgs?, tool: String = "Edit", summary: String? = nil) -> AgentV2Approval {
        AgentV2Approval(requestId: "req-1", kind: "ToolApproval", toolName: tool, argsSummary: summary, args: args)
    }

    func testEditPromptCarriesWhatTheMacCardShowsButRedacted() throws {
        let args = AgentV2ApprovalArgs(
            filePath: NSHomeDirectory() + "/proj/Sources/A.swift",
            oldString: "let key = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\"", newString: "let key = env()",
            contentPreview: nil, totalChars: nil, command: nil, truncated: nil, replaceAll: true, exists: nil)
        let req = MobileToolApproval.request(from: approval(args, summary: "Edit A.swift"), commandId: "c1")
        XCTAssertEqual(req.commandId, "c1")
        XCTAssertEqual(req.requestId, "req-1")
        XCTAssertEqual(req.toolName, "Edit")
        XCTAssertEqual(req.filePath, "~/proj/Sources/A.swift", "no absolute home path on the wire")
        XCTAssertEqual(req.replaceAll, true)
        let json = String(data: try JSONEncoder().encode(req), encoding: .utf8)!
        XCTAssertFalse(json.contains("ghp_abcdefghijklmnopqrstuvwxyz"), "secrets are redacted")
        XCTAssertFalse(json.contains(NSHomeDirectory()))
    }

    func testBashCommandAndOverwriteFlagsArePassedThrough() {
        let bash = MobileToolApproval.request(
            from: approval(AgentV2ApprovalArgs(filePath: nil, oldString: nil, newString: nil, contentPreview: nil,
                                               totalChars: nil, command: "npm test", truncated: nil,
                                               replaceAll: nil, exists: nil), tool: "Bash"), commandId: "c")
        XCTAssertEqual(bash.command, "npm test")
        let write = MobileToolApproval.request(
            from: approval(AgentV2ApprovalArgs(filePath: "/tmp/x", oldString: nil, newString: nil,
                                               contentPreview: "hi", totalChars: 2, command: nil, truncated: nil,
                                               replaceAll: nil, exists: true), tool: "Write"), commandId: "c")
        XCTAssertEqual(write.overwrites, true)
        XCTAssertEqual(write.contentPreview, "hi")
    }

    func testOversizedFieldsAreCappedAndFlaggedAndStayFast() {
        let huge = String(repeating: "x", count: 200_000)
        let started = Date()
        let req = MobileToolApproval.request(
            from: approval(AgentV2ApprovalArgs(filePath: "/a", oldString: nil, newString: huge, contentPreview: nil,
                                               totalChars: nil, command: nil, truncated: nil,
                                               replaceAll: nil, exists: nil)), commandId: "c")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertTrue(req.truncated)
        XCTAssertLessThanOrEqual(req.newString?.count ?? 0, MobileToolApproval.maxField)
    }

    @MainActor
    func testAnAnswerIsRefusedUnlessTheSwitchIsOnAndItNamesTheLivePrompt() {
        typealias M = MobileControlManager
        XCTAssertNil(M.toolAnswerRefusal(switchOn: true, pendingRequestId: "r", pendingKind: "ToolApproval", answerRequestId: "r"))
        XCTAssertNotNil(M.toolAnswerRefusal(switchOn: false, pendingRequestId: "r", pendingKind: "ToolApproval", answerRequestId: "r"))
        XCTAssertNotNil(M.toolAnswerRefusal(switchOn: true, pendingRequestId: "r", pendingKind: "ToolApproval", answerRequestId: "OTHER"))
        XCTAssertNotNil(M.toolAnswerRefusal(switchOn: true, pendingRequestId: nil, pendingKind: nil, answerRequestId: "r"))
        XCTAssertNotNil(M.toolAnswerRefusal(switchOn: true, pendingRequestId: "r", pendingKind: "AskUserQuestion", answerRequestId: "r"),
                        "a question card must not be answerable as a tool prompt")
    }
}
