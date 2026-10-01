import XCTest
@testable import LlmIdeMacLib

/// Test-only lookup helper — production code queries `loops`/`primaryLoop`
/// directly, so this convenience lives with the tests that use it.
extension LoopEngineProjectStore {
    func loop(defaultKey key: String) -> LoopDefinition? {
        loops.first { $0.defaultKey == key }
    }
}

/// The built-in checks are INDEPENDENT LOOPS (Regression / Test / System
/// Check), not pinned stages sharing one pipeline. Two properties are what
/// make that hold, and both are one-line-of-code away from silently breaking:
///
///  • a loop only ever receives the default stages **its own** `defaultKey`
///    owns — the aggregate helper cloned all nine into every loop, which is the
///    bug the split fixed; and
///  • a project that predates the split is MIGRATED into the new shape with the
///    user's edits, budgets and user-added stages intact — a migration that
///    drops a tuned command looks exactly like "the loop forgot my config".
final class LoopDefaultLoopsTests: XCTestCase {
    private var repo: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-default-loops-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
        repo = nil
        super.tearDown()
    }

    private func write(_ relativePath: String, _ contents: String = "") throws {
        let url = repo.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    /// llm-ide's own layout: every System Check marker plus a `make test`.
    private func writeLlmIdeLayout() throws {
        try write("extension/tests/agent-skills.test.mjs")
        try write("extension/tests/plugins-loader.test.mjs")
        try write("extension/tests/box-connector.test.mjs")
        try write("extension/tests/dispatch-preview.test.mjs")
        try write("extension/package.json", "{}")
        try write("mac/Package.swift")
        try write("Makefile", "test:\n\techo hi\n\ntest-shared-protocol:\n\techo hi\n")
    }

    // MARK: - What each default loop contains

    func testBareRepoGetsTheRegressionPlanRefactorAndDocLoops() {
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        XCTAssertEqual(loops.map(\.defaultKey),
                       [LoopDefaultLoopKey.regression, LoopDefaultLoopKey.plan,
                        LoopDefaultLoopKey.refactor, LoopDefaultLoopKey.docs])
        XCTAssertEqual(loops[0].name, "Regression")
        XCTAssertEqual(loops[0].config.stages.map(\.kind), [.regressionSweep])
    }

    /// The Plan loop is two `.skill` generate stages (skill ids pinned AND a
    /// self-sufficient prompt each) plus a blocking in-app artifact check — the prompt must carry the
    /// whole contract, because the central skills repo may not be installed on
    /// the machine running the loop.
    func testPlanLoopShipsTwoSkillStagesWithPinnedSkillsAndPrompts() {
        let plan = LoopStageDetector.defaultLoops(gitRoot: repo)
            .first { $0.defaultKey == LoopDefaultLoopKey.plan }
        XCTAssertEqual(plan?.name, "Plan")
        XCTAssertEqual(plan?.config.stages.map(\.kind), [.skill, .skill, .artifactCheck])
        XCTAssertEqual(plan?.config.stages.compactMap(\.defaultKey),
                       ["plan-structure-index", "plan-director", "plan-check"])
        XCTAssertEqual(plan?.config.stages.compactMap(\.skillId),
                       ["skills/plan-structure-index", "skills/plan-director"])
        for stage in plan?.config.stages ?? [] where stage.kind == .skill {
            XCTAssertFalse(stage.prompt?.isEmpty ?? true, "\(stage.name) has no prompt")
            XCTAssertEqual(stage.targetPath, "llm-doc/plans")
            XCTAssertFalse(stage.outputPath?.isEmpty ?? true, "\(stage.name) has no output path")
        }
    }

    /// Like every default loop, Plan is gated on a resolvable working tree —
    /// with no root there is nothing to index or consolidate against.
    func testPlanLoopIsAbsentWithoutAGitRoot() {
        XCTAssertNil(LoopStageDetector.defaultLoops(gitRoot: nil)
            .first { $0.defaultKey == LoopDefaultLoopKey.plan })
    }

    /// The Regression loop's own process: check the faults, repair, then prove
    /// the repair did not break the suite. The verify stage carries its own key
    /// so it is never confused with the Test loop's stage.
    func testRegressionLoopGainsItsOwnVerifyStageWhenTestToolingExists() throws {
        try write("Package.swift")
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        let regression = loops.first { $0.defaultKey == LoopDefaultLoopKey.regression }
        XCTAssertEqual(regression?.config.stages.map(\.defaultKey), ["regression", "regression-test"])
        XCTAssertEqual(regression?.config.stages.last?.command, "swift test")
    }

    func testTestLoopIsOnlyCreatedWhenToolingIsDetected() throws {
        XCTAssertNil(LoopStageDetector.defaultLoops(gitRoot: repo)
            .first { $0.defaultKey == LoopDefaultLoopKey.test })
        try write("Package.swift")
        let test = LoopStageDetector.defaultLoops(gitRoot: repo)
            .first { $0.defaultKey == LoopDefaultLoopKey.test }
        XCTAssertEqual(test?.config.stages.map(\.command), ["swift test"])
    }

    /// The markers are llm-ide's own layout, so a repo that is not llm-ide must
    /// see exactly what it saw before the split — this is what keeps the
    /// detector safe to run for every project the app opens.
    func testSystemCheckLoopIsAbsentOnARepoThatIsNotLlmIde() {
        XCTAssertNil(LoopStageDetector.defaultLoops(gitRoot: repo)
            .first { $0.defaultKey == LoopDefaultLoopKey.systemCheck })
    }

    func testLlmIdeLayoutGetsEveryLoopWithTheChecksInSystemCheck() throws {
        try writeLlmIdeLayout()
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        XCTAssertEqual(loops.map(\.defaultKey),
                       [LoopDefaultLoopKey.regression, LoopDefaultLoopKey.test,
                        LoopDefaultLoopKey.systemCheck, LoopDefaultLoopKey.plan,
                        LoopDefaultLoopKey.refactor, LoopDefaultLoopKey.docs])
        let systemCheck = loops.first { $0.defaultKey == LoopDefaultLoopKey.systemCheck }
        XCTAssertEqual(systemCheck?.name, "System Check")
        XCTAssertEqual(Set(systemCheck?.config.stages.compactMap(\.defaultKey) ?? []),
                       ["skills", "plugins", "connectors", "github-dispatch", "backend",
                        "shared-protocol", "mac-app"])
        // The subsystem checks live in System Check and NOWHERE else.
        let regression = loops.first { $0.defaultKey == LoopDefaultLoopKey.regression }
        XCTAssertFalse(regression?.config.stages.contains { $0.defaultKey == "skills" } ?? true)
    }

    /// Every default loop states what "done" means, because both fields are fed
    /// to the repair agent — a loop with no contract gets repairs aimed only at
    /// making a command exit 0.
    func testEveryDefaultLoopShipsWithAGoalAndAcceptanceCriteria() throws {
        try writeLlmIdeLayout()
        for loop in LoopStageDetector.defaultLoops(gitRoot: repo) {
            XCTAssertFalse(loop.goal?.isEmpty ?? true, "\(loop.name) has no goal")
            XCTAssertFalse(loop.acceptanceCriteria?.isEmpty ?? true, "\(loop.name) has no acceptance criteria")
        }
    }

    /// Drift guard: a new built-in check must be registered in BOTH
    /// `defaultStages(forLoop:)` and the `stageKeyOwner` table, or the split
    /// migration will not know where to route it.
    func testEveryDefaultStageKeyIsOwnedByTheLoopThatEmitsIt() throws {
        try writeLlmIdeLayout()
        let store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        for loop in store.loops {
            guard let loopKey = loop.defaultKey else { continue }
            // Re-running the ensure must move nothing, which is only true if
            // every stage the loop emits is owned by that same loop.
            let again = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo).store
            XCTAssertEqual(again.loop(defaultKey: loopKey)?.config.stages.compactMap(\.defaultKey),
                           loop.config.stages.compactMap(\.defaultKey),
                           "\(loopKey) loses or gains stages on a second ensure")
        }
    }

    // MARK: - Refactoring + Doc Optimization loops

    private func loop(_ key: String, in loops: [LoopDefinition]) -> LoopDefinition? {
        loops.first { $0.defaultKey == key }
    }

    /// Code is never edited without a verify stage: with no detectable test
    /// command the Refactoring loop only writes the plan.
    func testRefactorLoopIsPlanOnlyWithoutATestCommand() throws {
        let refactor = try XCTUnwrap(loop(LoopDefaultLoopKey.refactor,
                                          in: LoopStageDetector.defaultLoops(gitRoot: repo)))
        XCTAssertEqual(refactor.name, "Refactoring")
        XCTAssertEqual(refactor.config.stages.count, 1)
        let plan = try XCTUnwrap(refactor.config.stages.first)
        XCTAssertEqual(plan.name, "Refactor Plan")
        XCTAssertEqual(plan.kind, .skill)
        XCTAssertEqual(plan.skillId, "skills/refactor-planner")
        XCTAssertEqual(plan.targetPath, ".")
        XCTAssertEqual(plan.outputPath, "llm-doc/refactor/REFACTOR.md")
        XCTAssertEqual(plan.defaultKey, "refactor-plan")
        XCTAssertTrue(plan.isDefault)
    }

    /// With a test command: plan, apply ONE batch, then prove behaviour held.
    func testRefactorLoopPlansAppliesAndTestsWhenATestCommandIsDetected() throws {
        try write("Package.swift")
        let refactor = try XCTUnwrap(loop(LoopDefaultLoopKey.refactor,
                                          in: LoopStageDetector.defaultLoops(gitRoot: repo)))
        let stages = LoopStage.runOrder(refactor.config.stages)
        XCTAssertEqual(stages.map(\.name), ["Refactor Plan", "Refactor Apply", "Test"])
        XCTAssertEqual(stages.map(\.kind), [.skill, .skill, .shellCommand])
        XCTAssertEqual(stages.compactMap(\.defaultKey), ["refactor-plan", "refactor-apply", "refactor-test"])
        XCTAssertEqual(stages.map(\.skillId), ["skills/refactor-planner", "skills/refactor-apply", nil])
        XCTAssertEqual(stages[1].targetPath, "llm-doc/refactor/REFACTOR.md")
        XCTAssertEqual(stages[1].outputPath, ".")
        XCTAssertEqual(stages[2].command, "swift test")
        XCTAssertEqual(stages[2].detectedCommand, "swift test")
        XCTAssertTrue(stages.allSatisfy(\.isDefault))
    }

    /// The Refactoring loop keeps the NORMAL loop-wide policy, so the Test
    /// stage's repair agent stays guarded; only the code-apply stage itself
    /// is relaxed, at run time (`LoopEngineRunner.effectivePolicy`).
    func testRefactorLoopIsCreatedWithTheNormalProtectedPathPolicy() throws {
        try write("Package.swift")
        let suite = try XCTUnwrap(UserDefaults(suiteName: "loop-default-loops-\(UUID().uuidString)"))
        let created = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo, defaults: suite).store
        for loop in created.loops {
            XCTAssertEqual(loop.config.protectedPathPolicy, .revert, "\(loop.name) must keep the default")
        }
        XCTAssertEqual(LoopTemplate.refactoring.config.protectedPathPolicy, .revert)
    }

    /// The doc tree must live inside the git tree so the code graph scans and
    /// links it: the doc stages resolve their paths against the repo root only.
    func testDocPromptsResolveAgainstTheRepoRootOnly() throws {
        for prompt in [LoopStageDetector.docIndexPrompt, LoopStageDetector.docWriterPrompt] {
            XCTAssertTrue(prompt.contains(LoopStageDetector.docResolvePathsRule))
            XCTAssertTrue(prompt.contains("repo root only"))
            XCTAssertFalse(prompt.contains("then the project root"))
        }
        // …so the project-level scaffold no longer creates a doc tree outside the repo.
        XCTAssertFalse(ProjectScaffolder.requiredDirectories.contains("llm-doc/docs"))
        XCTAssertTrue(ProjectScaffolder.requiredDirectories.contains("llm-doc/refactor"))
    }

    func testDocLoopIndexesThenWritesTheGeneratedDocTree() throws {
        let docs = try XCTUnwrap(loop(LoopDefaultLoopKey.docs,
                                      in: LoopStageDetector.defaultLoops(gitRoot: repo)))
        XCTAssertEqual(docs.name, "Doc Optimization")
        let stages = LoopStage.runOrder(docs.config.stages)
        XCTAssertEqual(stages.map(\.name), ["Doc Index", "Doc Writer", "Doc Check"])
        XCTAssertEqual(stages.map(\.kind), [.skill, .skill, .artifactCheck])
        XCTAssertEqual(stages.compactMap(\.defaultKey), ["doc-index", "doc-writer", "doc-check"])
        XCTAssertEqual(stages.compactMap(\.skillId), ["skills/doc-structure-index", "skills/doc-writer"])
        XCTAssertEqual(stages.map(\.targetPath), [".", "llm-doc/docs/INDEX.md", nil])
        XCTAssertEqual(stages.map(\.outputPath), ["llm-doc/docs/INDEX.md", "llm-doc/docs", nil])
    }

    /// Prompts carry the contract but no path — the path lives only in the
    /// editable Input/Output fields, so editing those redirects the loop. The
    /// doc stages state the citation format the graph reads.
    func testRefactorAndDocPromptsArePathAgnosticAndSelfSufficient() throws {
        try write("Package.swift")
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        let stages = [LoopDefaultLoopKey.refactor, LoopDefaultLoopKey.docs]
            .flatMap { loop($0, in: loops)?.config.stages ?? [] }
            .filter { $0.kind == .skill }
        XCTAssertEqual(stages.count, 4)
        for stage in stages {
            let prompt = try XCTUnwrap(stage.prompt, "\(stage.name) has no prompt")
            XCTAssertFalse(prompt.contains("llm-doc"), "\(stage.name) bakes a path into its prompt")
            XCTAssertTrue(prompt.contains("the Input") && prompt.contains("the Output"),
                          "\(stage.name) does not defer to the Input/Output fields")
        }
        let docPrompts = stages.filter { $0.defaultKey?.hasPrefix("doc-") == true }.compactMap(\.prompt)
        XCTAssertEqual(docPrompts.count, 2)
        for prompt in docPrompts {
            XCTAssertTrue(prompt.contains(LoopStageDetector.docCitationFormat))
        }
        XCTAssertTrue(LoopStageDetector.docCitationFormat.contains("path with line"))
    }

    func testRefactorAndDocLoopsAreAbsentWithoutAGitRoot() {
        let loops = LoopStageDetector.defaultLoops(gitRoot: nil)
        XCTAssertNil(loop(LoopDefaultLoopKey.refactor, in: loops))
        XCTAssertNil(loop(LoopDefaultLoopKey.docs, in: loops))
    }

    func testRefactorAndDocLoopsShipTheirContracts() {
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        XCTAssertEqual(loop(LoopDefaultLoopKey.refactor, in: loops)?.goal,
                       "Move the codebase toward a professional, AI-friendly structure one safe, "
                           + "behaviour-preserving batch at a time.")
        XCTAssertEqual(loop(LoopDefaultLoopKey.refactor, in: loops)?.acceptanceCriteria,
                       "The refactor plan exists with every batch marked todo/done/skipped, the applied "
                           + "batch changed no behaviour, and the test command still passes.")
        XCTAssertEqual(loop(LoopDefaultLoopKey.docs, in: loops)?.goal,
                       "Keep a generated, code-cited doc tree that explains what the code does and why, so "
                           + "people, agents and the code graph are pointed at the right code.")
        XCTAssertEqual(loop(LoopDefaultLoopKey.docs, in: loops)?.acceptanceCriteria,
                       "llm-doc/docs/INDEX.md lists every area, every listed page exists within 250 lines, "
                           + "and every code citation resolves to a real file or symbol.")
    }

    /// `stageKeyOwner` routing: a refactor/doc stage found in the wrong loop
    /// moves to the loop that owns it, carrying its edits.
    func testRefactorAndDocStagesAreRoutedToTheLoopsThatOwnThem() throws {
        try write("Package.swift")
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        let refactorIndex = try XCTUnwrap(store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.refactor })
        let docsIndex = try XCTUnwrap(store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.docs })
        store.loops[refactorIndex].config.stages.removeAll { $0.defaultKey == "refactor-test" }
        store.loops[docsIndex].config.stages.removeAll { $0.defaultKey == "doc-writer" }
        let userIndex = try XCTUnwrap(store.loops.firstIndex { $0.defaultKey == nil })
        store.loops[userIndex].config.stages = [
            LoopStage(id: "stray-test", name: "My Test", kind: .shellCommand, command: "custom test",
                      order: 0, isDefault: true, defaultKey: "refactor-test"),
            LoopStage(id: "stray-writer", name: "Doc Writer", kind: .skill, order: 1,
                      prompt: "edited", isDefault: true, defaultKey: "doc-writer"),
        ]
        let routed = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo).store
        XCTAssertTrue(routed.loops.first { $0.defaultKey == nil }?.config.stages.isEmpty ?? false)
        let test = routed.loop(defaultKey: LoopDefaultLoopKey.refactor)?
            .config.stages.filter { $0.defaultKey == "refactor-test" }
        XCTAssertEqual(test?.map(\.id), ["stray-test"])
        XCTAssertEqual(test?.first?.command, "custom test")
        let writer = routed.loop(defaultKey: LoopDefaultLoopKey.docs)?
            .config.stages.filter { $0.defaultKey == "doc-writer" }
        XCTAssertEqual(writer?.map(\.prompt), ["edited"])
    }

    /// Manual only: the Refactoring loop edits code, so it is created off the
    /// schedule and the schedule never picks it up.
    func testRefactorLoopIsManualOnlyAndNeverScheduled() throws {
        try write("Package.swift")
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        let index = try XCTUnwrap(store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.refactor })
        XCTAssertFalse(store.loops[index].runsOnSchedule)
        XCTAssertTrue(store.loops[index].isManualOnly)
        XCTAssertFalse(store.loop(defaultKey: LoopDefaultLoopKey.docs)?.isManualOnly ?? true)
        // Even a hand-edited loop.json that forces the flag on is skipped.
        store.loops[index].runsOnSchedule = true
        XCTAssertTrue(store.scheduledLoops.isEmpty)
        // And the once-per-project schedule migration only ever switches off.
        let suite = "loop-default-loops-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        store.schemaVersion = 1
        _ = LoopEngineConfigStore.normalizeScheduleOptIn(&store)
        XCTAssertFalse(store.loop(defaultKey: LoopDefaultLoopKey.refactor)?.runsOnSchedule ?? true)
    }

    /// Manual-only follows the recipe, not only the key: a Refactoring loop
    /// made from the template or by Duplicate (no `defaultKey`) holds an
    /// enabled refactor-apply stage and must stay off the schedule too.
    func testAnyLoopWithAnEnabledCodeApplyStageIsManualOnly() {
        let apply = LoopStage(id: "a1", name: "Refactor Apply", kind: .skill, order: 0,
                              skillId: "skills/refactor-apply")
        let test = LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        var copy = LoopDefinition(name: "Refactoring copy", runsOnSchedule: true,
                                  config: LoopEngineConfig(stages: [apply, test]))
        XCTAssertTrue(copy.isManualOnly)
        XCTAssertTrue(LoopEngineProjectStore(loops: [copy]).scheduledLoops.isEmpty)

        copy.config.stages[0].enabled = false
        XCTAssertFalse(copy.isManualOnly, "a disabled apply stage edits nothing")
        XCTAssertEqual(LoopEngineProjectStore(loops: [copy]).scheduledLoops.map(\.id), [copy.id])

        let docs = LoopDefinition(name: "Doc Optimization", defaultKey: LoopDefaultLoopKey.docs,
                                  config: LoopEngineConfig(stages: []))
        XCTAssertFalse(docs.isManualOnly)
        XCTAssertTrue(LoopDefinition.isManualOnly(defaultKey: LoopDefaultLoopKey.refactor, stages: []))
    }

    /// The template must never yield code edits without a verify stage: with
    /// no test tooling the Test placeholder is dropped, so Refactor Apply goes
    /// too and the template applies plan-only — like its default loop.
    func testRefactoringTemplateAppliesPlanOnlyWithoutATestCommand() throws {
        XCTAssertEqual(LoopTemplate.refactoring.applied(to: repo).stages.map(\.name), ["Refactor Plan"])
        XCTAssertEqual(LoopTemplate.refactoring.applied(to: nil).stages.map(\.name), ["Refactor Plan"])
        try write("Package.swift")
        XCTAssertEqual(LoopTemplate.refactoring.applied(to: repo).stages.map(\.name),
                       ["Refactor Plan", "Refactor Apply", "Test"])
    }

    /// An existing project (the four earlier default loops, one tuned) gains
    /// the two new loops on its next load, and nothing else changes.
    func testEnsureAddsTheNewLoopsToAnExistingProjectWithoutTouchingOthers() throws {
        try writeLlmIdeLayout()
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        store.loops.removeAll {
            $0.defaultKey == LoopDefaultLoopKey.refactor || $0.defaultKey == LoopDefaultLoopKey.docs
        }
        let testIndex = try XCTUnwrap(store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.test })
        store.loops[testIndex].config.maxIterations = 3
        store.loops[testIndex].runsOnSchedule = true
        let before = store.loops

        let ensured = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo).store
        XCTAssertEqual(Array(ensured.loops.prefix(before.count)), before)
        XCTAssertEqual(ensured.loops.dropFirst(before.count).compactMap(\.defaultKey),
                       [LoopDefaultLoopKey.refactor, LoopDefaultLoopKey.docs])
        // Idempotent from there.
        XCTAssertEqual(LoopStageDetector.ensureDefaultLoops(in: ensured, gitRoot: repo).store, ensured)
    }

    /// A bare tree detects only unconditional stages (Regression sweep + the
    /// Plan/Refactor/Doc skill stages), which prove nothing about the tree —
    /// so its config must not be persisted. A detected test command does.
    func testBareTreeDetectionIsNotPersistedButATestCommandIs() throws {
        let bare = LoopStageDetector.defaultLoops(gitRoot: repo).flatMap(\.config.stages)
        XCTAssertFalse(LoopEngineConfig.shouldPersist(bare))
        try write("Package.swift")
        let refactorOnly = LoopStageDetector.defaultLoops(gitRoot: repo)
            .filter { $0.defaultKey == LoopDefaultLoopKey.refactor }.flatMap(\.config.stages)
        XCTAssertTrue(LoopEngineConfig.shouldPersist(refactorOnly),
                      "refactor-test carries a detected command — real evidence")
    }

    /// The New Loop wizard offers both recipes, with stable ids and the same
    /// stages as the default loops.
    func testRefactorAndDocTemplatesMatchTheirDefaultLoops() throws {
        let ids = LoopTemplate.builtIns.map(\.id)
        XCTAssertTrue(ids.contains(UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000AA")!))
        XCTAssertTrue(ids.contains(UUID(uuidString: "1E7B0A00-0000-4000-8000-0000000000AB")!))
        XCTAssertEqual(LoopTemplate.refactoring.id.uuidString, "1E7B0A00-0000-4000-8000-0000000000AA")
        XCTAssertEqual(LoopTemplate.docOptimization.id.uuidString, "1E7B0A00-0000-4000-8000-0000000000AB")

        try write("Package.swift")
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        for (template, key) in [(LoopTemplate.refactoring, LoopDefaultLoopKey.refactor),
                                (LoopTemplate.docOptimization, LoopDefaultLoopKey.docs)] {
            let applied = template.applied(to: repo).stages
            let defaults = try XCTUnwrap(loop(key, in: loops)).config.stages
            XCTAssertEqual(applied.map(\.name), defaults.map(\.name), template.name)
            XCTAssertEqual(applied.map(\.kind), defaults.map(\.kind), template.name)
            XCTAssertEqual(applied.map(\.skillId), defaults.map(\.skillId), template.name)
            XCTAssertEqual(applied.map(\.targetPath), defaults.map(\.targetPath), template.name)
            XCTAssertEqual(applied.map(\.outputPath), defaults.map(\.outputPath), template.name)
            XCTAssertEqual(applied.map(\.prompt), defaults.map(\.prompt), template.name)
            XCTAssertEqual(applied.map(\.command), defaults.map(\.command), template.name)
        }
    }

    // MARK: - Loop-scoped ensure

    /// The core regression guard for the split: the aggregate helper injected
    /// every built-in check into whatever config it was handed, so once a
    /// project had several loops each one grew a full copy of the pipeline.
    func testUserLoopReceivesNoInjectedDefaultStages() throws {
        try writeLlmIdeLayout()
        let userLoop = LoopDefinition(name: "Refactor auth", config: LoopEngineConfig(stages: [
            LoopStage(id: "u1", name: "My check", kind: .shellCommand, command: "echo hi", order: 0)
        ]))
        let ensured = LoopStageDetector.ensureDefaultStages(in: userLoop, gitRoot: repo)
        XCTAssertEqual(ensured.config.stages.map(\.id), ["u1"])
    }

    func testDefaultLoopOnlyReceivesTheStagesItsOwnKeyOwns() throws {
        try writeLlmIdeLayout()
        let testLoop = LoopDefinition(name: "Test", defaultKey: LoopDefaultLoopKey.test,
                                      config: LoopEngineConfig(stages: []))
        let ensured = LoopStageDetector.ensureDefaultStages(in: testLoop, gitRoot: repo)
        XCTAssertEqual(ensured.config.stages.compactMap(\.defaultKey), ["test"])
    }

    /// Disabling a stage is the sanctioned escape hatch for a pinned default,
    /// and renaming one must not orphan it — both have to survive the
    /// loop-scoped ensure, or every load would quietly switch it back on.
    func testRenamedDisabledDefaultStageStaysPinnedAndDisabled() throws {
        try writeLlmIdeLayout()
        let loop = LoopDefinition(name: "System Check", defaultKey: LoopDefaultLoopKey.systemCheck,
                                  config: LoopEngineConfig(stages: [
            LoopStage(id: "s1", name: "Skills (off, too slow)", kind: .shellCommand,
                      command: "custom skills cmd", order: 0, isDefault: true,
                      enabled: false, defaultKey: "skills")
        ]))
        let ensured = LoopStageDetector.ensureDefaultStages(in: loop, gitRoot: repo)
        let skills = ensured.config.stages.filter { $0.defaultKey == "skills" }
        XCTAssertEqual(skills.count, 1, "the renamed stage must be re-pinned, not duplicated")
        XCTAssertEqual(skills.first?.enabled, false)
        XCTAssertEqual(skills.first?.command, "custom skills cmd")
    }

    // MARK: - Migration off the pre-split single loop

    /// The shape every existing project is in: ONE "Main Loop" holding every
    /// built-in check as a pinned stage.
    private func legacyAggregateStore(maxIterations: Int = 7,
                                     extraStages: [LoopStage] = []) -> LoopEngineProjectStore {
        var stages = LoopStageDetector.defaultStages(gitRoot: repo)
        stages.append(contentsOf: extraStages)
        var config = LoopEngineConfig(stages: LoopStage.renumbered(stages),
                                      maxIterations: maxIterations)
        config.maxRepairsPerStage = 5
        return LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Main Loop", isPrimary: true, config: config)
        ])
    }

    /// Every default loop a throwaway repo gets. Self-Heal is deliberately absent: its verify
    /// stage is gated on the app's own checkout (`isAppSourceRoot`), so no temp repo has it.
    private var defaultLoopKeysInAnyRepo: [String] {
        LoopDefaultLoopKey.all.filter { $0 != LoopDefaultLoopKey.selfHeal }
    }

    func testLegacyAggregateLoopSplitsIntoTheDefaultLoops() throws {
        try writeLlmIdeLayout()
        let migrated = LoopStageDetector.ensureDefaultLoops(in: legacyAggregateStore(), gitRoot: repo).store
        XCTAssertEqual(Set(migrated.loops.compactMap(\.defaultKey)),
                       Set(defaultLoopKeysInAnyRepo))
        // The aggregate loop SURVIVES as the project's editable loop — the
        // built-ins cannot be deleted, so removing it would leave nowhere to
        // put work of the user's own. Its stages simply moved to the loops
        // that own them.
        let survivor = migrated.loops.first { $0.name == "Main Loop" }
        XCTAssertNotNil(survivor)
        XCTAssertFalse(survivor?.isDefault ?? true)
        XCTAssertEqual(migrated.loops.filter(\.isPrimary).count, 1)
        XCTAssertEqual(migrated.loop(defaultKey: LoopDefaultLoopKey.systemCheck)?
            .config.stages.count, 7)
        // Each loop ends up with its OWN process, not a slice of one pipeline:
        // Regression checks the faults then re-runs the suite on the repair,
        // and Test is just the suite.
        XCTAssertEqual(migrated.loop(defaultKey: LoopDefaultLoopKey.regression)?
            .config.stages.compactMap(\.defaultKey), ["regression", "regression-test"])
        XCTAssertEqual(migrated.loop(defaultKey: LoopDefaultLoopKey.test)?
            .config.stages.compactMap(\.defaultKey), ["test"])
        XCTAssertEqual(migrated.loop(defaultKey: LoopDefaultLoopKey.test)?
            .config.stages.first?.command, "make test")
    }

    /// The whole point of migrating rather than re-detecting: the numbers and
    /// commands the user set have to come across.
    func testMigrationKeepsEditedCommandsAndInheritedBudgets() throws {
        try writeLlmIdeLayout()
        var store = legacyAggregateStore(maxIterations: 7)
        let index = store.loops[0].config.stages.firstIndex { $0.defaultKey == "backend" }!
        store.loops[0].config.stages[index].command = "cd extension && npm run test:fast"
        store.loops[0].config.stages[index].enabled = false

        let migrated = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo).store
        let backend = migrated.loop(defaultKey: LoopDefaultLoopKey.systemCheck)?
            .config.stages.first { $0.defaultKey == "backend" }
        XCTAssertEqual(backend?.command, "cd extension && npm run test:fast")
        XCTAssertEqual(backend?.enabled, false)
        // The Plan, Refactoring and Doc Optimization loops are excluded: no
        // stage of them existed pre-split, so they are freshly CREATED (with
        // the stock defaults), not migrated — there are no project budgets
        // their stages "came from".
        let freshlyCreated: Set<String> = [LoopDefaultLoopKey.plan, LoopDefaultLoopKey.refactor,
                                           LoopDefaultLoopKey.docs]
        for loop in migrated.loops where !freshlyCreated.contains(loop.defaultKey ?? "") {
            XCTAssertEqual(loop.config.maxIterations, 7, "\(loop.name) lost the project's budgets")
            XCTAssertEqual(loop.config.maxRepairsPerStage, 5)
        }
    }


    /// Primary is what the phone and the chat command run, so it must never
    /// land on the stage-less loop the split leaves behind.
    func testMigrationMovesPrimaryOffTheEmptiedEditableLoop() throws {
        try writeLlmIdeLayout()
        let migrated = LoopStageDetector.ensureDefaultLoops(in: legacyAggregateStore(), gitRoot: repo).store
        XCTAssertEqual(migrated.loops.first(where: \.isPrimary)?.defaultKey,
                       LoopDefaultLoopKey.regression)
        XCTAssertEqual(migrated.loops.first { $0.name == "Main Loop" }?.isPrimary, false)
    }

    /// Exactly one editable loop, for a project set up from scratch too.
    func testFirstTimeProjectGetsOneEditableLoopBesideTheBuiltIns() throws {
        try writeLlmIdeLayout()
        let store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        let editable = store.loops.filter { !$0.isDefault }
        XCTAssertEqual(editable.map(\.name), ["Main Loop"])
        XCTAssertTrue(editable[0].config.stages.isEmpty, "an empty canvas, not a copy of the built-ins")
    }

    /// The editable loop is seeded, not enforced: deleting your own loop has to
    /// stick, or Delete would look like a button that does nothing.
    func testDeletingTheEditableLoopIsNotUndoneOnTheNextLoad() throws {
        try writeLlmIdeLayout()
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        store.loops.removeAll { !$0.isDefault }
        let reloaded = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo).store
        XCTAssertTrue(reloaded.loops.allSatisfy(\.isDefault))
        XCTAssertEqual(reloaded.loops.filter(\.isPrimary).count, 1)
    }

    /// A user-added stage is not a built-in, so it never moves — and the loop
    /// holding it survives instead of being tidied away.
    func testMigrationLeavesUserAddedStagesInTheirOwnLoop() throws {
        try writeLlmIdeLayout()
        let mine = LoopStage(id: "u1", name: "My lint", kind: .shellCommand,
                             command: "make lint", order: 99)
        let migrated = LoopStageDetector.ensureDefaultLoops(
            in: legacyAggregateStore(extraStages: [mine]), gitRoot: repo).store
        let survivor = migrated.loops.first { $0.name == "Main Loop" }
        XCTAssertEqual(survivor?.config.stages.map(\.id), ["u1"])
        XCTAssertNil(survivor?.defaultKey, "a surviving aggregate is an ordinary user loop")
    }

    /// A project opened on the pre-split build with SEVERAL loops had the
    /// aggregate helper clone the pinned defaults into every one of them. The
    /// duplicates have to collapse, and the Primary loop's tuned copy is the
    /// one that should win.
    func testDuplicatedPinnedStagesCollapseAndThePrimarysCopyWins() throws {
        try write("extension/tests/agent-skills.test.mjs")
        let cloned = { (command: String) in
            LoopEngineConfig(stages: [
                LoopStage(id: "r-\(command)", name: "Regression", kind: .regressionSweep,
                          order: 0, isDefault: true, defaultKey: "regression"),
                LoopStage(id: "s-\(command)", name: "Skills", kind: .shellCommand,
                          command: command, order: 1, isDefault: true, defaultKey: "skills")
            ])
        }
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Second", isPrimary: false, config: cloned("second cmd")),
            LoopDefinition(name: "Main Loop", isPrimary: true, config: cloned("primary cmd"))
        ])
        let migrated = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo).store
        let skills = migrated.loop(defaultKey: LoopDefaultLoopKey.systemCheck)?
            .config.stages.filter { $0.defaultKey == "skills" }
        XCTAssertEqual(skills?.count, 1)
        XCTAssertEqual(skills?.first?.command, "primary cmd")
        // And no clone is left behind in the loops they came from.
        for loop in migrated.loops where loop.defaultKey == nil {
            XCTAssertTrue(loop.config.stages.allSatisfy { $0.defaultKey == nil })
        }
    }

    /// `ensureDefaultLoops` runs on EVERY load, so a second pass must be a
    /// no-op — otherwise it would rewrite the committed `loop.json` (and
    /// reshuffle the user's loops) every time the page opened.
    func testEnsureDefaultLoopsIsIdempotent() throws {
        try writeLlmIdeLayout()
        let once = LoopStageDetector.ensureDefaultLoops(in: legacyAggregateStore(), gitRoot: repo).store
        let twice = LoopStageDetector.ensureDefaultLoops(in: once, gitRoot: repo).store
        XCTAssertEqual(once, twice)
    }

    /// A built-in loop cannot be deleted — this is the mechanism behind that
    /// promise, since the UI's hidden Delete button is only the front door.
    func testAMissingDefaultLoopIsRecreated() throws {
        try writeLlmIdeLayout()
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        store.loops.removeAll { $0.defaultKey == LoopDefaultLoopKey.systemCheck }
        let restored = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo).store
        XCTAssertNotNil(restored.loop(defaultKey: LoopDefaultLoopKey.systemCheck))
    }

    /// A temporarily unresolvable git root (project folder still populating)
    /// must never be read as "these loops no longer apply".
    func testAnUnresolvableGitRootDeletesNothing() throws {
        try writeLlmIdeLayout()
        let full = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        let withoutRoot = LoopStageDetector.ensureDefaultLoops(in: full, gitRoot: nil).store
        XCTAssertEqual(withoutRoot.loops.compactMap(\.defaultKey).sorted(),
                       full.loops.compactMap(\.defaultKey).sorted())
        XCTAssertEqual(withoutRoot.loop(defaultKey: LoopDefaultLoopKey.systemCheck)?
            .config.stages.count, 7)
    }

    // MARK: - Scheduling

    /// A default loop is created OPTED OUT of the schedule: creating loops for
    /// a project must not start running them on a cron by itself.
    func testFreshDefaultLoopsAreNotScheduledUntilOptedIn() throws {
        try writeLlmIdeLayout()
        let store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        XCTAssertEqual(store.loops.compactMap(\.defaultKey).sorted(),
                       defaultLoopKeysInAnyRepo.sorted(),
                       "every default loop still exists — it is only unscheduled")
        XCTAssertTrue(store.scheduledLoops.isEmpty)
    }

    /// Each scheduled loop runs as its own independent run; this is the list
    /// the Auto Task iterates.
    func testScheduledLoopsSkipsOptedOutAndFullyDisabledLoops() throws {
        try writeLlmIdeLayout()
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        // Opt every loop in, the way the user does from the Loop page — the
        // schedule is opt-in, so there is nothing to filter until they have.
        store.loops = store.loops.map { loop in
            var copy = loop
            copy.runsOnSchedule = true
            return copy
        }
        // Five, not six: the Refactoring loop edits code and is manual-only,
        // so the schedule skips it even with its flag forced on.
        XCTAssertEqual(store.scheduledLoops.count, 5)
        XCTAssertFalse(store.scheduledLoops.contains { $0.defaultKey == LoopDefaultLoopKey.refactor })

        let testIndex = store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.test }!
        store.loops[testIndex].runsOnSchedule = false
        let checkIndex = store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.systemCheck }!
        store.loops[checkIndex].config.stages = store.loops[checkIndex].config.stages.map {
            var copy = $0
            copy.enabled = false
            return copy
        }
        XCTAssertEqual(store.scheduledLoops.map(\.defaultKey),
                       [LoopDefaultLoopKey.regression, LoopDefaultLoopKey.plan, LoopDefaultLoopKey.docs])
    }

    /// "Run just this stage" has to find the stage wherever it lives now — the
    /// stages a surface offers come from several independent loops.
    func testLoopContainingFindsAStageOutsideThePrimaryLoop() throws {
        try writeLlmIdeLayout()
        let store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo).store
        let macApp = store.loop(defaultKey: LoopDefaultLoopKey.systemCheck)?
            .config.stages.first { $0.defaultKey == "mac-app" }
        XCTAssertNotNil(macApp)
        XCTAssertEqual(store.loopContaining(stageId: macApp!.id)?.defaultKey,
                       LoopDefaultLoopKey.systemCheck)
        XCTAssertNil(store.loopContaining(stageId: "nope"))
    }

    // MARK: - Codable

    /// A loop written by the pre-split build has neither field; both defaults
    /// must be the pre-split behaviour — an ordinary user loop that the
    /// scheduler still runs.
    func testLoopFromBeforeTheSplitDecodesAsAScheduledUserLoop() throws {
        let json = #"{"id":"l1","name":"Main Loop","isPrimary":true,"scopeGlobs":[],"config":{"stages":[]}}"#
        let decoded = try JSONDecoder().decode(LoopDefinition.self, from: Data(json.utf8))
        XCTAssertNil(decoded.defaultKey)
        XCTAssertFalse(decoded.isDefault)
        XCTAssertTrue(decoded.runsOnSchedule)
    }

    func testDefaultKeyAndScheduleFlagSurviveARoundTrip() throws {
        var loop = LoopDefinition(name: "System Check", defaultKey: LoopDefaultLoopKey.systemCheck,
                                  config: LoopEngineConfig(stages: []))
        loop.runsOnSchedule = false
        let decoded = try JSONDecoder().decode(
            LoopDefinition.self, from: try JSONEncoder().encode(loop))
        XCTAssertEqual(decoded.defaultKey, LoopDefaultLoopKey.systemCheck)
        XCTAssertFalse(decoded.runsOnSchedule)
    }
}

