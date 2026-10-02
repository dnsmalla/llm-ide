import Foundation
import LlmIdeMacLib

// Asserts the `llm-doc/loop/<loop key>/` output layout: the shipped defaults use
// it, and a project saved by an older build is brought forward ONLY where it is
// provably unedited (stage content equal to its recorded revision-1 content, goal
// and acceptance text equal to the text the loop was created with).

#if FEATURE_AUTOTASK
private let legacyPlanAcceptance = "llm-doc/plans/INDEX.md and PLAN.md exist, reference every active plan and the files and "
    + "functions it touches, match the current folder structure, and every plan file stays "
    + "within the 250-line limit."
private let legacyDocsAcceptance = "llm-doc/docs/INDEX.md lists every area, every listed page exists within 250 lines, and "
    + "every code citation resolves to a real file or symbol."

/// The stage as an older build (stage revision 1) stored it.
private func asRevisionOne(_ stage: LoopStage) -> LoopStage {
    var legacy = stage
    legacy.defaultRevision = nil
    switch stage.defaultKey {
    case "plan-structure-index": legacy.outputPath = "llm-doc/plans/INDEX.md"
    case "plan-director": legacy.outputPath = "llm-doc/plans/PLAN.md"
    case "refactor-plan": legacy.outputPath = "llm-doc/refactor/REFACTOR.md"
    case "refactor-apply": legacy.targetPath = "llm-doc/refactor/REFACTOR.md"
    case "doc-index": legacy.outputPath = "llm-doc/docs/INDEX.md"
    case "doc-writer":
        legacy.targetPath = "llm-doc/docs/INDEX.md"
        legacy.outputPath = "llm-doc/docs"
    default: break
    }
    return legacy
}

private func legacyStore(from loops: [LoopDefinition]) -> LoopEngineProjectStore {
    LoopEngineProjectStore(loops: loops.map { loop in
        var copy = loop
        copy.config.stages = loop.config.stages.map(asRevisionOne)
        if loop.defaultKey == LoopDefaultLoopKey.plan { copy.acceptanceCriteria = legacyPlanAcceptance }
        if loop.defaultKey == LoopDefaultLoopKey.docs { copy.acceptanceCriteria = legacyDocsAcceptance }
        return copy
    })
}

private func stage(_ key: String, in store: LoopEngineProjectStore) -> LoopStage? {
    store.loops.flatMap(\.config.stages).first { $0.defaultKey == key }
}

private func upgradedStageNames(_ changes: [LoopStageDetector.RevalidationChange]) -> Set<String> {
    Set(changes.compactMap { change -> String? in
        if case .upgradedDefault = change.kind { return change.stageName }
        return nil
    })
}

