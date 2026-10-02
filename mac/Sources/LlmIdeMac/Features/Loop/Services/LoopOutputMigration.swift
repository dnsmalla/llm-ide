import Foundation

/// Moves the files the Plan, Refactoring and Doc Optimization loops generated
/// under the old layout (`llm-doc/plans/INDEX.md`, `llm-doc/refactor/…`,
/// `llm-doc/docs/…`) to `llm-doc/loop/<key>/` (`LoopOutputLayout`).
///
/// **The rule is about the stage's CURRENT Output, not about a transition.** A
/// stage whose Output is now the new default owns the new location; whatever the
/// old default location still holds of the files that stage generated is
/// stranded and is moved. That is what makes it work when there was no saved
/// `loop.json` to compare with, after a crash between saving and moving, and
/// after the UI's "reset to default". A stage the user edited (its Output is not
/// the new default) plans nothing, and `DefaultRevisionCatalog` upgrades a loop's
/// coupled stages all-or-nothing, so one edited stage keeps its whole loop where
/// it was.
///
/// **Conservative on purpose — these are the user's files.**
/// - Only paths a stage OWNS are touched: the Plan loop's `INDEX.md`, `PLAN.md`
///   and `areas/`, the refactor plan, and the doc tree. Everything else in
///   `llm-doc/plans/` — plans saved from chat or exported from the knowledge base
///   — is never read or moved. The doc tree is moved only when its `INDEX.md`
///   exists, the mark of a tree the Doc loop generated.
/// - Move, never copy; never overwrite (an existing destination is skipped);
///   never follow or move a symbolic link; directories are moved file by file, so
///   no link nested in a tree can travel; both ends must stay inside the root the
///   file was found under (the repo for docs, otherwise the root the runner
///   resolved).
/// - Idempotent: once moved, the old location is empty and nothing is planned.
public enum LoopOutputMigration {
    public struct Move: Equatable {
        public enum Kind: Equatable { case file, directory }
        public let source: URL
        public let destination: URL
        public let kind: Kind
        /// The root both `source` and `destination` must stay inside.
        public let boundary: URL
        public let stageKey: String
        /// For a directory: a child that must exist for the tree to count as generated.
        public let requiredChild: String?
    }

    public enum Outcome: Equatable {
        case moved
        /// Some entries moved; `skipped` stayed (a name already at the destination, or a link).
        case partiallyMoved(skipped: Int)
        /// The old location does not exist (nothing was generated there).
        case nothingToMove
        /// The new location already holds the same name(s); left untouched.
        case destinationExists
        case refused(String)
        case failed(String)
    }

    private struct Entry {
        let legacy: String
        let current: String
        let kind: Move.Kind
        var requiredChild: String?
    }

    /// The Output a stage must have for its entries to be moved: the new default.
    private static let currentOutput: [String: String] = [
        "plan-structure-index": LoopOutputLayout.planIndex,
        "plan-director": LoopOutputLayout.planMaster,
        "refactor-plan": LoopOutputLayout.refactorPlan,
        "doc-index": LoopOutputLayout.docsIndex,
        "doc-writer": LoopOutputLayout.docsDir,
    ]

    /// The known generated paths a stage owns.
    private static func entries(forStageKey key: String) -> [Entry] {
        typealias L = LoopOutputLayout
        switch key {
        case "plan-structure-index":
            return [Entry(legacy: L.Legacy.planIndex, current: L.planIndex, kind: .file)]
        case "plan-director":
            return [Entry(legacy: L.Legacy.planMaster, current: L.planMaster, kind: .file),
                    Entry(legacy: L.Legacy.planAreasDir, current: L.planAreasDir, kind: .directory)]
        case "refactor-plan":
            return [Entry(legacy: L.Legacy.refactorPlan, current: L.refactorPlan, kind: .file)]
        case "doc-index":
            return [Entry(legacy: L.Legacy.docsIndex, current: L.docsIndex, kind: .file)]
        case "doc-writer":
            return [Entry(legacy: L.Legacy.docsDir, current: L.docsDir, kind: .directory,
                          requiredChild: "INDEX.md")]
        default:
            return []
        }
    }

