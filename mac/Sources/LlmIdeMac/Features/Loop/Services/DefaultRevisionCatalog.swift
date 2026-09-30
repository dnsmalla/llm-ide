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

    static let shipped = DefaultRevisionCatalog()

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
                guard revision < target,
                      let old = catalog.history[key]?[revision],
                      stage.hasSameDefaultContent(as: old) else { return stage }
                var upgraded = stage.adoptingDefaultContent(of: def)
                upgraded.defaultRevision = target
                changes.append(RevalidationChange(loopName: loop.name, stageName: stage.name,
                                                   kind: .upgradedDefault(revision: target)))
                mutated = true
                return upgraded
            }
            return mutated ? updated : loop
        }
        return (result, changes)
    }

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
