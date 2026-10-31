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

    /// The phone can only allow once or deny: no "always allow" rule and no Bypass can come from its answer.
    @MainActor
    func testPhoneAnswerCanOnlyAllowOnceOrDeny() throws {
        XCTAssertEqual(MobileControlManager.phoneToolDecisionAction(allow: true), "allow")
        XCTAssertEqual(MobileControlManager.phoneToolDecisionAction(allow: false), "deny")
        let wire = try JSONEncoder().encode(ToolApprovalAnswer(commandId: "c", requestId: "r", allow: true))
        let keys = Set(try XCTUnwrap(JSONSerialization.jsonObject(with: wire) as? [String: Any]).keys)
        XCTAssertEqual(keys, ["type", "commandId", "requestId", "allow"], "no field could carry always-allow or a mode")
        // A hostile phone adding extra keys changes nothing: they are not decoded.
        let sneaky = Data(#"{"type":"tool_approval_answer","commandId":"c","requestId":"r","allow":true,"always":true,"mode":"bypass","action":"allow_always"}"#.utf8)
        let decoded = try JSONDecoder().decode(ToolApprovalAnswer.self, from: sneaky)
        XCTAssertEqual(decoded, ToolApprovalAnswer(commandId: "c", requestId: "r", allow: true))
    }

    /// The relayed prompt carries the tool name and the one-line summary the Mac card shows, plus every
    /// preview field; a field that could not be shown in full sets `truncated` (and the Mac then refuses Allow).
    func testRelayedPromptNeverDropsTheToolOrSummary() {
        let req = MobileToolApproval.request(
            from: approval(AgentV2ApprovalArgs(filePath: "/a", oldString: "o", newString: "n", contentPreview: nil,
                                               totalChars: nil, command: nil, truncated: true,
                                               replaceAll: nil, exists: nil), tool: "Edit", summary: "Edit a"),
            commandId: "c")
        XCTAssertEqual(req.toolName, "Edit")
        XCTAssertEqual(req.summary, "Edit a")
        XCTAssertEqual(req.oldString, "o")
        XCTAssertEqual(req.newString, "n")
        XCTAssertTrue(req.truncated)
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
