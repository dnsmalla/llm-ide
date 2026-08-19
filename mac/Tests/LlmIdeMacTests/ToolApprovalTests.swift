import Foundation
import Testing
@testable import LlmIdeMacLib

/// Task 9: `AgentV2Approval` gains `kind`/`toolName`/`argsSummary` so the
/// v2 engine's `approval_request` decode path (shared by BOTH the
/// `AskUserQuestion` shape, P1, and the new `ToolApproval` shape, P2 — see
/// `extension/llm_agent/sdk/engine.mjs`'s `canUseTool`) round-trips through
/// one struct without breaking the existing back-compat contract.
@Suite("Tool approval decoding")
struct ToolApprovalTests {
    @Test("AgentV2Approval decodes a ToolApproval payload with toolName + argsSummary")
    func decodesToolApproval() throws {
        let json = """
        {"type":"approval_request","requestId":"r1","kind":"ToolApproval","toolName":"run-bash","argsSummary":"npm install left-pad"}
        """
        let data = Data(json.utf8)
        guard case .approvalRequest(let approval)? = AgentV2Event.decode(fromJSON: data) else {
            Issue.record("expected an approvalRequest event")
            return
        }
        #expect(approval.kind == "ToolApproval")
        #expect(approval.toolName == "run-bash")
        #expect(approval.argsSummary == "npm install left-pad")
        #expect(approval.questions.isEmpty)
    }

    @Test("AgentV2Approval still decodes a plain AskUserQuestion payload (kind defaults)")
    func decodesAskUserQuestionBackCompat() throws {
        let json = """
        {"type":"approval_request","requestId":"r2","kind":"AskUserQuestion","questions":[{"question":"Proceed?","header":"Confirm","options":[{"label":"Yes","description":""}],"multiSelect":false}]}
        """
        let data = Data(json.utf8)
        guard case .approvalRequest(let approval)? = AgentV2Event.decode(fromJSON: data) else {
            Issue.record("expected an approvalRequest event")
            return
        }
        #expect(approval.kind == "AskUserQuestion")
        #expect(approval.questions.count == 1)
        #expect(approval.toolName == nil)
        #expect(approval.argsSummary == nil)
    }

    @Test("AgentV2Approval decodes a payload with no kind field at all as AskUserQuestion (true back-compat)")
    func decodesMissingKindDefaultsToAskUserQuestion() throws {
        // A payload predating this field entirely — no `kind` key at all,
        // as a P1-era server would have sent it.
        let json = """
        {"type":"approval_request","requestId":"r3","questions":[]}
        """
        let data = Data(json.utf8)
        guard case .approvalRequest(let approval)? = AgentV2Event.decode(fromJSON: data) else {
            Issue.record("expected an approvalRequest event")
            return
        }
        #expect(approval.kind == "AskUserQuestion")
        #expect(approval.questions.isEmpty)
    }

    @Test("AgentV2ApprovalState carries a legacySessionId for the legacy engine's ToolApproval")
    @MainActor
    func stateCarriesLegacySessionId() {
        let approval = AgentV2Approval(requestId: "r1", kind: "ToolApproval",
                                        toolName: "run-bash", argsSummary: "echo hi")
        let state = AgentV2ApprovalState(approval: approval, legacySessionId: "legacy-session-1")
        #expect(state.legacySessionId == "legacy-session-1")
        #expect(state.approval.kind == "ToolApproval")
    }

    @Test("AgentV2ApprovalState defaults legacySessionId to nil for a v2 approval")
    @MainActor
    func stateDefaultsLegacySessionIdToNil() {
        let approval = AgentV2Approval(requestId: "r1", kind: "AskUserQuestion")
        let state = AgentV2ApprovalState(approval: approval)
        #expect(state.legacySessionId == nil)
    }
}
