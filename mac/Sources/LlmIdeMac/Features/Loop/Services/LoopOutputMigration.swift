import Foundation

/// Moves the files the Plan, Refactoring and Doc Optimization loops generated
/// under the old layout (`llm-doc/plans/INDEX.md`, `llm-doc/refactor/…`,
/// `llm-doc/docs/…`) to `llm-doc/loop/<key>/` (`LoopOutputLayout`), at the moment
/// a project's stored stages are brought forward to stage revision 2.
///
/// **Conservative on purpose — these are the user's files.**
/// - Only the paths a moved stage OWNS are touched: the Plan loop's `INDEX.md`,
///   `PLAN.md` and `areas/`, the refactor plan, and the Doc loop's output
///   directory (the stage's own Output, which `Doc Check` treats as wholly
///   generated). Everything else in `llm-doc/plans/` — plans saved from chat or
///   exported from the knowledge base — is never read or moved.
/// - A stage the user EDITED is not upgraded (see `DefaultRevisionCatalog`), so
///   it produces no move: a move is planned only for a stage whose saved Output
///   was exactly the old default and whose ensured Output is exactly the new one.
/// - Move, never copy; never overwrite (an existing destination is skipped);
///   never follow a symbolic link; both ends must stay inside the root the file
///   was found under (the repo for docs, otherwise the root the runner resolved).
/// - Idempotent: after a move the saved stage already holds the new Output, so
///   the next load plans nothing.
public enum LoopOutputMigration {
    public struct Move: Equatable {
        public enum Kind: Equatable { case file, directory }
        public let source: URL
        public let destination: URL
        public let kind: Kind
        /// The root both `source` and `destination` must stay inside.
        public let boundary: URL
        public let stageKey: String
    }

    public enum Outcome: Equatable {
        case moved
        /// The old location does not exist (nothing was generated there yet).
        case nothingToMove
        /// The new location already holds a file of the same name; left untouched.
        case destinationExists
        case refused(String)
        case failed(String)
    }

    private struct Entry {
        let legacy: String
        let current: String
        let kind: Move.Kind
    }

    /// The Output a stage's move is keyed on: saved == `legacy` and ensured == `current`.
    private static let primaryOutput: [String: (legacy: String, current: String)] = [
        "plan-structure-index": (LoopOutputLayout.Legacy.planIndex, LoopOutputLayout.planIndex),
        "plan-director": (LoopOutputLayout.Legacy.planMaster, LoopOutputLayout.planMaster),
        "refactor-plan": (LoopOutputLayout.Legacy.refactorPlan, LoopOutputLayout.refactorPlan),
        "doc-index": (LoopOutputLayout.Legacy.docsIndex, LoopOutputLayout.docsIndex),
        "doc-writer": (LoopOutputLayout.Legacy.docsDir, LoopOutputLayout.docsDir),
    ]

    /// The known generated paths a moved stage owns.
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
            return [Entry(legacy: L.Legacy.docsDir, current: L.docsDir, kind: .directory)]
        default:
            return []
        }
    }

    /// The moves implied by the stages that changed from `saved` to `ensured`.
    /// Pure: touches nothing on disk.
    public static func moves(saved: LoopEngineProjectStore, ensured: LoopEngineProjectStore,
                             gitRoot: URL, projectRoot: URL) -> [Move] {
        var result: [Move] = []
        for loop in ensured.loops {
            guard let savedLoop = saved.loops.first(where: { $0.id == loop.id }) else { continue }
            for stage in loop.config.stages {
                guard let key = stage.defaultKey, let primary = primaryOutput[key],
                      stage.outputPath == primary.current,
                      let before = savedLoop.config.stages.first(where: { $0.id == stage.id }),
                      before.outputPath == primary.legacy else { continue }
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
                    result.append(Move(source: source,
                                       destination: boundary.appendingPathComponent(entry.current),
                                       kind: entry.kind, boundary: boundary, stageKey: key))
                }
            }
        }
        return result
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
                return try merge(move.source, into: move.destination, fileManager: fm) ? .moved : .destinationExists
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Moves each entry of `source` into `destination`, merging directories and
    /// skipping any name that already exists there. Removes `source` once it is
    /// empty. Returns whether anything moved.
    private static func merge(_ source: URL, into destination: URL, fileManager fm: FileManager) throws -> Bool {
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        var movedAny = false
        for name in try fm.contentsOfDirectory(atPath: source.path) {
            let from = source.appendingPathComponent(name)
            let to = destination.appendingPathComponent(name)
            guard let type = fileType(of: from, fileManager: fm), type != .typeSymbolicLink else { continue }
            switch (type, fileType(of: to, fileManager: fm)) {
            case (_, nil):
                try fm.moveItem(at: from, to: to)
                movedAny = true
            case (.typeDirectory, .typeDirectory?):
                if try merge(from, into: to, fileManager: fm) { movedAny = true }
            default:
                continue
            }
        }
        if (try? fm.contentsOfDirectory(atPath: source.path))?.isEmpty == true {
            try fm.removeItem(at: source)
            movedAny = true
        }
        return movedAny
    }

    /// The item's type WITHOUT following a symbolic link, or nil when it does not exist.
    private static func fileType(of url: URL, fileManager fm: FileManager) -> FileAttributeType? {
        (try? fm.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType
    }
}
