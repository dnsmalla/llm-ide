import XCTest
@testable import LlmIdeMacLib

/// This store is what makes a project's Loop contract reload after a fresh
/// clone or on a second machine, and what upgrades an existing single-loop
/// project to the multi-loop schema with no action from the user. A silent
/// write failure or a migration that does not fire looks exactly like "the
/// loop forgot my stages" — the symptom the file was introduced to remove.
final class LoopEngineConfigStoreTests: XCTestCase {
    private var projectRoot: URL!
    private var defaults: UserDefaults!
    private let projectId = "proj-1"

    override func setUpWithError() throws {
        try super.setUpWithError()
        projectRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("loop-config-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: projectRoot, withIntermediateDirectories: true)
        defaults = UserDefaults(suiteName: "loop-config-store-\(UUID().uuidString)")!
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: projectRoot)
        try super.tearDownWithError()
    }

    private func makeConfig(iterations: Int = 7, stage: String = "Test") -> LoopEngineConfig {
        LoopEngineConfig(
            stages: [LoopStage(id: "t1", name: stage, kind: .shellCommand,
                               command: "swift test", order: 0)],
            maxIterations: iterations)
    }

    private func makeStore(iterations: Int = 7, stage: String = "Test",
                           name: String = "Main Loop") -> LoopEngineProjectStore {
        LoopEngineProjectStore(loops: [
            LoopDefinition(name: name, isPrimary: true, config: makeConfig(iterations: iterations, stage: stage))
        ])
    }

    // MARK: - Location

    func testConfigLivesAtSystemLoopJson() {
        XCTAssertEqual(LoopEngineConfigStore.fileURL(projectRoot: projectRoot).lastPathComponent,
                       "loop.json")
        XCTAssertEqual(
            LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
                .deletingLastPathComponent().lastPathComponent,
            "system")
    }

    // MARK: - Round trip

    func testSaveWritesTheFileAndLoadReadsItBack() {
        let store = makeStore()
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)