func runLoopOutputLayoutChecks() {
    print("loop output layout (llm-doc/loop/<key>/)")
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("loop-output-layout-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    // A Package.swift gives the Refactoring loop a detected test command, so its
    // Refactor Apply stage exists (it is only built when tests can verify the edit).
    try? "".write(to: root.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(at: root) }

    // 1. Fresh defaults use the new layout; the Plan loop's INPUT does not move.
    let fresh = LoopEngineProjectStore(loops: LoopStageDetector.defaultLoops(gitRoot: root))
    expect(stage("plan-structure-index", in: fresh)?.outputPath == "llm-doc/loop/plan/INDEX.md",
           "Structure Index writes llm-doc/loop/plan/INDEX.md")
    expect(stage("plan-director", in: fresh)?.outputPath == "llm-doc/loop/plan/PLAN.md",
           "Plan Director writes llm-doc/loop/plan/PLAN.md")
    expect(stage("plan-structure-index", in: fresh)?.targetPath == "llm-doc/plans"
           && stage("plan-director", in: fresh)?.targetPath == "llm-doc/plans",
           "the Plan loop still READS the collected plans from llm-doc/plans (Save Plan and the KB export write there)")
    expect(stage("refactor-plan", in: fresh)?.outputPath == "llm-doc/loop/refactor/REFACTOR.md"
           && stage("refactor-apply", in: fresh)?.targetPath == "llm-doc/loop/refactor/REFACTOR.md",
           "the refactor plan lives under llm-doc/loop/refactor/ and Refactor Apply reads it from there")
    expect(stage("doc-index", in: fresh)?.outputPath == "llm-doc/loop/docs/INDEX.md"
           && stage("doc-writer", in: fresh)?.targetPath == "llm-doc/loop/docs/INDEX.md"
           && stage("doc-writer", in: fresh)?.outputPath == "llm-doc/loop/docs",
           "the doc tree lives under llm-doc/loop/docs/")
    let moved = ["plan-structure-index", "plan-director", "refactor-plan", "refactor-apply", "doc-index", "doc-writer"]
    expect(moved.allSatisfy { stage($0, in: fresh)?.defaultRevision == 2 },
           "every moved default is stamped revision 2 when it is created")
    let freshPlan = fresh.loops.first { $0.defaultKey == LoopDefaultLoopKey.plan }
    expect(freshPlan?.acceptanceCriteria?.contains("llm-doc/loop/plan/INDEX.md") == true,
           "a new Plan loop states the new output path in its acceptance criteria")

    // 2. A project saved by an older build, untouched by the user, is brought forward.
    let (upgraded, changes) = LoopStageDetector.ensureDefaultLoops(
        in: legacyStore(from: fresh.loops), gitRoot: root)
    expect(stage("plan-director", in: upgraded)?.outputPath == "llm-doc/loop/plan/PLAN.md"
           && stage("plan-structure-index", in: upgraded)?.outputPath == "llm-doc/loop/plan/INDEX.md",
           "an unedited Plan loop is moved to llm-doc/loop/plan/")
    expect(stage("refactor-plan", in: upgraded)?.outputPath == "llm-doc/loop/refactor/REFACTOR.md"
           && stage("refactor-apply", in: upgraded)?.targetPath == "llm-doc/loop/refactor/REFACTOR.md",
           "an unedited Refactoring loop is moved to llm-doc/loop/refactor/")
    expect(stage("doc-index", in: upgraded)?.outputPath == "llm-doc/loop/docs/INDEX.md"
           && stage("doc-writer", in: upgraded)?.outputPath == "llm-doc/loop/docs",
           "an unedited Doc Optimization loop is moved to llm-doc/loop/docs/")
    expect(moved.allSatisfy { stage($0, in: upgraded)?.defaultRevision == 2 },
           "the upgraded stages carry revision 2")
    let names = upgradedStageNames(changes)
    expect(["Structure Index", "Plan Director", "Refactor Plan", "Refactor Apply", "Doc Index", "Doc Writer"]
        .allSatisfy(names.contains), "every upgrade is reported, so the rewrite of loop.json is never silent")
    let upgradedPlan = upgraded.loops.first { $0.defaultKey == LoopDefaultLoopKey.plan }
    let upgradedDocs = upgraded.loops.first { $0.defaultKey == LoopDefaultLoopKey.docs }
    expect(upgradedPlan?.acceptanceCriteria?.contains("llm-doc/loop/plan/INDEX.md") == true
           && upgradedDocs?.acceptanceCriteria?.contains("llm-doc/loop/docs/INDEX.md") == true,
           "an unedited goal/acceptance text is brought forward with the paths")

    // 3. Idempotent: a second pass changes nothing.
    let (again, againChanges) = LoopStageDetector.ensureDefaultLoops(in: upgraded, gitRoot: root)
    expect(again == upgraded && upgradedStageNames(againChanges).isEmpty,
           "running the upgrade again changes nothing and reports nothing")

    // 4. Edited content is never overwritten.
    var edited = legacyStore(from: fresh.loops)
    for index in edited.loops.indices {
        for stageIndex in edited.loops[index].config.stages.indices
        where edited.loops[index].config.stages[stageIndex].defaultKey == "plan-director" {
            edited.loops[index].config.stages[stageIndex].outputPath = "my/own/PLAN.md"
        }
        if edited.loops[index].defaultKey == LoopDefaultLoopKey.docs {
            edited.loops[index].acceptanceCriteria = "My own acceptance: llm-doc/docs/INDEX.md plus a human review."
        }
    }
    let (keptEdits, _) = LoopStageDetector.ensureDefaultLoops(in: edited, gitRoot: root)
    expect(stage("plan-director", in: keptEdits)?.outputPath == "my/own/PLAN.md"
           && stage("plan-director", in: keptEdits)?.defaultRevision == nil,
           "an edited stage keeps the user's output and stays below the current revision (the UI offers a reset)")
    expect(stage("plan-structure-index", in: keptEdits)?.outputPath == "llm-doc/plans/INDEX.md"
           && stage("plan-structure-index", in: keptEdits)?.defaultRevision == nil,
           "its unedited partner stays with it: a loop's moved stages are upgraded all-or-nothing")
    expect(keptEdits.loops.first { $0.defaultKey == LoopDefaultLoopKey.plan }?.acceptanceCriteria == legacyPlanAcceptance,
           "…and the loop's acceptance text is not rewritten to a folder the loop does not write")
    expect(stage("refactor-plan", in: keptEdits)?.outputPath == "llm-doc/loop/refactor/REFACTOR.md"
           && stage("doc-index", in: keptEdits)?.outputPath == "llm-doc/loop/docs/INDEX.md",
           "other loops with no edits still move")
    expect(keptEdits.loops.first { $0.defaultKey == LoopDefaultLoopKey.docs }?.acceptanceCriteria
           == "My own acceptance: llm-doc/docs/INDEX.md plus a human review.",
           "an edited acceptance text is the user's and is left exactly as written")

    // 5. Editing only a PROMPT also blocks the whole loop (content equality is exact).
    var promptEdited = legacyStore(from: fresh.loops)
    for index in promptEdited.loops.indices {
        for stageIndex in promptEdited.loops[index].config.stages.indices
        where promptEdited.loops[index].config.stages[stageIndex].defaultKey == "doc-index" {
            promptEdited.loops[index].config.stages[stageIndex].prompt =
                (promptEdited.loops[index].config.stages[stageIndex].prompt ?? "") + " Keep it short."
        }
    }
    let (keptPrompt, _) = LoopStageDetector.ensureDefaultLoops(in: promptEdited, gitRoot: root)
    expect(stage("doc-index", in: keptPrompt)?.outputPath == "llm-doc/docs/INDEX.md"
           && stage("doc-writer", in: keptPrompt)?.outputPath == "llm-doc/docs"
           && stage("doc-writer", in: keptPrompt)?.targetPath == "llm-doc/docs/INDEX.md",
           "an edited Doc Index prompt keeps the doc writer reading the index it still writes")
    expect(keptPrompt.loops.first { $0.defaultKey == LoopDefaultLoopKey.docs }?.acceptanceCriteria == legacyDocsAcceptance,
           "…and the docs loop's acceptance text keeps naming the old location")
}
#endif
