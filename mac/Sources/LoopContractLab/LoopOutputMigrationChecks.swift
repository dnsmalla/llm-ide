import Foundation
import LlmIdeMacLib

// Asserts `LoopOutputMigration`: it moves exactly the files a stage that now writes
// the new layout generated, and nothing else. These are the user's files, so the
// failure modes are the point: never overwrite, never touch the other plans in
// llm-doc/plans/, never follow or carry a symlink, never act for a loop the user
// edited, work without a saved loop.json, idempotent.

#if FEATURE_AUTOTASK
private let fm = FileManager.default

private func write(_ text: String, to url: URL) {
    try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? text.write(to: url, atomically: true, encoding: .utf8)
}

private func read(_ url: URL) -> String? { try? String(contentsOf: url, encoding: .utf8) }

private func exists(_ url: URL) -> Bool { (try? fm.attributesOfItem(atPath: url.path)) != nil }

private func isRefused(_ outcome: LoopOutputMigration.Outcome) -> Bool {
    if case .refused = outcome { return true }
    return false
}

private func isPartial(_ outcome: LoopOutputMigration.Outcome) -> Bool {
    if case .partiallyMoved = outcome { return true }
    return false
}

/// A project in the clone-into-code layout: `<project>/system/project.json` and the
/// git root at `<project>/code/<repo>`.
private struct Fixture {
    let project: URL
    let repo: URL

    init() {
        project = fm.temporaryDirectory.appendingPathComponent("loop-output-migration-\(UUID().uuidString)")
        repo = project.appendingPathComponent("code/repo")
        write("{}", to: project.appendingPathComponent("system/project.json"))
        write("", to: repo.appendingPathComponent("Package.swift"))
    }

    func cleanup() { try? fm.removeItem(at: project) }

    func p(_ relative: String) -> URL { project.appendingPathComponent(relative) }
    func r(_ relative: String) -> URL { repo.appendingPathComponent(relative) }

    /// The files an older build generated, plus a plan the user saved from chat.
    func seedLegacyOutputs() {
        write("# index", to: p("llm-doc/plans/INDEX.md"))
        write("# master", to: p("llm-doc/plans/PLAN.md"))
        write("# area", to: p("llm-doc/plans/areas/a.md"))
        write("# mine", to: p("llm-doc/plans/user-plan.md"))
        write("# refactor", to: p("llm-doc/refactor/REFACTOR.md"))
        write("# docs index", to: r("llm-doc/docs/INDEX.md"))
        write("# overview", to: r("llm-doc/docs/overview.md"))
        write("# nested", to: r("llm-doc/docs/sub/deep.md"))
    }
}

/// What an older build had saved: the current defaults, with the moved stages put back
/// on the revision-1 paths and no revision stamp.
private func legacyStore(_ fixture: Fixture) -> LoopEngineProjectStore {
    var store = LoopEngineProjectStore(loops: LoopStageDetector.defaultLoops(gitRoot: fixture.repo))
    for loopIndex in store.loops.indices {
        for stageIndex in store.loops[loopIndex].config.stages.indices {
            var stage = store.loops[loopIndex].config.stages[stageIndex]
            stage.defaultRevision = nil
            switch stage.defaultKey {
            case "plan-structure-index": stage.outputPath = "llm-doc/plans/INDEX.md"
            case "plan-director": stage.outputPath = "llm-doc/plans/PLAN.md"
            case "refactor-plan":
                stage.outputPath = "llm-doc/refactor/REFACTOR.md"
                stage.prompt = LoopStageDetector.shippedStage(key: "refactor-plan", revision: 1)?.prompt
            case "refactor-apply":
                stage.targetPath = "llm-doc/refactor/REFACTOR.md"
                stage.prompt = LoopStageDetector.shippedStage(key: "refactor-apply", revision: 1)?.prompt
            case "doc-index": stage.outputPath = "llm-doc/docs/INDEX.md"
            case "doc-writer":
                stage.targetPath = "llm-doc/docs/INDEX.md"
                stage.outputPath = "llm-doc/docs"
            default: break
            }
            store.loops[loopIndex].config.stages[stageIndex] = stage
        }
    }
    return store
}

/// The store after the ensure step has run on `saved`.
private func ensure(_ saved: LoopEngineProjectStore, _ fixture: Fixture) -> LoopEngineProjectStore {
    LoopStageDetector.ensureDefaultLoops(in: saved, gitRoot: fixture.repo).0
}

private func plannedMoves(_ store: LoopEngineProjectStore, _ fixture: Fixture) -> [LoopOutputMigration.Move] {
    LoopOutputMigration.moves(ensured: store, gitRoot: fixture.repo, projectRoot: fixture.project)
}

