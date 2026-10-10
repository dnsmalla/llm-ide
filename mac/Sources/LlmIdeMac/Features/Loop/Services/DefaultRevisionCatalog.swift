import Foundation

/// What each detector-default stage's content looked like in earlier shipped
/// revisions, so a persisted default can be upgraded when (and only when) the
/// user never edited it.
///
/// A stage's `defaultRevision` is the revision its content was last brought to;
/// `nil` reads as 1. To ship a change to a default stage's content: bump
/// `currentRevisions[key]`, and record the PREVIOUS content in `history` (the
/// stage as `rawDefaultStages` used to build it). A persisted stage whose
/// content equals a recorded revision is replaced automatically; any other
/// stage below the current revision is shown as "update available" with a
/// one-click reset (`LoopStageDetector.resetToDefault`). Keys are never renamed.
struct DefaultRevisionCatalog {
    /// Current revision per stage key; a key not listed is at revision 1.
    var currentRevisions: [String: Int] = [:]
    /// `history[key][revision]` = the content shipped at that revision.
    var history: [String: [Int: LoopStage]] = [:]

    /// Revision 2 moved the generated output of the Plan, Refactoring and Doc
    /// Optimization loops under `llm-doc/loop/<key>/` (`LoopOutputLayout`).
    static let shipped = DefaultRevisionCatalog(
        currentRevisions: Dictionary(uniqueKeysWithValues:
            LoopOutputLayout.movedStageKeys.map { ($0, LoopOutputLayout.revision) })
            // Revision 2 of `test`: the Test loop grew its structure/map/write/ledger stages.
            .merging(["test": 2]) { a, _ in a }
            // Revision 3 of the Refactoring plan and apply stages: the premium loop's prompts.
            // Revision 2 of its test stage: it records its detected command as provenance.
            .merging(["refactor-plan": 3, "refactor-apply": 3, "refactor-test": 2]) { _, new in new },
        history: [
            "test": [1: LoopStage(name: "Test", kind: .shellCommand, order: 0)],
            "plan-structure-index": [1: LoopStage(
                name: "Structure Index", kind: .skill, order: 0,
                skillId: "skills/plan-structure-index",
                targetPath: LoopOutputLayout.collectedPlansDir,
                outputPath: LoopOutputLayout.Legacy.planIndex,
                prompt: LoopStageDetector.planStructureIndexPrompt)],
            "plan-director": [1: LoopStage(
                name: "Plan Director", kind: .skill, order: 1,
                skillId: "skills/plan-director",
                targetPath: LoopOutputLayout.collectedPlansDir,
                outputPath: LoopOutputLayout.Legacy.planMaster,
                prompt: LoopStageDetector.planDirectorPrompt)],
            "refactor-plan": [
                1: LoopStage(
                    name: "Refactor Plan", kind: .skill, order: 0,
                    skillId: "skills/refactor-planner",
                    targetPath: ".",
                    outputPath: LoopOutputLayout.Legacy.refactorPlan,
                    prompt: refactorPlanPromptRevision2),
                2: LoopStage(
                    name: "Refactor Plan", kind: .skill, order: 0,
                    skillId: "skills/refactor-planner",
                    targetPath: ".",
                    outputPath: LoopOutputLayout.refactorPlan,
                    prompt: refactorPlanPromptRevision2),
            ],
            "refactor-apply": [
                1: LoopStage(
                    name: "Refactor Apply", kind: .skill, order: 1,
                    skillId: "skills/refactor-apply",
                    targetPath: LoopOutputLayout.Legacy.refactorPlan,
                    outputPath: ".",
                    prompt: refactorApplyPromptRevision2),
                2: LoopStage(
                    name: "Refactor Apply", kind: .skill, order: 1,
                    skillId: "skills/refactor-apply",
                    targetPath: LoopOutputLayout.refactorPlan,
                    outputPath: ".",
                    prompt: refactorApplyPromptRevision2),
            ],
            // Revision 2 of the test stage: it records its detected command as provenance
            // (`detectedCommand`); its content is unchanged from revision 1.
            "refactor-test": [1: LoopStage(name: "Test", kind: .shellCommand, order: 2)],
            "doc-index": [1: LoopStage(
                name: "Doc Index", kind: .skill, order: 0,
                skillId: "skills/doc-structure-index",
                targetPath: ".",
                outputPath: LoopOutputLayout.Legacy.docsIndex,
                prompt: LoopStageDetector.docIndexPrompt)],
            "doc-writer": [1: LoopStage(
                name: "Doc Writer", kind: .skill, order: 1,
                skillId: "skills/doc-writer",
                targetPath: LoopOutputLayout.Legacy.docsIndex,
                outputPath: LoopOutputLayout.Legacy.docsDir,
                prompt: LoopStageDetector.docWriterPrompt)],
        ])

