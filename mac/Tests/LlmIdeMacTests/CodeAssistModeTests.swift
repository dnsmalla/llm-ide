import Foundation
import Testing
@testable import LlmIdeMacLib

/// `CodeAssistMode`'s raw values are a wire contract with the server's
/// `mode-personas.mjs`/`route.mjs` (see the enum's own doc comment) — a
/// mismatch here silently breaks that mode server-side. These tests exist so
/// adding a case without matching its rawValue to the server string fails
/// loudly here instead of surfacing as a confusing runtime mode mismatch.
@Suite("CodeAssistMode")
struct CodeAssistModeTests {
    @Test("assistPlan's rawValue matches the server's assist_plan mode string exactly")
    func assistPlanWireContract() {
        #expect(CodeAssistMode.assistPlan.rawValue == "assist_plan")
        #expect(CodeAssistMode(rawValue: "assist_plan") == .assistPlan)
    }

    @Test("assistPlan is included in allCases alongside every other mode")
    func assistPlanInAllCases() {
        #expect(CodeAssistMode.allCases.contains(.assistPlan))
        #expect(CodeAssistMode.allCases.count == 6)
    }

    @Test("assistPlan has a non-empty label, icon, and help string — the 3 exhaustive switches all cover it")
    func assistPlanUIStrings() {
        #expect(!CodeAssistMode.assistPlan.label.isEmpty)
        #expect(!CodeAssistMode.assistPlan.icon.isEmpty)
        #expect(!CodeAssistMode.assistPlan.help.isEmpty)
    }
}
