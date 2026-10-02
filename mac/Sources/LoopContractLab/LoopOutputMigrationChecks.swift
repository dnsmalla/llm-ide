import Foundation
import LlmIdeMacLib

// Asserts `LoopOutputMigration`: it moves exactly the files a moved default stage
// generated, and nothing else. These are the user's files, so the failure modes
// are the point: never overwrite, never touch the other plans in llm-doc/plans/,
// never follow a symlink, never act for a stage the user edited, idempotent.

#if FEATURE_AUTOTASK
private let fm = FileManager.default

private func write(_ text: String, to url: URL) {
    try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? text.write(to: url, atomically: true, encoding: .utf8)
}

private func read(_ url: URL) -> String? { try? String(contentsOf: url, encoding: .utf8) }

private func exists(_ url: URL) -> Bool { (try? fm.attributesOfItem(atPath: url.path)) != nil }

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

    /// The files an older build generated, plus a plan the user saved from chat.
    func seedLegacyOutputs() {
        write("# index", to: project.appendingPathComponent("llm-doc/plans/INDEX.md"))
        write("# master", to: project.appendingPathComponent("llm-doc/plans/PLAN.md"))
        write("# area", to: project.appendingPathComponent("llm-doc/plans/areas/a.md"))
        write("# mine", to: project.appendingPathComponent("llm-doc/plans/user-plan.md"))
        write("# refactor", to: project.appendingPathComponent("llm-doc/refactor/REFACTOR.md"))
        write("# docs index", to: repo.appendingPathComponent("llm-doc/docs/INDEX.md"))
        write("# overview", to: repo.appendingPathComponent("llm-doc/docs/overview.md"))
        write("# nested", to: repo.appendingPathComponent("llm-doc/docs/sub/deep.md"))
    }
}

/// A saved store (older build) and the store after the ensure step brought it forward.
private func stores(_ fixture: Fixture) -> (saved: LoopEngineProjectStore, ensured: LoopEngineProjectStore) {
    let defaults = LoopStageDetector.defaultLoops(gitRoot: fixture.repo)
    var saved = LoopEngineProjectStore(loops: defaults)
    for loopIndex in saved.loops.indices {
        for stageIndex in saved.loops[loopIndex].config.stages.indices {
            var stage = saved.loops[loopIndex].config.stages[stageIndex]
            stage.defaultRevision = nil
            switch stage.defaultKey {
            case "plan-structure-index": stage.outputPath = "llm-doc/plans/INDEX.md"
            case "plan-director": stage.outputPath = "llm-doc/plans/PLAN.md"
            case "refactor-plan": stage.outputPath = "llm-doc/refactor/REFACTOR.md"
            case "refactor-apply": stage.targetPath = "llm-doc/refactor/REFACTOR.md"
            case "doc-index": stage.outputPath = "llm-doc/docs/INDEX.md"
            case "doc-writer":
                stage.targetPath = "llm-doc/docs/INDEX.md"
                stage.outputPath = "llm-doc/docs"
            default: break
            }
            saved.loops[loopIndex].config.stages[stageIndex] = stage
        }
    }
    let (ensured, _) = LoopStageDetector.ensureDefaultLoops(in: saved, gitRoot: fixture.repo)
    return (saved, ensured)
}