    /// Frozen revision-2 texts (the revision-1 text was identical). History must
    /// keep the exact strings users were shipped, so these never follow the live prompts.
    private static let resolvePathsRuleRevision2 = "Resolve relative paths against the repo root first, then the "
        + "project root (the directory containing system/project.json — the repo root itself, or two "
        + "levels up when the repo is checked out under code/)."

    private static let refactorPlanPromptRevision2 = "Write or update the refactor plan at the Output path for the code "
        + "under the Input (the repo, or a subtree of it). " + resolvePathsRuleRevision2 + " Survey the structure "
        + "and write batches, each with a stable ID (R1, R2, …), a status (todo, done or skipped), the "
        + "files it touches, its intent, and its risk. Cover: directory layout by responsibility, files "
        + "over 500 lines to split, duplicated logic, naming consistency, dead code only when provably "
        + "unreferenced, and an AI-friendly setup — a root CLAUDE.md/AGENTS.md describing commands, "
        + "architecture and invariants, per-area READMEs, an index of entry points, and module-boundary "
        + "rules. Keep each batch small (one concern, at most about 10 files) and behaviour-preserving, "
        + "ordered safest first. When the plan already exists, update statuses and add new batches; never "
        + "reorder or renumber existing ones. Never edit code."

    private static let refactorApplyPromptRevision2 = "Apply exactly one batch of the refactor plan at the Input to the "
        + "code under the Output path: the FIRST batch whose status is todo. " + resolvePathsRuleRevision2
        + " Apply it behaviour-preservingly: a move or rename updates every import and reference, no "
        + "public API changes unless the batch says so, and no test is weakened, skipped or deleted "
        + "(updating import and path references inside tests and build config is allowed when the move "
        + "requires it). Then mark the "
        + "batch done in the plan with a one-line note — or skipped with the reason when it cannot be done "
        + "safely. Never touch more than that batch, and never commit. With no todo batch left, change "
        + "nothing."
    func current(_ key: String) -> Int { currentRevisions[key] ?? 1 }
}

extension LoopStage {
    /// The fields a default's revision owns. User-tunable state (`enabled`,
    /// `severity`, `timeoutSeconds`, name, order, id) is deliberately absent.
    func hasSameDefaultContent(as other: LoopStage) -> Bool {
        kind == other.kind && command == other.command && skillId == other.skillId
            && targetPath == other.targetPath && outputPath == other.outputPath
            && prompt == other.prompt && check == other.check
    }

    /// `self` with its default content (and revision) taken from `default`,
    /// keeping the user's `enabled` / `severity` / `timeoutSeconds` / name.
    func adoptingDefaultContent(of def: LoopStage) -> LoopStage {
        var copy = self
        copy.kind = def.kind
        copy.command = def.command
        copy.detectedCommand = def.detectedCommand
        copy.skillId = def.skillId
        copy.targetPath = def.targetPath
        copy.outputPath = def.outputPath
        copy.prompt = def.prompt
        copy.check = def.check
        copy.defaultRevision = def.defaultRevision
        return copy
    }
}

