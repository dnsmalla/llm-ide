import Testing
@testable import LlmIdeMacLib

/// Task 6: `ToolApprovalCard` gains two pure static helpers so its header
/// (icon + title) is driven by `toolName` rather than a hardcoded "Run
/// tool" — and per-tool body rendering (diff/preview) reads
/// `AgentV2Approval.args` (Task 5) instead of the plain `argsSummary` text.
/// These helpers are the only parts of the SwiftUI view pure enough to unit
/// test directly; the body rendering itself needs human visual confirmation
/// in the running app (see task-6-report.md).
///
/// NOTE: `ToolApprovalTests.swift` (in this same directory) is fully
/// occupied by `AgentV2Approval` wire-decode tests — it is not the right
/// home for these presentation-layer tests, hence this new file.
@Suite("Tool approval card presentation")
struct ToolApprovalCardTests {
    @Test("title(toolName:) returns the per-tool label")
    func titlePerTool() {
        #expect(ToolApprovalCard.title(toolName: "Edit") == "Edit file")
        #expect(ToolApprovalCard.title(toolName: "Write") == "Write file")
        #expect(ToolApprovalCard.title(toolName: "Bash") == "Run Bash")
        #expect(ToolApprovalCard.title(toolName: nil) == "Run tool")
    }

    @Test("icon(toolName:) returns the per-tool SF Symbol")
    func iconPerTool() {
        #expect(ToolApprovalCard.icon(toolName: "Edit") == "pencil")
        #expect(ToolApprovalCard.icon(toolName: "Write") == "square.and.pencil")
        #expect(ToolApprovalCard.icon(toolName: "Bash") == "terminal.fill")
        #expect(ToolApprovalCard.icon(toolName: nil) == "terminal.fill")
    }

    @Test("the always-allow button names the rule it saves — and hides without one")
    func alwaysAllowLabelPerRule() {
        typealias S = AgentV2ApprovalSuggestion
        #expect(ToolApprovalCard.alwaysAllowLabel(suggestion: S(toolName: "Bash", pattern: "npm test", scope: "project", label: nil))
                == "Always Allow `npm test` Here")
        #expect(ToolApprovalCard.alwaysAllowLabel(suggestion: S(toolName: "Edit", pattern: nil, scope: "session", label: nil))
                == "Allow All Edits in This Chat")
        #expect(ToolApprovalCard.alwaysAllowLabel(suggestion: S(toolName: "deploy-app", pattern: "", scope: "project", label: nil))
                == "Always Allow deploy-app Here")
        #expect(ToolApprovalCard.alwaysAllowLabel(suggestion: nil) == nil, "a compound command offers once-only")
    }
}
