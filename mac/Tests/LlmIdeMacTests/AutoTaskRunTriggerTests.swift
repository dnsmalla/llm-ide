import XCTest
@testable import LlmIdeMacLib

/// The trigger recorded on an Auto Task run used to live in a stored property
/// on the service, assigned by callers before starting a run. That lost the
/// `.phone` trigger (the entry point overwrote it inside its own Task) and let
/// a cron tick relabel a run that was already in flight. It is now a parameter
/// threaded to `appendRunRecord`; these tests pin that down.
@MainActor
final class AutoTaskRunTriggerTests: XCTestCase {
    private var suite: UserDefaults!
    private var suiteName: String!
    private var historyURL: URL!

    override func setUp() {
        super.setUp()
        suiteName = "svc-run-trigger-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
        historyURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("run-trigger-\(UUID().uuidString).json")
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        try? FileManager.default.removeItem(at: historyURL)
        historyURL = nil
        super.tearDown()
    }

    /// Mirrors `AutoCodeUpdateServiceCustomTaskTests.makeService()`, plus an
    /// injected history store so the recorded trigger is observable.
    private func makeService() -> AutoCodeUpdateService {
        AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: AutoTaskSettings(defaults: suite),
            registry: ProcessedActionsRegistry(
                storeURL: FileManager.default.temporaryDirectory
                    .appendingPathComponent("registry-\(UUID().uuidString).json")),
            runHistory: AutoTaskRunHistory(storeURL: historyURL),
            logStore: TaskLogStore())
    }

    /// No projectStore is wired, so the run guards out early — but it still
    /// writes a record, which is all this needs to observe.
    func testPhoneTriggerSurvivesToTheRecordedRun() async {
        let svc = makeService()
        await svc.runCustomTask(CustomAutoTask(name: "T", template: "p"), trigger: .phone)
        XCTAssertEqual(svc.runHistoryEntries.first?.trigger, .phone)
    }

    func testDefaultTriggerForAManualCustomRunIsManual() async {
        let svc = makeService()
        await svc.runCustomTask(CustomAutoTask(name: "T", template: "p"))
        XCTAssertEqual(svc.runHistoryEntries.first?.trigger, .manual)
    }

    /// A run started as `.phone` must not be relabelled by a later entry point
    /// choosing a different trigger — the value is carried on the stack, not
    /// read from the service when the record is written.
    func testASecondRunDoesNotRelabelTheFirstRecord() async {
        let svc = makeService()
        await svc.runCustomTask(CustomAutoTask(name: "First", template: "p"), trigger: .phone)
        await svc.runCustomTask(CustomAutoTask(name: "Second", template: "p"), trigger: .cron)

        // Assert positionally rather than building a dictionary: a duplicate
        // key would TRAP, and "one run wrote two records" is exactly the
        // regression this test exists to catch. Newest first.
        XCTAssertEqual(svc.runHistoryEntries.count, 2)
        XCTAssertEqual(svc.runHistoryEntries.map(\.taskLabel), ["Second", "First"])
        XCTAssertEqual(svc.runHistoryEntries.map(\.trigger), [.cron, .phone])
    }
}