extension LoopStageDetector {
    /// Upgrade every persisted default stage that is behind the catalog and
    /// provably unedited (its content equals the recorded content of its own
    /// revision). Edited stages are left alone — the UI offers a reset.
    ///
    /// **Stages that moved together move together.** The stages named in
    /// `LoopOutputLayout.movedStageKeys` read and write each other's files (the
    /// doc writer reads the doc index; the refactor apply reads the refactor
    /// plan), so within one loop they are upgraded ALL-OR-NOTHING: if any of them
    /// was edited, none is upgraded. Upgrading one and not its partner would
    /// point the pair at two different folders.
    static func upgradingDefaultRevisions(
        in loops: [LoopDefinition], gitRoot: URL?,
        catalog: DefaultRevisionCatalog = .shipped
    ) -> (loops: [LoopDefinition], changes: [RevalidationChange]) {
        enum Verdict { case unchanged, upgrade(LoopStage), blocked }
        let coupledKeys = Set(LoopOutputLayout.movedStageKeys)
        var changes: [RevalidationChange] = []
        let result: [LoopDefinition] = loops.map { loop in
            guard let loopKey = loop.defaultKey else { return loop }
            let defaults = defaultStages(forLoop: loopKey, gitRoot: gitRoot)

            // Phase 1: what would happen to each stage on its own.
            let verdicts: [Verdict] = loop.config.stages.map { stage in
                guard stage.isDefault, let key = stage.defaultKey,
                      let def = defaults.first(where: { $0.defaultKey == key }) else { return .unchanged }
                let target = catalog.current(key)
                let revision = stage.defaultRevision ?? 1
                guard revision < target else { return .unchanged }
                // Without a recorded revision we cannot prove the stage unedited.
                guard var old = catalog.history[key]?[revision] else { return .blocked }
                // Equality is EXACT over `kind`, `skillId`, `targetPath`,
                // `outputPath`, `prompt` and `check`. A detected command
                // differs per repo, so a stage carrying `detectedCommand` is
                // compared against its OWN recorded detection (never the
                // history value): the command is unedited iff it still equals it.
                if let detected = stage.detectedCommand { old.command = detected }
                guard stage.hasSameDefaultContent(as: old) else { return .blocked }
                var upgraded = stage.adoptingDefaultContent(of: def)
                upgraded.defaultRevision = target
                return .upgrade(upgraded)
            }

            // Phase 2: the coupled stages go together or not at all.
            func isCoupled(_ stage: LoopStage) -> Bool {
                stage.isDefault && stage.defaultKey.map(coupledKeys.contains) == true
            }
            let coupledBlocked = zip(loop.config.stages, verdicts).contains { stage, verdict in
                if case .blocked = verdict { return isCoupled(stage) }
                return false
            }
            var updated = loop
            var mutated = false
            updated.config.stages = zip(loop.config.stages, verdicts).map { stage, verdict in
                guard case let .upgrade(upgraded) = verdict, !(isCoupled(stage) && coupledBlocked) else { return stage }
                changes.append(RevalidationChange(loopName: loop.name, stageName: stage.name,
                                                   kind: .upgradedDefault(revision: upgraded.defaultRevision ?? 0)))
                mutated = true
                return upgraded
            }

            // The loop's goal / acceptance text names the output paths too. Bring it
            // forward ONLY when it still equals the text the loop was created with
            // (an edited text is the user's and nothing rewrites it) AND the loop's
            // moved stages are all on the new layout — otherwise the text would name
            // a folder the loop does not write.
            let movedStagesCurrent = updated.config.stages.filter(isCoupled).allSatisfy { stage in
                (stage.defaultRevision ?? 1) >= catalog.current(stage.defaultKey ?? "")
            }
            if Self.contractGateStageKey[loopKey] != nil, !coupledBlocked, movedStagesCurrent,
               (loopKey == LoopDefaultLoopKey.test
                    ? updated.config.stages.contains { $0.defaultKey == "test-write" }
                    : updated.config.stages.contains(where: isCoupled)),
               let legacy = legacyLoopContract(loopKey), let current = defaultLoopContract(loopKey) {
                var textChanged = false
                if updated.goal == legacy.goal, legacy.goal != current.goal {
                    updated.goal = current.goal
                    textChanged = true
                }
                if updated.acceptanceCriteria == legacy.acceptance, legacy.acceptance != current.acceptance {
                    updated.acceptanceCriteria = current.acceptance
                    textChanged = true
                }
                if textChanged {
                    changes.append(RevalidationChange(loopName: loop.name, stageName: "Goal and acceptance criteria",
                                                       kind: .upgradedDefault(revision: LoopOutputLayout.revision)))
                    mutated = true
                }
            }
            return mutated ? updated : loop
        }
        return (result, changes)
    }

    /// Which moved stage gates the goal / acceptance text upgrade of a loop.
    private static let contractGateStageKey = [
        LoopDefaultLoopKey.plan: "plan-director",
        LoopDefaultLoopKey.docs: "doc-writer",
        LoopDefaultLoopKey.test: "test-write",
        LoopDefaultLoopKey.refactor: "refactor-graph",
    ]

    /// Whether a newer shipped revision of this default exists that was not
    /// applied automatically (the user edited the stage).
    static func updateAvailable(for stage: LoopStage, catalog: DefaultRevisionCatalog = .shipped) -> Bool {
        guard stage.isDefault, let key = stage.defaultKey else { return false }
        return (stage.defaultRevision ?? 1) < catalog.current(key)
    }

    /// The stage reset to the current shipped content of the default loop
    /// `loopKey` owns, or `nil` when no such default exists for `gitRoot`.
    static func resetToDefault(_ stage: LoopStage, loopKey: String?, gitRoot: URL?) -> LoopStage? {
        guard let loopKey, let key = stage.defaultKey,
              let def = defaultStages(forLoop: loopKey, gitRoot: gitRoot).first(where: { $0.defaultKey == key })
        else { return nil }
        return stage.adoptingDefaultContent(of: def)
    }
}

extension LoopStageDetector {
    /// What a stage default shipped as at `revision`, for fixtures that simulate an
    /// older build's saved stages (the contract lab). Nil when none was recorded.
    public static func shippedStage(key: String, revision: Int) -> LoopStage? {
        DefaultRevisionCatalog.shipped.history[key]?[revision]
    }

    /// The revision a stage default is shipped at now.
    public static func shippedRevision(key: String) -> Int {
        DefaultRevisionCatalog.shipped.current(key)
    }
}
