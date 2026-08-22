import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoCodeUpdateServiceLoopEngineeringTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "loop-eng-service-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    // NOTE: `runLoopEngineeringSweep` checks `api` before `projectRoot` (same
    // guard order as its sibling `runRegressionSweep`), so a service built
    // with `api: nil` would report "no API client wired" instead of the
    // "no project root resolved" message this test wants to isolate. A
    // dummy `LlmIdeAPIClient` (never actually called — the empty-projectRoot
    // guard returns before any request is made) is wired in so the
    // project-root guard is the one under test. Same construction pattern as
    // `SourceConnectorRootTests`/`SourceConnectorEngineTests`.
    private func makeService() -> AutoCodeUpdateService {
        let registry = ProcessedActionsRegistry(
            storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json"))
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: AutoTaskSettings(defaults: suite),
            registry: registry,
            api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456"),
            logStore: TaskLogStore())
    }

    func testSkipsWithTaskErrorWhenProjectRootIsEmpty() async {
        let service = makeService()
        await service.runLoopEngineeringSweep(projectRoot: "", gitRoot: "", projectId: nil)
        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue], "Loop skipped — no project root resolved.")
    }

    /// `projectId` is now a plain parameter (per the Task 9 review — the
    /// caller resolves it once alongside `resolved`, rather than this method
    /// re-reading `projectStore?.activeProject?.bundle.id` internally), so
    /// this guard is directly testable without wiring up a real ProjectStore.
    func testSkipsWithTaskErrorWhenProjectIdIsNil() async {
        let service = makeService()
        await service.runLoopEngineeringSweep(
            projectRoot: "/tmp/loop-eng-test-project",
            gitRoot: "/tmp/loop-eng-test-repo",
            projectId: nil)
        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue], "Loop skipped — no active project.")
    }

    /// Regression test for the false-green persistence bug: a tree with no
    /// recognized test tooling (no Package.swift/package.json/Makefile/
    /// pytest markers) makes `LoopStageDetector` yield the bare Regression
    /// stage only, which must be used for THIS run but never saved — saving
    /// it would permanently and silently disable the Test stage for every
    /// future run. `defaults: suite` (an isolated UserDefaults suite,
    /// threaded through `runLoopEngineeringSweep` for exactly this reason)
    /// lets the persistence branch be asserted on directly instead of only
    /// against the developer's real UserDefaults.
    func testDoesNotPersistBareRegressionDetectionAsSavedConfig() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-eng-sweep-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let service = makeService()
        let projectId = "test-project-\(UUID().uuidString)"

        // Empty directory: no fault reports to re-verify (Regression sweep
        // passes trivially) and no shell-command stage (none detected), so
        // this completes without any network call.
        await service.runLoopEngineeringSweep(
            projectRoot: tempDir.path,
            gitRoot: tempDir.path,
            projectId: projectId,
            defaults: suite)

        XCTAssertNil(LoopEngineConfig.load(for: projectId, defaults: suite))
    }

    /// A phone can ask for a stage that was deleted or renamed after its
    /// snapshot. The sweep must refuse with a task error and never start the
    /// runner — not fall back to running the whole pipeline.
    func testUnknownOnlyStageIdRefusesTheRunWithATaskError() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-eng-solo-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let service = makeService()
        await service.runLoopEngineeringSweep(
            projectRoot: tempDir.path,
            gitRoot: tempDir.path,
            projectId: "solo-test-\(UUID().uuidString)",
            defaults: suite,
            onlyStageId: "no-such-stage-id")

        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue],
                       "Loop skipped — the requested stage no longer exists.")
    }

    /// The phone starts ONE loop (the one it displays). An id that no longer
    /// resolves must refuse, never widen into the whole scheduled sweep —
    /// same fail-closed rule as `onlyStageId`.
    func testUnknownOnlyLoopIdRefusesTheRunWithATaskError() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-eng-one-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let service = makeService()
        await service.runLoopEngineeringSweep(
            projectRoot: tempDir.path,
            gitRoot: tempDir.path,
            projectId: "one-loop-test-\(UUID().uuidString)",
            defaults: suite,
            onlyLoopId: "no-such-loop-id")

        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue],
                       "Loop skipped — the requested loop no longer exists, or every stage in it is disabled.")
    }

    /// The seeded editable loop has no stages, so a project that has only it
    /// and the bare Regression loop is PARKED for anything else — and the
    /// stage-less loop must never be treated as a runnable target.
    func testEmptyEditableLoopIsNeverAScheduledTarget() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-eng-parked-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let store = LoopEngineConfigStore.loops(projectRoot: tempDir, projectId: "parked",
                                                gitRoot: tempDir, defaults: suite)
        XCTAssertEqual(store.scheduledLoops.compactMap(\.defaultKey),
                       [LoopDefaultLoopKey.regression, LoopDefaultLoopKey.plan],
                       "only the unconditional loops (Regression, Plan) have stages to run in a bare tree")
        XCTAssertTrue(store.loops.contains { !$0.isDefault && $0.config.stages.isEmpty },
                      "the editable loop exists, it is just not a target yet")
    }
}
