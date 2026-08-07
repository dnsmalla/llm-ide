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
        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue], "Loop Engineering skipped — no project root resolved.")
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
        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue], "Loop Engineering skipped — no active project.")
    }
}