    /// The moves implied by the default stages that now write the new layout.
    /// Pure: touches nothing on disk. Safe to call on every load — when nothing is
    /// stranded every move reports `nothingToMove`.
    public static func moves(ensured: LoopEngineProjectStore, gitRoot: URL, projectRoot: URL) -> [Move] {
        var result: [Move] = []
        var seen = Set<String>()
        for loop in ensured.loops {
            for stage in loop.config.stages {
                guard stage.isDefault, let key = stage.defaultKey, stage.outputPath == currentOutput[key] else { continue }
                for entry in entries(forStageKey: key) {
                    // Resolved exactly as the runner resolved it when it wrote the
                    // file, so the move looks in the root the file is really in.
                    let probe = LoopStage(name: stage.name, kind: .skill, order: 0, skillId: stage.skillId,
                                          outputPath: entry.legacy, defaultKey: key)
                    guard let source = LoopStagePaths.resolve(probe, gitRoot: gitRoot,
                                                              projectRoot: projectRoot).output else { continue }
                    // The repo sits inside the project in the clone-into-code layout,
                    // so test the repo first.
                    let boundary = LoopStagePaths.isInside(source, roots: [gitRoot]) ? gitRoot : projectRoot
                    let move = Move(source: source,
                                    destination: boundary.appendingPathComponent(entry.current),
                                    kind: entry.kind, boundary: boundary, stageKey: key,
                                    requiredChild: entry.requiredChild)
                    // Two loops sharing a default key must not plan the same move twice.
                    if seen.insert(move.source.path + "→" + move.destination.path).inserted { result.append(move) }
                }
            }
        }
        // Trees first. A tree is recognised by a marker file inside it (the doc
        // tree's INDEX.md), and the stage that writes that file moves it too — if
        // the single-file move ran first, the marker would be gone and the rest of
        // the tree would be left behind. Moving the tree moves the marker with it,
        // and the later single-file move then finds nothing to do.
        return result.filter { $0.kind == .directory } + result.filter { $0.kind == .file }
    }

    /// Carries the moves out. Never throws: every outcome is reported.
    public static func perform(_ moves: [Move],
                               fileManager fm: FileManager = .default) -> [(move: Move, outcome: Outcome)] {
        moves.map { ($0, perform($0, fileManager: fm)) }
    }

    private static func perform(_ move: Move, fileManager fm: FileManager) -> Outcome {
        guard let sourceType = fileType(of: move.source, fileManager: fm) else { return .nothingToMove }
        if sourceType == .typeSymbolicLink { return .refused("the source is a symbolic link") }
        guard LoopStagePaths.isInside(move.source, roots: [move.boundary]),
              LoopStagePaths.isInside(move.destination, roots: [move.boundary]) else {
            return .refused("a path leaves the project")
        }
        do {
            switch move.kind {
            case .file:
                guard sourceType == .typeRegular else { return .refused("the source is not a regular file") }
                if fileType(of: move.destination, fileManager: fm) != nil { return .destinationExists }
                try fm.createDirectory(at: move.destination.deletingLastPathComponent(),
                                       withIntermediateDirectories: true)
                try fm.moveItem(at: move.source, to: move.destination)
                return .moved
            case .directory:
                guard sourceType == .typeDirectory else { return .refused("the source is not a directory") }
                if let marker = move.requiredChild,
                   fileType(of: move.source.appendingPathComponent(marker), fileManager: fm) != .typeRegular {
                    return .nothingToMove
                }
                let result = try merge(move.source, into: move.destination, fileManager: fm)
                if result.moved == 0 { return result.skipped == 0 ? .nothingToMove : .destinationExists }
                return result.skipped == 0 ? .moved : .partiallyMoved(skipped: result.skipped)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Moves each file of `source` into `destination`, FILE BY FILE (a directory is
    /// created and recursed into, never renamed whole — so a symbolic link nested
    /// anywhere in the tree cannot travel with it). A name that already exists at
    /// the destination, and every link, stays and is counted as skipped. `source`
    /// is removed only once it is empty, and only with a NON-recursive `rmdir`: a
    /// file that appeared in the meantime must survive.
    private static func merge(_ source: URL, into destination: URL,
                              fileManager fm: FileManager) throws -> (moved: Int, skipped: Int) {
        var moved = 0
        var skipped = 0
        for name in try fm.contentsOfDirectory(atPath: source.path) {
            let from = source.appendingPathComponent(name)
            let to = destination.appendingPathComponent(name)
            switch (fileType(of: from, fileManager: fm), fileType(of: to, fileManager: fm)) {
            case (.typeRegular?, nil):
                try fm.createDirectory(at: destination, withIntermediateDirectories: true)
                try fm.moveItem(at: from, to: to)
                moved += 1
            case (.typeDirectory?, nil), (.typeDirectory?, .typeDirectory?):
                let inner = try merge(from, into: to, fileManager: fm)
                moved += inner.moved
                skipped += inner.skipped
            default:
                // A link, a special file, or a name already taken at the destination.
                skipped += 1
            }
        }
        _ = rmdir(source.path)
        return (moved, skipped)
    }

    /// The item's type WITHOUT following a symbolic link, or nil when it does not exist.
    private static func fileType(of url: URL, fileManager fm: FileManager) -> FileAttributeType? {
        (try? fm.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType
    }
}
