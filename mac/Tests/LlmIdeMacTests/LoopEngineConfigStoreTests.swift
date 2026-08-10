import XCTest
@testable import LlmIdeMacLib

/// This store is what makes a project's Loop contract reload after a fresh clone
/// or on a second machine. A silent write failure or a migration that does not
/// fire looks exactly like "the loop forgot my stages" — the symptom the file was
/// introduced to remove.
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
        let config = makeConfig()
        LoopEngineConfigStore.save(config, projectRoot: projectRoot, projectId: projectId, defaults: defaults)

        XCTAssertTrue(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))
        XCTAssertEqual(
            LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId, defaults: defaults),
            config)
    }

    /// The file is committed, so its diff has to be readable: a compact one-line
    /// blob would turn every budget tweak into an unreviewable diff, and unsorted
    /// keys would churn between otherwise identical writes.
    func testFileIsPrettyPrintedWithSortedKeys() throws {
        LoopEngineConfigStore.save(makeConfig(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        let text = try String(contentsOf: LoopEngineConfigStore.fileURL(projectRoot: projectRoot),
                              encoding: .utf8)
        XCTAssertTrue(text.contains("\n"), "expected pretty-printed JSON")

        let keyOrder = ["consecutiveFailureStop", "extraProtectedGlobs", "maxIterations"]
        let positions = keyOrder.compactMap { text.range(of: "\"\($0)\"")?.lowerBound }
        XCTAssertEqual(positions.count, keyOrder.count)
        XCTAssertEqual(positions, positions.sorted(), "keys should be sorted")
    }

    func testWritingTwiceProducesAnIdenticalFile() throws {
        let config = makeConfig()
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        LoopEngineConfigStore.save(config, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        let first = try Data(contentsOf: url)
        LoopEngineConfigStore.save(config, projectRoot: projectRoot, projectId: projectId, defaults: defaults)
        // Byte-identical, or a committed file would show a diff on every save.
        XCTAssertEqual(try Data(contentsOf: url), first)
    }

    func testSaveCreatesTheSystemDirectoryIfMissing() {
        // A project folder that has never been scaffolded has no system/ yet.
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: projectRoot.appendingPathComponent("system").path))
        LoopEngineConfigStore.save(makeConfig(), projectRoot: projectRoot,
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

    /// A corrupt or half-written file must read as "no config" (so stages are
    /// re-detected) rather than crashing the page.
    func testCorruptFileReadsAsNoConfig() throws {
        let url = LoopEngineConfigStore.fileURL(projectRoot: projectRoot)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: url)
        XCTAssertNil(LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults))
    }

    // MARK: - Migration from UserDefaults

    /// A project configured before the file existed must become portable the first
    /// time it is opened, with no action from the user.
    func testLegacyUserDefaultsConfigIsMigratedToTheFileOnLoad() {
        makeConfig(iterations: 4, stage: "Legacy").save(for: projectId, defaults: defaults)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.maxIterations, 4)
        XCTAssertEqual(loaded?.stages.first?.name, "Legacy")
        // The migration is the point: the NEXT load must come from the file.
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: LoopEngineConfigStore.fileURL(projectRoot: projectRoot).path))
    }

    /// Once the file exists it is authoritative — a stale UserDefaults entry (e.g.
    /// written by an older build) must not win, or edits would silently revert.
    func testFileWinsOverAStaleUserDefaultsEntry() {
        makeConfig(iterations: 2, stage: "Stale").save(for: projectId, defaults: defaults)
        LoopEngineConfigStore.save(makeConfig(iterations: 9, stage: "Current"),
                                   projectRoot: projectRoot, projectId: projectId, defaults: defaults)

        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot, projectId: projectId,
                                                defaults: defaults)
        XCTAssertEqual(loaded?.maxIterations, 9)
        XCTAssertEqual(loaded?.stages.first?.name, "Current")
    }

    /// Saving must not keep the legacy entry in step: two writable copies of one
    /// config is the drift that makes "which is live?" unanswerable.
    func testSaveDoesNotWriteBackToUserDefaultsWhenAFolderIsAvailable() {
        LoopEngineConfigStore.save(makeConfig(), projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)
        XCTAssertNil(LoopEngineConfig.load(for: projectId, defaults: defaults))
    }

    // MARK: - No project folder

    /// With no resolvable project folder there is nowhere to put a file, so the
    /// UserDefaults path must still work rather than silently dropping the config.
    func testFallsBackToUserDefaultsWhenNoProjectRootIsAvailable() {
        let config = makeConfig(iterations: 5)
        LoopEngineConfigStore.save(config, projectRoot: nil, projectId: projectId, defaults: defaults)
        XCTAssertEqual(
            LoopEngineConfigStore.load(projectRoot: nil, projectId: projectId, defaults: defaults),
            config)
        XCTAssertEqual(LoopEngineConfig.load(for: projectId, defaults: defaults), config)
    }

    // MARK: - Portability

    /// The scenario the file exists for: a second checkout of the same repo, on a
    /// machine whose UserDefaults knows nothing about this project.
    func testConfigTravelsWithTheProjectFolderToAFreshUserDefaults() throws {
        let config = LoopEngineConfig(
            stages: [
                LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, order: 0),
                LoopStage(id: "l1", name: "Lint", kind: .shellCommand, command: "make lint",
                          order: 1, severity: .advisory, timeoutSeconds: 60)
            ],
            maxIterations: 3, consecutiveFailureStop: 4,
            wallClockBudgetSeconds: nil, maxRepairsPerStage: 2,
            protectedPathPolicy: .stop, extraProtectedGlobs: ["fixtures/**"],
            writeSummaryNote: true)
        LoopEngineConfigStore.save(config, projectRoot: projectRoot,
                                   projectId: projectId, defaults: defaults)

        // A different machine: same folder, an empty UserDefaults, and a project id
        // that account has never seen.
        let freshDefaults = UserDefaults(suiteName: "fresh-\(UUID().uuidString)")!
        let loaded = LoopEngineConfigStore.load(projectRoot: projectRoot,
                                                 projectId: "some-other-id",
                                                 defaults: freshDefaults)
        XCTAssertEqual(loaded, config)
        // Including the fields most easily lost in a hand-written encoder.
        XCTAssertNil(loaded?.wallClockBudgetSeconds)
        XCTAssertEqual(loaded?.protectedPathPolicy, .stop)
        XCTAssertEqual(loaded?.extraProtectedGlobs, ["fixtures/**"])
        XCTAssertEqual(loaded?.stages.last?.severity, .advisory)
    }
}