private func edit(_ store: inout LoopEngineProjectStore, stageKey: String, _ change: (inout LoopStage) -> Void) {
    for loopIndex in store.loops.indices {
        for stageIndex in store.loops[loopIndex].config.stages.indices
        where store.loops[loopIndex].config.stages[stageIndex].defaultKey == stageKey {
            change(&store.loops[loopIndex].config.stages[stageIndex])
        }
    }
}

func runLoopOutputMigrationChecks() {
    print("loop output migration")

    // 1. The happy path: exactly the generated files move, with their content.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        let ensured = ensure(legacyStore(fixture), fixture)
        let moves = plannedMoves(ensured, fixture)
        expect(!moves.isEmpty, "stages on the new layout plan moves for what is stranded")
        let outcomes = LoopOutputMigration.perform(moves)
        expect(outcomes.allSatisfy { $0.outcome == .moved || $0.outcome == .nothingToMove },
               "every planned move succeeds or has nothing to move")

        expect(read(fixture.p("llm-doc/loop/plan/INDEX.md")) == "# index"
               && read(fixture.p("llm-doc/loop/plan/PLAN.md")) == "# master"
               && read(fixture.p("llm-doc/loop/plan/areas/a.md")) == "# area",
               "the Plan loop's index, master plan and areas/ move with their content unchanged")
        expect(read(fixture.p("llm-doc/loop/refactor/REFACTOR.md")) == "# refactor", "the refactor plan moves")
        expect(read(fixture.r("llm-doc/loop/docs/INDEX.md")) == "# docs index"
               && read(fixture.r("llm-doc/loop/docs/overview.md")) == "# overview"
               && read(fixture.r("llm-doc/loop/docs/sub/deep.md")) == "# nested",
               "the whole doc tree moves, including nested folders, inside the REPO")
        expect(!exists(fixture.p("llm-doc/plans/INDEX.md")) && !exists(fixture.p("llm-doc/plans/PLAN.md"))
               && !exists(fixture.p("llm-doc/plans/areas")) && !exists(fixture.p("llm-doc/refactor/REFACTOR.md"))
               && !exists(fixture.r("llm-doc/docs")),
               "it is a move, not a copy: the old files are gone and the emptied doc folder is removed")
        expect(read(fixture.p("llm-doc/plans/user-plan.md")) == "# mine",
               "a plan the user saved into llm-doc/plans/ is never touched")
        expect(exists(fixture.p("llm-doc/plans")), "llm-doc/plans/ itself stays — it is the Plan loop's input")

        // Idempotent: run again — nothing is left to move and nothing changes.
        let again = LoopOutputMigration.perform(plannedMoves(ensured, fixture))
        expect(again.allSatisfy { $0.outcome == .nothingToMove }
               && read(fixture.p("llm-doc/loop/plan/PLAN.md")) == "# master",
               "a second pass finds nothing to move and changes nothing")
    }

    // 2. Works with NO saved loop.json: a fresh project (defaults only) still adopts stranded files.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        let ensured = ensure(LoopEngineProjectStore(loops: []), fixture)
        let outcomes = LoopOutputMigration.perform(plannedMoves(ensured, fixture))
        expect(outcomes.contains { $0.move.stageKey == "plan-director" && $0.outcome == .moved }
               && exists(fixture.p("llm-doc/loop/plan/PLAN.md")) && !exists(fixture.p("llm-doc/plans/PLAN.md")),
               "with no saved settings the old master plan still leaves llm-doc/plans/ — it would otherwise be read back in as a source plan")
    }

    // 3. Never overwrite a file that is already at the destination.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        write("# newer, already here", to: fixture.p("llm-doc/loop/plan/PLAN.md"))
        let outcomes = LoopOutputMigration.perform(plannedMoves(ensure(legacyStore(fixture), fixture), fixture))
        expect(read(fixture.p("llm-doc/loop/plan/PLAN.md")) == "# newer, already here",
               "an existing destination file is never overwritten")
        expect(read(fixture.p("llm-doc/plans/PLAN.md")) == "# master",
               "…and the old copy is left in place rather than lost")
        expect(outcomes.contains { $0.move.stageKey == "plan-director" && $0.outcome == .destinationExists },
               "the conflict is reported")
    }

    // 4. A loop the user edited keeps ALL of its stages and files where they were.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        var saved = legacyStore(fixture)
        edit(&saved, stageKey: "plan-director") { $0.outputPath = "my/PLAN.md" }
        let ensured = ensure(saved, fixture)
        let moves = plannedMoves(ensured, fixture)
        expect(!moves.contains { ["plan-director", "plan-structure-index"].contains($0.stageKey) },
               "an edited Plan Director keeps its whole loop on the old layout — no move for it or its partner")
        expect(exists(fixture.p("llm-doc/plans/INDEX.md")) && exists(fixture.p("llm-doc/plans/PLAN.md")),
               "…so the Plan loop's files stay where its stages still write")
        expect(moves.contains { $0.stageKey == "refactor-plan" } && moves.contains { $0.stageKey == "doc-writer" },
               "…while the other, unedited loops still move")
    }

    // 5. Coupled stages: an edited doc INDEX stage must not lose its file to the unedited doc writer.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        var saved = legacyStore(fixture)
        edit(&saved, stageKey: "doc-index") { $0.prompt = (($0.prompt ?? "") + " My own extra rule.") }
        let ensured = ensure(saved, fixture)
        _ = LoopOutputMigration.perform(plannedMoves(ensured, fixture))
        expect(read(fixture.r("llm-doc/docs/INDEX.md")) == "# docs index"
               && read(fixture.r("llm-doc/docs/overview.md")) == "# overview"
               && !exists(fixture.r("llm-doc/loop/docs")),
               "an edited Doc Index stage keeps the whole doc tree where it is: the writer is not moved away from its index")
    }
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        var saved = legacyStore(fixture)
        edit(&saved, stageKey: "refactor-apply") { $0.prompt = (($0.prompt ?? "") + " Only touch tests/.") }
        _ = LoopOutputMigration.perform(plannedMoves(ensure(saved, fixture), fixture))
        expect(read(fixture.p("llm-doc/refactor/REFACTOR.md")) == "# refactor"
               && !exists(fixture.p("llm-doc/loop/refactor")),
               "an edited Refactor Apply keeps the refactor plan where Refactor Plan still writes it")
    }

    // 6. A symbolic link is never followed or moved — at the top, or nested in a tree.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        let outside = fixture.p("elsewhere.md")
        write("# somewhere else", to: outside)
        try? fm.createDirectory(at: fixture.p("llm-doc/plans"), withIntermediateDirectories: true)
        try? fm.createSymbolicLink(at: fixture.p("llm-doc/plans/INDEX.md"), withDestinationURL: outside)
        write("# overview", to: fixture.r("llm-doc/docs/INDEX.md"))
        try? fm.createDirectory(at: fixture.r("llm-doc/docs/sub"), withIntermediateDirectories: true)
        try? fm.createSymbolicLink(at: fixture.r("llm-doc/docs/sub/link.md"), withDestinationURL: outside)
        let outcomes = LoopOutputMigration.perform(plannedMoves(ensure(legacyStore(fixture), fixture), fixture))
        expect(outcomes.contains { $0.move.stageKey == "plan-structure-index" && isRefused($0.outcome) },
               "a symlinked index is refused")
        expect(read(outside) == "# somewhere else" && !exists(fixture.p("llm-doc/loop/plan/INDEX.md")),
               "the link's target is untouched and nothing appears at the destination")
        expect(outcomes.contains { $0.move.stageKey == "doc-writer" && isPartial($0.outcome) },
               "a tree with a nested link is moved except for the link, and reported as partial")
        expect(!exists(fixture.r("llm-doc/loop/docs/sub/link.md"))
               && (try? fm.destinationOfSymbolicLink(atPath: fixture.r("llm-doc/docs/sub/link.md").path)) != nil,
               "the nested link stays exactly where it was and does not travel")
        expect(read(fixture.r("llm-doc/loop/docs/INDEX.md")) == "# overview", "…while the regular files in the tree move")
    }

    // 7. A project that never generated anything: nothing to move, nothing created.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        let outcomes = LoopOutputMigration.perform(plannedMoves(ensure(legacyStore(fixture), fixture), fixture))
        expect(outcomes.allSatisfy { $0.outcome == .nothingToMove },
               "with no old files every move reports nothing to move")
        expect(!exists(fixture.p("llm-doc/loop")) && !exists(fixture.r("llm-doc/loop")),
               "…and no empty llm-doc/loop/ folders are created for them")
    }

    // 8. The doc tree is resolved in the REPO only; a hand-written llm-doc/docs without an
    //    INDEX.md is not a generated tree and is left alone.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        write("# stray copy", to: fixture.p("llm-doc/docs/INDEX.md"))
        write("# my notes", to: fixture.r("llm-doc/docs/notes.md"))
        _ = LoopOutputMigration.perform(plannedMoves(ensure(legacyStore(fixture), fixture), fixture))
        expect(read(fixture.p("llm-doc/docs/INDEX.md")) == "# stray copy",
               "a doc INDEX.md at the project root is not the loop's output and is left alone")
        expect(read(fixture.r("llm-doc/docs/notes.md")) == "# my notes" && !exists(fixture.r("llm-doc/loop/docs")),
               "a llm-doc/docs folder with no INDEX.md is hand-written, not generated, and is not moved")
    }
}
#endif