func runLoopOutputMigrationChecks() {
    print("loop output migration")

    // 1. The happy path: exactly the generated files move, with their content.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        let (saved, ensured) = stores(fixture)
        let moves = LoopOutputMigration.moves(saved: saved, ensured: ensured,
                                              gitRoot: fixture.repo, projectRoot: fixture.project)
        expect(!moves.isEmpty, "bringing the stages forward plans moves")
        let outcomes = LoopOutputMigration.perform(moves)
        expect(outcomes.allSatisfy { $0.outcome == .moved || $0.outcome == .nothingToMove },
               "every planned move succeeds or has nothing to move")

        let plan = fixture.project.appendingPathComponent("llm-doc/loop/plan")
        expect(read(plan.appendingPathComponent("INDEX.md")) == "# index"
               && read(plan.appendingPathComponent("PLAN.md")) == "# master"
               && read(plan.appendingPathComponent("areas/a.md")) == "# area",
               "the Plan loop's index, master plan and areas/ move with their content unchanged")
        expect(read(fixture.project.appendingPathComponent("llm-doc/loop/refactor/REFACTOR.md")) == "# refactor",
               "the refactor plan moves")
        let docs = fixture.repo.appendingPathComponent("llm-doc/loop/docs")
        expect(read(docs.appendingPathComponent("INDEX.md")) == "# docs index"
               && read(docs.appendingPathComponent("overview.md")) == "# overview"
               && read(docs.appendingPathComponent("sub/deep.md")) == "# nested",
               "the whole doc tree moves, including nested folders, inside the REPO")
        expect(!exists(fixture.project.appendingPathComponent("llm-doc/plans/INDEX.md"))
               && !exists(fixture.project.appendingPathComponent("llm-doc/plans/PLAN.md"))
               && !exists(fixture.project.appendingPathComponent("llm-doc/plans/areas"))
               && !exists(fixture.project.appendingPathComponent("llm-doc/refactor/REFACTOR.md"))
               && !exists(fixture.repo.appendingPathComponent("llm-doc/docs")),
               "it is a move, not a copy: the old files are gone and the emptied doc folder is removed")
        expect(read(fixture.project.appendingPathComponent("llm-doc/plans/user-plan.md")) == "# mine",
               "a plan the user saved into llm-doc/plans/ is never touched")
        expect(exists(fixture.project.appendingPathComponent("llm-doc/plans")),
               "llm-doc/plans/ itself stays — it is the Plan loop's input")

        // 2. Idempotent: the saved store now equals the ensured one, so nothing is planned.
        let again = LoopOutputMigration.moves(saved: ensured, ensured: ensured,
                                              gitRoot: fixture.repo, projectRoot: fixture.project)
        expect(again.isEmpty, "a second load plans no moves")
    }

    // 3. Never overwrite a file that is already at the destination.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        write("# newer, already here", to: fixture.project.appendingPathComponent("llm-doc/loop/plan/PLAN.md"))
        let (saved, ensured) = stores(fixture)
        let outcomes = LoopOutputMigration.perform(LoopOutputMigration.moves(
            saved: saved, ensured: ensured, gitRoot: fixture.repo, projectRoot: fixture.project))
        expect(read(fixture.project.appendingPathComponent("llm-doc/loop/plan/PLAN.md")) == "# newer, already here",
               "an existing destination file is never overwritten")
        expect(read(fixture.project.appendingPathComponent("llm-doc/plans/PLAN.md")) == "# master",
               "…and the old copy is left in place rather than lost")
        expect(outcomes.contains { $0.move.stageKey == "plan-director" && $0.outcome == .destinationExists },
               "the conflict is reported")
    }

    // 4. A stage the user edited is not upgraded, so nothing is planned for it.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        var saved = stores(fixture).saved
        for loopIndex in saved.loops.indices {
            for stageIndex in saved.loops[loopIndex].config.stages.indices
            where saved.loops[loopIndex].config.stages[stageIndex].defaultKey == "plan-director" {
                saved.loops[loopIndex].config.stages[stageIndex].outputPath = "my/PLAN.md"
            }
        }
        let ensured = LoopStageDetector.ensureDefaultLoops(in: saved, gitRoot: fixture.repo).0
        let moves = LoopOutputMigration.moves(saved: saved, ensured: ensured,
                                              gitRoot: fixture.repo, projectRoot: fixture.project)
        expect(!moves.contains { $0.stageKey == "plan-director" },
               "an edited Plan Director stage plans no move — the user's own output location is theirs")
        expect(moves.contains { $0.stageKey == "plan-structure-index" },
               "…while the unedited stage next to it still does")
    }

    // 5. A symbolic link is never followed or moved.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        let outside = fixture.project.appendingPathComponent("elsewhere.md")
        write("# somewhere else", to: outside)
        try? fm.createDirectory(at: fixture.project.appendingPathComponent("llm-doc/plans"),
                                withIntermediateDirectories: true)
        try? fm.createSymbolicLink(at: fixture.project.appendingPathComponent("llm-doc/plans/INDEX.md"),
                                   withDestinationURL: outside)
        let (saved, ensured) = stores(fixture)
        let outcomes = LoopOutputMigration.perform(LoopOutputMigration.moves(
            saved: saved, ensured: ensured, gitRoot: fixture.repo, projectRoot: fixture.project))
        expect(outcomes.contains {
            $0.move.stageKey == "plan-structure-index" && { if case .refused = $0.outcome { return true } else { return false } }($0)
        }, "a symlinked index is refused")
        expect(read(outside) == "# somewhere else"
               && !exists(fixture.project.appendingPathComponent("llm-doc/loop/plan/INDEX.md")),
               "the link's target is untouched and nothing appears at the destination")
    }

    // 6. A project that never generated anything: nothing to move, nothing created.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        let (saved, ensured) = stores(fixture)
        let outcomes = LoopOutputMigration.perform(LoopOutputMigration.moves(
            saved: saved, ensured: ensured, gitRoot: fixture.repo, projectRoot: fixture.project))
        expect(outcomes.allSatisfy { $0.outcome == .nothingToMove },
               "with no old files every move reports nothing to move")
        expect(!exists(fixture.project.appendingPathComponent("llm-doc/loop")),
               "…and no empty llm-doc/loop/ folders are created for them")
    }

    // 7. The doc tree is resolved in the REPO only, so a stray copy at the project root stays.
    do {
        let fixture = Fixture(); defer { fixture.cleanup() }
        fixture.seedLegacyOutputs()
        write("# stray copy", to: fixture.project.appendingPathComponent("llm-doc/docs/INDEX.md"))
        let (saved, ensured) = stores(fixture)
        _ = LoopOutputMigration.perform(LoopOutputMigration.moves(
            saved: saved, ensured: ensured, gitRoot: fixture.repo, projectRoot: fixture.project))
        expect(read(fixture.project.appendingPathComponent("llm-doc/docs/INDEX.md")) == "# stray copy",
               "a doc INDEX.md at the project root is not the loop's output and is left alone")
    }
}
#endif
