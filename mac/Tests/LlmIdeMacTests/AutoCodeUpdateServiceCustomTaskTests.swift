import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoCodeUpdateServiceCustomTaskTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "svc-custom-task-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }
    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName); suite = nil
        super.tearDown()
    }

    /// No projectStore wired -> resolveBackendAndProject() returns nil ->
    /// runCustomTask must guard out early with a task-specific error,
    /// exactly like runOne(_:) does for a built-in task with no linked repo.
    /// This mirrors AutoCodeUpdateServiceCronTests.makeService()'s minimal
    /// construction style (scheduling/guard tests, not full CLI execution).
    private func makeService() -> AutoCodeUpdateService {
        let settings = AutoTaskSettings(defaults: suite)
        let registry = ProcessedActionsRegistry(
            storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json"))
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: settings,
            registry: registry,
            logStore: TaskLogStore())
    }

    func testRunCustomTaskWithNoLinkedRepoSetsTaskErrorAndDoesNotCrash() async {
        let svc = makeService()
        let task = CustomAutoTask(name: "No Repo Task", template: "do something")

        await svc.runCustomTask(task)

        XCTAssertFalse(svc.isRunning)
        XCTAssertNil(svc.currentCustomTaskId)
        XCTAssertEqual(svc.statusMessage, "No linked repo")
        XCTAssertNotNil(svc.taskErrors[task.id])
    }

    func testRunSingleCustomReturnsFalseWhileAlreadyRunning() {
        let svc = makeService()
        let task = CustomAutoTask(name: "Task", template: "prompt")

        // runSingle/runSingleCustom share the same runTask re-entrancy guard.
        XCTAssertTrue(svc.runSingle(.reviewCode))
        XCTAssertFalse(svc.runSingleCustom(task))
    }
}