        XCTAssertTrue(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))
        XCTAssertEqual(
            LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId, defaults: defaults),
            store)
    }

    /// The file is committed, so its diff has to be readable.
    func testFileIsPrettyPrintedWithSortedKeys() throws {
        LoopEngineConfigStore.save(makeStore(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        let text = try String(contentsOf: LoopEngineConfigStore.fileURL(projectRoot: projectRoot),
                              encoding: .utf8)
        XCTAssertTrue(text.contains("\n"), "expected pretty-printed JSON")
        let keyOrder = ["isPrimary", "loops", "name"]
        let positions = keyOrder.compactMap { text.range(of: "\"\($0)\"")?.lowerBound }
        XCTAssertEqual(positions.count, keyOrder.count)
        XCTAssertEqual(positions, positions.sorted(), "keys should be sorted")
    }

    func testWritingTwiceProducesAnIdenticalFile() throws {
        let store = makeStore()
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let first = try Data(contentsOf: url)
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        XCTAssertEqual(try Data(contentsOf: url), first)
    }

    func testSaveCreatesTheSystemDirectoryIfMissing() {
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: projectRoot.appendingPathComponent("system").path))
        LoopEngineConfigStore.save(makeStore(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        XCTAssertNotNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                   defaults: defaults))
    }

    // MARK: - No saved config

    func testLoadReturnsNilForAProjectWithNoConfig() {
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults))
        XCTAssertFalse(LoopEngineConfigStore.exists(projectRoot: projectRoot, projectId: projectId,
                                                    defaults: defaults))
    }

    func testCorruptFileReadsAsNoConfig() throws {
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: url)
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults))
    }

    // MARK: - Migration: legacy bare-config FILE (pre-multi-loop)

    /// The exact scenario every existing project is in the moment this ships:
    /// `system/loop.json` holds a bare `LoopEngineConfig`, no `loops` key.
    func testLegacyBareConfigFileMigratesToOneWrappedPrimaryLoop() throws {
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let legacyConfig = makeConfig(iterations: 4, stage: "Legacy")
        try JSONEncoder().encode(legacyConfig).write(to: url)

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.loops.count, 1)
        XCTAssertEqual(loaded?.loops.first?.name, "Main Loop")
        XCTAssertEqual(loaded?.loops.first?.isPrimary, true)
        XCTAssertEqual(loaded?.loops.first?.config, legacyConfig)

        // The migration is the point: the NEXT read must decode the NEW
        // schema, not re-run the migration.
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains("\"loops\""))
    }

    // MARK: - Migration from UserDefaults (pre-file era)

    func testLegacyUserDefaultsConfigIsMigratedToTheFileAsOnePrimaryLoop() {
        makeConfig(iterations: 4, stage: "Legacy").save(for: projectId, defaults: defaults)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.loops.first?.config.maxIterations, 4)
        XCTAssertEqual(loaded?.loops.first?.config.stages.first?.name, "Legacy")
        XCTAssertEqual(loaded?.loops.first?.isPrimary, true)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))
    }

    /// Once the file exists it is authoritative — a stale UserDefaults entry
    /// must not win, or edits would silently revert.
    func testFileWinsOverAStaleUserDefaultsEntry() {
        makeConfig(iterations: 2, stage: "Stale").save(for: projectId, defaults: defaults)
        LoopEngineConfigStore.save(makeStore(iterations: 9, stage: "Current"),
                                   projectRoot: projectRoot, projectId: projectId, defaults: defaults)

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.loops.first?.config.maxIterations, 9)
        XCTAssertEqual(loaded?.loops.first?.config.stages.first?.name, "Current")
    }

    func testSaveDoesNotWriteBackToUserDefaultsWhenAFolderIsAvailable() {
        LoopEngineConfigStore.save(makeStore(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        XCTAssertNil(LoopEngineConfig.load(for: projectId, defaults: defaults))
    }

    // MARK: - No project folder

    /// With no resolvable project folder there is nowhere to put a file, so
    /// the fallback persists the PRIMARY loop's bare config to the legacy
    /// UserDefaults slot — a non-primary loop has nowhere to go in this
    /// corner case, same degraded-but-not-broken behavior this path always
    /// had. The round trip is lossy by design: only the config survives,
    /// re-wrapped as a fresh "Main Loop" on load, not the original loop's
    /// id/name/isPrimary/goal/etc.
    func testFallsBackToUserDefaultsWhenNoProjectRootIsAvailable() {
        let store = makeStore(iterations: 5)
        LoopEngineConfigStore.save(store, projectRoot: nil, projectId: projectId, defaults: defaults)
        let loaded = LoopEngineConfigStore.load(projectRoot: nil, projectId: projectId, defaults: defaults)
        XCTAssertEqual(loaded?.loops.count, 1)
        XCTAssertEqual(loaded?.loops.first?.config, store.loops[0].config)
        XCTAssertEqual(LoopEngineConfig.load(for: projectId, defaults: defaults), store.loops[0].config)
    }

    // MARK: - Portability

    func testConfigTravelsWithTheProjectFolderToAFreshUserDefaults() throws {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Main Loop", isPrimary: true, config: LoopEngineConfig(
                stages: [
                    LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, order: 0),
                    LoopStage(id: "l1", name: "Lint", kind: .shellCommand, command: "make lint",
                              order: 1, severity: .advisory, timeoutSeconds: 60)
                ],
                maxIterations: 3, consecutiveFailureStop: 4,
                wallClockBudgetSeconds: nil, maxRepairsPerStage: 2,
                protectedPathPolicy: .stop, extraProtectedGlobs: ["fixtures/**"],
                writeSummaryNote: true))
        ])
        LoopEngineConfigStore.save(store, projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)

        let freshDefaults = UserDefaults(suiteName: "fresh-\(UUID().uuidString)")!
        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot,
                                                 projectId: "some-other-id",
                                                 defaults: freshDefaults)
        XCTAssertEqual(loaded, store)
    }

    // MARK: - primaryLoop

    func testPrimaryLoopResolvesTheLoopMarkedPrimary() {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "Secondary", isPrimary: false, config: makeConfig(stage: "A")),
            LoopDefinition(name: "Main Loop", isPrimary: true, config: makeConfig(stage: "B"))
        ])
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let primary = LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                                        defaults: defaults)
        XCTAssertEqual(primary?.name, "Main Loop")
    }

    /// Defensive fallback — should never happen via the UI, but a hand-edited
    /// file with no `isPrimary: true` loop must not resolve to nil.
    func testPrimaryLoopFallsBackToFirstLoopWhenNoneIsMarkedPrimary() {
        let store = LoopEngineProjectStore(loops: [
            LoopDefinition(name: "First", isPrimary: false, config: makeConfig())
        ])
        LoopEngineConfigStore.save(store, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let primary = LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                                        defaults: defaults)
        XCTAssertEqual(primary?.name, "First")
    }

    func testPrimaryLoopIsNilWhenNoConfigExists() {
        XCTAssertNil(LoopEngineConfigStore.primaryLoop(projectRoot: projectRoot, projectId: projectId,
                                                        defaults: defaults))
    }
}