// MARK: - Mac-app System Check command (memory keychain)

final class LoopMacAppCommandTests: XCTestCase {
    private var repo: URL!

    override func setUpWithError() throws {
        repo = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-macapp-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try "".write(to: repo.appendingPathComponent("x"), atomically: true, encoding: .utf8)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: repo)
    }

    func testDefaultUsesMakeTargetWhenPresentElseEnvVar() throws {
        XCTAssertEqual(LoopStageDetector.macAppCommand(gitRoot: repo),
                       "cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test")
        try "test-mac:\n\techo hi\n".write(to: repo.appendingPathComponent("Makefile"),
                                          atomically: true, encoding: .utf8)
        XCTAssertEqual(LoopStageDetector.macAppCommand(gitRoot: repo), "make test-mac")
    }

    private func loop(command: String) -> LoopDefinition {
        var stage = LoopStage(id: "m", name: "Mac app", kind: .shellCommand, command: command, order: 1)
        stage.defaultKey = "mac-app"
        stage.isDefault = true
        var other = LoopStage(id: "o", name: "Other", kind: .shellCommand, command: "cd mac && swift test", order: 2)
        other.defaultKey = nil
        var def = LoopDefinition(name: "System Check", defaultKey: LoopDefaultLoopKey.systemCheck,
                                 config: LoopEngineDefaults.newConfig(stages: [], defaults: .standard))
        def.config.stages = [stage, other]
        return def
    }

    func testMigrationUpdatesOnlyTheExactOldCommandAndIsIdempotent() throws {
        try "test-mac:\n".write(to: repo.appendingPathComponent("Makefile"), atomically: true, encoding: .utf8)
        let once = LoopStageDetector.migratingMacAppCommand(
            in: [loop(command: "cd mac && swift test")], gitRoot: repo)
        XCTAssertEqual(once[0].config.stages[0].command, "make test-mac")
        XCTAssertEqual(once[0].config.stages[1].command, "cd mac && swift test", "unkeyed stage untouched")
        let twice = LoopStageDetector.migratingMacAppCommand(in: once, gitRoot: repo)
        XCTAssertEqual(twice, once)

        let edited = loop(command: "cd mac && swift test --filter Foo")
        XCTAssertEqual(LoopStageDetector.migratingMacAppCommand(in: [edited], gitRoot: repo), [edited])
    }

    func testMigrationCarriesTheStagesApprovalToTheNewCommand() throws {
        try "test-mac:\n".write(to: repo.appendingPathComponent("Makefile"), atomically: true, encoding: .utf8)
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: "mac-app-migration-\(UUID().uuidString)")!)
        approvals.approveStage(repo: repo, stageId: "m", command: "cd mac && swift test")
        _ = LoopStageDetector.migratingMacAppCommand(
            in: [loop(command: "cd mac && swift test")], gitRoot: repo, approvals: approvals)
        XCTAssertTrue(approvals.isStageApproved(repo: repo, stageId: "m", command: "make test-mac"),
                      "the approved stage stays approved after its command is migrated")
        XCTAssertFalse(approvals.isStageApproved(repo: repo, stageId: "o", command: "make test-mac"),
                       "nothing is approved for a stage the migration did not change")
    }

    func testMigrationDoesNotApproveAnUnapprovedStage() throws {
        try "test-mac:\n".write(to: repo.appendingPathComponent("Makefile"), atomically: true, encoding: .utf8)
        let approvals = VerifyApprovalStore(defaults: UserDefaults(suiteName: "mac-app-migration-\(UUID().uuidString)")!)
        _ = LoopStageDetector.migratingMacAppCommand(
            in: [loop(command: "cd mac && swift test")], gitRoot: repo, approvals: approvals)
        XCTAssertFalse(approvals.isStageApproved(repo: repo, stageId: "m", command: "make test-mac"))
    }
}
