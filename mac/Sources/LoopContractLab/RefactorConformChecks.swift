import Foundation
import LlmIdeMacLib

// The Refactor Conform stage (design doc §3.4, §5.6): a skill stage that
// applies code, but whose own skill is OPTIONAL — a repo without it
// installed still finishes the batch instead of the run failing.

#if FEATURE_AUTOTASK
func runRefactorConformChecks() {
    print("refactor conform stage")

    // (a) Conform applies code and is optional; Apply applies code but is NOT.
    let conform = LoopStage(name: "Refactor Conform", kind: .skill, order: 0, skillId: "skills/refactor-conform")
    expect(conform.appliesCode, "a refactor-conform stage applies code")
    expect(conform.skillIsOptional, "a refactor-conform stage's skill is optional")
    let apply = LoopStage(name: "Refactor Apply", kind: .skill, order: 0, skillId: "skills/refactor-apply")
    expect(apply.appliesCode, "a refactor-apply stage applies code")
    expect(!apply.skillIsOptional, "a refactor-apply stage's skill is NOT optional")

    // (b) No other default skill stage is optional.
    for skillId in ["skills/test-gap-writer", "skills/test-structure-setup", "skills/refactor-planner",
                     "skills/doc-structure-index", "skills/doc-writer"] {
        let stage = LoopStage(name: "Stage", kind: .skill, order: 0, skillId: skillId)
        expect(!stage.skillIsOptional, "\(skillId)'s stage is not optional")
    }

    // (c) The prompt names RULES.md and RULE-REVIEW.md as beside the Input
    // (never a concrete path), never touches tests/build config, and ends
    // with a Conformed: line.
    let prompt = LoopStageDetector.refactorConformPrompt
    expect(prompt.contains("RULES.md"), "the conform prompt names RULES.md")
    expect(prompt.contains("Conformed:"), "the conform prompt ends with a Conformed: line")
    expect(prompt.contains("never edit tests or build config"),
           "the conform prompt forbids editing tests or build config")
    expect(!prompt.contains("llm-doc"), "the conform prompt names no concrete path")
    expect(prompt.contains("the Input") && prompt.contains("the Output"),
           "the conform prompt defers to the stage's Input/Output fields")

    // (d) Stage order: Conform sits between Apply and Check when a test
    // command (and a check command) are detected.
    let fm = FileManager.default
    let root = makeTempDir()
    defer { try? fm.removeItem(at: root) }
    let makefile = root.appendingPathComponent("Makefile")
    try? "test:\n\trun-tests\nlint:\n\tlint-it\n".write(to: makefile, atomically: true, encoding: .utf8)
    let stages = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: root)
    let keys = stages.map(\.defaultKey)
    expect(keys.firstIndex(of: "refactor-conform").map { idx in
        keys[idx - 1] == "refactor-apply" && keys[idx + 1] == "refactor-check"
    } == true, "Refactor Conform runs right after Apply and right before Check")

    // (e) Owned by the refactor loop (the split-migration routing table).
    expect(LoopStageDetector.stageKeyOwner["refactor-conform"] == LoopDefaultLoopKey.refactor,
           "refactor-conform is owned by the refactor loop")
}
#endif
