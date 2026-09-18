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
        // A named SET, not a count — and not a bag of `contains` checks
        // either, which would silently tolerate a mode being ADDED. Tripping
        // on an addition is the whole point: a new mode has to be carried
        // through the exhaustive label/icon/help switches asserted below.
        // `count == 6` did trip, but failed as "7 != 6" and named nothing;
        // a symmetric difference names exactly what moved. (It sat undetected
        // regardless, because the suite stopped compiling before it could run.)
        let expected: Set<CodeAssistMode> = [.auto, .ask, .plan, .assistPlan,
                                             .review, .document, .execute]
        let actual = Set(CodeAssistMode.allCases)
        #expect(actual == expected,
                "allCases differs: \(actual.symmetricDifference(expected).map(\.rawValue).sorted())")
    }

    @Test("assistPlan has a non-empty label, icon, and help string — the 3 exhaustive switches all cover it")
    func assistPlanUIStrings() {
        #expect(!CodeAssistMode.assistPlan.label.isEmpty)
        #expect(!CodeAssistMode.assistPlan.icon.isEmpty)
        #expect(!CodeAssistMode.assistPlan.help.isEmpty)
    }
}
