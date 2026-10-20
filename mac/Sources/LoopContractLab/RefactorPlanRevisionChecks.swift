import Foundation
import LlmIdeMacLib

// Revision 4 of the Refactoring plan/apply prompts and revision 2 of the
// plan-check (design doc §3.2, §3.5, §3.7): plan/apply read RULES.md first,
// the planner knows the Mikado `blocked` status and `- Replaces:` rule, and
// plans that scale get `- Area:` and REFACTOR-DONE.md. The previous texts
// must stay frozen in `DefaultRevisionCatalog.history` so a persisted,
// unedited stage upgrades automatically (`LoopStageDetector.shippedStage`).

#if FEATURE_AUTOTASK
func runRefactorPlanRevisionChecks() {
    print("refactor plan/apply prompt revisions")

    // (a) current revisions bumped.
    expect(LoopStageDetector.shippedRevision(key: "refactor-plan") == 4,
           "refactor-plan is shipped at revision 4")
    expect(LoopStageDetector.shippedRevision(key: "refactor-apply") == 4,
           "refactor-apply is shipped at revision 4")
    expect(LoopStageDetector.shippedRevision(key: "refactor-plan-check") == 2,
           "refactor-plan-check is shipped at revision 2")

    // (b) the previous (revision 3 / revision 1) content is frozen in history,
    // and differs from the live prompt — a persisted stage at the old
    // revision can still be proven unedited and upgraded.
    let oldPlan = LoopStageDetector.shippedStage(key: "refactor-plan", revision: 3)?.prompt
    expect(oldPlan != nil, "revision 3 of refactor-plan is recorded in history")
    expect(oldPlan != LoopStageDetector.refactorPlanPrompt,
           "the frozen revision-3 plan prompt differs from the live (revision 4) prompt")
    expect(oldPlan?.contains("RULES.md") == false,
           "the frozen revision-3 plan prompt predates the RULES.md rule")

    let oldApply = LoopStageDetector.shippedStage(key: "refactor-apply", revision: 3)?.prompt
    expect(oldApply != nil, "revision 3 of refactor-apply is recorded in history")
    expect(oldApply != LoopStageDetector.refactorApplyPrompt,
           "the frozen revision-3 apply prompt differs from the live (revision 4) prompt")
    expect(oldApply?.contains("RULES.md") == false,
           "the frozen revision-3 apply prompt predates the RULES.md rule")

    let oldPlanCheck = LoopStageDetector.shippedStage(key: "refactor-plan-check", revision: 1)?.check
    expect(oldPlanCheck != nil, "revision 1 of refactor-plan-check is recorded in history")
    expect(oldPlanCheck != LoopStageDetector.refactorPlanCheckSpec,
           "the frozen revision-1 plan-check spec differs from the live (revision 2) spec")
    expect(oldPlanCheck?.sectionRules.first?.requiredLinePrefixes.contains("- Rules:") == false,
           "the frozen revision-1 plan-check spec predates the `- Rules:` requirement")

    // (c) the live plan prompt reads RULES.md, carries the Mikado blocked/
    // Replaces rule, and the scale rules (Area / REFACTOR-DONE.md).
    let plan = LoopStageDetector.refactorPlanPrompt
    for needle in ["RULES.md", "- Rules:", "blocked", "- Replaces:", "- Area:", "REFACTOR-DONE.md"] {
        expect(plan.contains(needle), "the live refactor-plan prompt mentions \"\(needle)\"")
    }
    // Still path-agnostic and still pins the batch heading (pre-existing contract).
    expect(!plan.contains("llm-doc"), "the live refactor-plan prompt names no concrete path")
    expect(plan.contains("no other headings may start with `### R`"),
           "the live refactor-plan prompt still pins the batch heading")

    // (d) the live apply prompt reads RULES.md before editing.
    let apply = LoopStageDetector.refactorApplyPrompt
    expect(apply.contains("RULES.md"), "the live refactor-apply prompt mentions RULES.md")
    expect(!apply.contains("llm-doc"), "the live refactor-apply prompt names no concrete path")

    // (e) the live plan-check section rule also requires `- Rules:`.
    let sectionRule = LoopStageDetector.refactorPlanCheckSpec.sectionRules.first
    expect(sectionRule?.requiredLinePrefixes.contains("- Rules:") == true,
           "the live refactor-plan-check section rule requires a `- Rules:` line")
}
#endif
