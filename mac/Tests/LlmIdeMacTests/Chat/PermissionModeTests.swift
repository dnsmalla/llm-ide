import Testing
import Foundation
@testable import LlmIdeMacLib

/// Claude Code-style permissions on the Mac side (server API v55).
@Suite("Permission modes and approval suggestions")
struct PermissionModeTests {

    @Test("the three modes map to the server's wire values and capabilities")
    func modes() {
        #expect(EditAcceptanceMode.review.agentPermissionMode == "ask")
        #expect(EditAcceptanceMode.acceptEdits.agentPermissionMode == "accept-edits")
        #expect(EditAcceptanceMode.auto.agentPermissionMode == "bypass")
        #expect(!EditAcceptanceMode.review.autoAppliesEdits)
        #expect(EditAcceptanceMode.acceptEdits.autoAppliesEdits)
        #expect(!EditAcceptanceMode.acceptEdits.autoRunsCommands, "Accept Edits still asks before commands")
        #expect(EditAcceptanceMode.auto.autoRunsCommands)
        #expect(EditAcceptanceMode.allCases.map(\.label) == ["Ask", "Accept Edits", "Bypass"])
    }

    @Test("a stored pre-rename preference still loads")
    func storedValues() {
        #expect(EditAcceptanceMode(rawValue: "review") == .review)
        #expect(EditAcceptanceMode(rawValue: "auto") == .auto)
    }

    @Test("an approval decodes its always-allow suggestion — and survives a malformed one")
    func suggestionDecode() throws {
        let good = #"{"requestId":"r1","kind":"ToolApproval","toolName":"Bash","argsSummary":"npm test","suggestion":{"toolName":"Bash","pattern":"npm test","scope":"project","label":"`npm test` commands"}}"#
        let a = try JSONDecoder().decode(AgentV2Approval.self, from: Data(good.utf8))
        #expect(a.suggestion?.pattern == "npm test")
        #expect(a.suggestion?.scope == "project")

        let bad = #"{"requestId":"r2","kind":"ToolApproval","toolName":"Bash","suggestion":42}"#
        let b = try JSONDecoder().decode(AgentV2Approval.self, from: Data(bad.utf8))
        #expect(b.requestId == "r2", "a bad suggestion must not drop the card")
        #expect(b.suggestion == nil)

        let none = #"{"requestId":"r3","kind":"ToolApproval","toolName":"Bash"}"#
        #expect(try JSONDecoder().decode(AgentV2Approval.self, from: Data(none.utf8)).suggestion == nil)
    }

    @Test("the permissions listing decodes a pre-v55 server (no rules key)")
    func listingDecode() throws {
        let old = #"{"approvals":[{"toolName":"run-bash","grantedAt":"2026-09-01T00:00:00Z"}]}"#
        let p = try JSONDecoder().decode(LlmIdeAPIClient.ToolPermissions.self, from: Data(old.utf8))
        #expect(p.rules.isEmpty)
        #expect(p.legacy.count == 1)
        let new = #"{"rules":[{"projectRoot":"/r","toolName":"Bash","pattern":"npm test","grantedAt":"x"}],"approvals":[]}"#
        let q = try JSONDecoder().decode(LlmIdeAPIClient.ToolPermissions.self, from: Data(new.utf8))
        #expect(q.rules.first?.pattern == "npm test")
    }
}
