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
        #expect(ToolApprovalCard.title(toolName: "SandboxNetworkAccess") == "Allow network access")
    }

    @Test("icon(toolName:) returns the per-tool SF Symbol")
    func iconPerTool() {
        #expect(ToolApprovalCard.icon(toolName: "Edit") == "pencil")
        #expect(ToolApprovalCard.icon(toolName: "Write") == "square.and.pencil")
        #expect(ToolApprovalCard.icon(toolName: "Bash") == "terminal.fill")
        #expect(ToolApprovalCard.icon(toolName: nil) == "terminal.fill")
        #expect(ToolApprovalCard.icon(toolName: "SandboxNetworkAccess") == "network")
    }

    @Test("a network rule is described as a host, not as a command prefix")
    func networkRuleWording() {
        typealias S = AgentV2ApprovalSuggestion
        let net = S(toolName: "SandboxNetworkAccess", pattern: "registry.npmjs.org", scope: "project", label: nil)
        #expect(ToolApprovalCard.alwaysAllowLabel(suggestion: net) == "Always Allow `registry.npmjs.org` Here")
        #expect(ToolApprovalCard.alwaysAllowHelp(suggestion: net).hasPrefix(
            "Stop asking for network access to `registry.npmjs.org` in this project."))
        #expect(ToolApprovalCard.alwaysAllowHelp(suggestion: S(toolName: "Bash", pattern: "npm test", scope: "project", label: nil))
            .hasPrefix("Stop asking for `npm test` commands in this project."))
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
