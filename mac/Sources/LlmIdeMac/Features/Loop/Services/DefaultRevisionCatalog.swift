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
            LoopOutputLayout.movedStageKeys.map { ($0, LoopOutputLayout.revision) }),
        history: [
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
            "refactor-plan": [1: LoopStage(
                name: "Refactor Plan", kind: .skill, order: 0,
                skillId: "skills/refactor-planner",
                targetPath: ".",
                outputPath: LoopOutputLayout.Legacy.refactorPlan,
                prompt: LoopStageDetector.refactorPlanPrompt)],
            "refactor-apply": [1: LoopStage(
                name: "Refactor Apply", kind: .skill, order: 1,
                skillId: "skills/refactor-apply",
                targetPath: LoopOutputLayout.Legacy.refactorPlan,
                outputPath: ".",
                prompt: LoopStageDetector.refactorApplyPrompt)],
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
    static func upgradingDefaultRevisions(
        in loops: [LoopDefinition], gitRoot: URL?,
        catalog: DefaultRevisionCatalog = .shipped
    ) -> (loops: [LoopDefinition], changes: [RevalidationChange]) {
        var changes: [RevalidationChange] = []
        let result: [LoopDefinition] = loops.map { loop in
            guard let loopKey = loop.defaultKey else { return loop }
            let defaults = defaultStages(forLoop: loopKey, gitRoot: gitRoot)
            var updated = loop
            var mutated = false
            updated.config.stages = loop.config.stages.map { stage in
                guard stage.isDefault, let key = stage.defaultKey,
                      let def = defaults.first(where: { $0.defaultKey == key }) else { return stage }
                let target = catalog.current(key)
                let revision = stage.defaultRevision ?? 1
                guard revision < target, var old = catalog.history[key]?[revision] else { return stage }
                // Equality is EXACT over `kind`, `skillId`, `targetPath`,
                // `outputPath`, `prompt` and `check`. A detected command
                // differs per repo, so a stage carrying `detectedCommand` is
                // compared against its OWN recorded detection (never the
                // history value): the command is unedited iff it still equals it.
                if let detected = stage.detectedCommand { old.command = detected }
                guard stage.hasSameDefaultContent(as: old) else { return stage }
                var upgraded = stage.adoptingDefaultContent(of: def)
                upgraded.defaultRevision = target
                changes.append(RevalidationChange(loopName: loop.name, stageName: stage.name,
                                                   kind: .upgradedDefault(revision: target)))
                mutated = true
                return upgraded
            }
            // The loop's goal / acceptance text names the output paths too. Bring it
            // forward ONLY when it still equals the text the loop was created with —
            // an edited text is the user's and nothing rewrites it.
            if let loopKey = loop.defaultKey,
               let movedKey = Self.contractGateStageKey[loopKey], catalog.current(movedKey) >= LoopOutputLayout.revision,
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
