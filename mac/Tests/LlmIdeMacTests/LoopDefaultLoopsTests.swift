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

    func testBareRepoGetsOnlyTheRegressionLoop() {
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        XCTAssertEqual(loops.map(\.defaultKey), [LoopDefaultLoopKey.regression])
        XCTAssertEqual(loops[0].name, "Regression")
        XCTAssertEqual(loops[0].config.stages.map(\.kind), [.regressionSweep])
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

    func testLlmIdeLayoutGetsAllThreeLoopsWithTheChecksInSystemCheck() throws {
        try writeLlmIdeLayout()
        let loops = LoopStageDetector.defaultLoops(gitRoot: repo)
        XCTAssertEqual(loops.map(\.defaultKey),
                       [LoopDefaultLoopKey.regression, LoopDefaultLoopKey.test,
                        LoopDefaultLoopKey.systemCheck])
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
            in: LoopEngineProjectStore(loops: []), gitRoot: repo)
        for loop in store.loops {
            guard let loopKey = loop.defaultKey else { continue }
            // Re-running the ensure must move nothing, which is only true if
            // every stage the loop emits is owned by that same loop.
            let again = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo)
            XCTAssertEqual(again.loop(defaultKey: loopKey)?.config.stages.compactMap(\.defaultKey),
                           loop.config.stages.compactMap(\.defaultKey),
                           "\(loopKey) loses or gains stages on a second ensure")
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

    func testLegacyAggregateLoopSplitsIntoTheThreeDefaultLoops() throws {
        try writeLlmIdeLayout()
        let migrated = LoopStageDetector.ensureDefaultLoops(in: legacyAggregateStore(), gitRoot: repo)
        XCTAssertEqual(Set(migrated.loops.compactMap(\.defaultKey)),
                       Set(LoopDefaultLoopKey.all))
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

        let migrated = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo)
        let backend = migrated.loop(defaultKey: LoopDefaultLoopKey.systemCheck)?
            .config.stages.first { $0.defaultKey == "backend" }
        XCTAssertEqual(backend?.command, "cd extension && npm run test:fast")
        XCTAssertEqual(backend?.enabled, false)
        for loop in migrated.loops {
            XCTAssertEqual(loop.config.maxIterations, 7, "\(loop.name) lost the project's budgets")
            XCTAssertEqual(loop.config.maxRepairsPerStage, 5)
        }
    }


    /// Primary is what the phone and the chat command run, so it must never
    /// land on the stage-less loop the split leaves behind.
    func testMigrationMovesPrimaryOffTheEmptiedEditableLoop() throws {
        try writeLlmIdeLayout()
        let migrated = LoopStageDetector.ensureDefaultLoops(in: legacyAggregateStore(), gitRoot: repo)
        XCTAssertEqual(migrated.loops.first(where: \.isPrimary)?.defaultKey,
                       LoopDefaultLoopKey.regression)
        XCTAssertEqual(migrated.loops.first { $0.name == "Main Loop" }?.isPrimary, false)
    }

    /// Exactly one editable loop, for a project set up from scratch too.
    func testFirstTimeProjectGetsOneEditableLoopBesideTheBuiltIns() throws {
        try writeLlmIdeLayout()
        let store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo)
        let editable = store.loops.filter { !$0.isDefault }
        XCTAssertEqual(editable.map(\.name), ["Main Loop"])
        XCTAssertTrue(editable[0].config.stages.isEmpty, "an empty canvas, not a copy of the built-ins")
    }

    /// The editable loop is seeded, not enforced: deleting your own loop has to
    /// stick, or Delete would look like a button that does nothing.
    func testDeletingTheEditableLoopIsNotUndoneOnTheNextLoad() throws {
        try writeLlmIdeLayout()
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo)
        store.loops.removeAll { !$0.isDefault }
        let reloaded = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo)
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
            in: legacyAggregateStore(extraStages: [mine]), gitRoot: repo)
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
        let migrated = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo)
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
        let once = LoopStageDetector.ensureDefaultLoops(in: legacyAggregateStore(), gitRoot: repo)
        let twice = LoopStageDetector.ensureDefaultLoops(in: once, gitRoot: repo)
        XCTAssertEqual(once, twice)
    }

    /// A built-in loop cannot be deleted — this is the mechanism behind that
    /// promise, since the UI's hidden Delete button is only the front door.
    func testAMissingDefaultLoopIsRecreated() throws {
        try writeLlmIdeLayout()
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo)
        store.loops.removeAll { $0.defaultKey == LoopDefaultLoopKey.systemCheck }
        let restored = LoopStageDetector.ensureDefaultLoops(in: store, gitRoot: repo)
        XCTAssertNotNil(restored.loop(defaultKey: LoopDefaultLoopKey.systemCheck))
    }

    /// A temporarily unresolvable git root (project folder still populating)
    /// must never be read as "these loops no longer apply".
    func testAnUnresolvableGitRootDeletesNothing() throws {
        try writeLlmIdeLayout()
        let full = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo)
        let withoutRoot = LoopStageDetector.ensureDefaultLoops(in: full, gitRoot: nil)
        XCTAssertEqual(withoutRoot.loops.compactMap(\.defaultKey).sorted(),
                       full.loops.compactMap(\.defaultKey).sorted())
        XCTAssertEqual(withoutRoot.loop(defaultKey: LoopDefaultLoopKey.systemCheck)?
            .config.stages.count, 7)
    }

    // MARK: - Scheduling

    /// Each scheduled loop runs as its own independent run; this is the list
    /// the Auto Task iterates.
    func testScheduledLoopsSkipsOptedOutAndFullyDisabledLoops() throws {
        try writeLlmIdeLayout()
        var store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo)
        XCTAssertEqual(store.scheduledLoops.count, 3)

        let testIndex = store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.test }!
        store.loops[testIndex].runsOnSchedule = false
        let checkIndex = store.loops.firstIndex { $0.defaultKey == LoopDefaultLoopKey.systemCheck }!
        store.loops[checkIndex].config.stages = store.loops[checkIndex].config.stages.map {
            var copy = $0
            copy.enabled = false
            return copy
        }
        XCTAssertEqual(store.scheduledLoops.map(\.defaultKey), [LoopDefaultLoopKey.regression])
    }

    /// "Run just this stage" has to find the stage wherever it lives now — the
    /// stages a surface offers come from several independent loops.
    func testLoopContainingFindsAStageOutsideThePrimaryLoop() throws {
        try writeLlmIdeLayout()
        let store = LoopStageDetector.ensureDefaultLoops(
            in: LoopEngineProjectStore(loops: []), gitRoot: repo)
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
