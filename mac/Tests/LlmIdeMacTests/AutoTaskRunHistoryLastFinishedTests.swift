import XCTest
@testable import LlmIdeMacLib

/// `AutoTaskRunHistory.lastFinishedAt`: the routines' last run prefers the
/// active project's run, then a run with no project, and never another project's.
final class AutoTaskRunHistoryLastFinishedTests: XCTestCase {

    private var storeURL: URL!

    override func setUp() {
        super.setUp()
        storeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("auto-task-last-\(UUID().uuidString).json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: storeURL)
        storeURL = nil
        super.tearDown()
    }

    private func record(task: String, project: String?, finishedAt: Date) -> AutoTaskRunRecord {
        AutoTaskRunRecord(id: UUID().uuidString, taskId: task, taskLabel: task, trigger: .cron,
                          startedAt: finishedAt.addingTimeInterval(-1), finishedAt: finishedAt,
                          status: .success, summary: nil, logFileName: nil, projectId: project)
    }

    func testTheActiveProjectsRunWinsOverANewerRunInAnotherProject() {
        let history = AutoTaskRunHistory(storeURL: storeURL)
        let mine = Date(timeIntervalSince1970: 1_000)
        history.record(record(task: "reviewCode", project: "mine", finishedAt: mine))
        history.record(record(task: "reviewCode", project: "other", finishedAt: mine.addingTimeInterval(500)))
        XCTAssertEqual(history.lastFinishedAt(taskId: "reviewCode", projectId: "mine"), mine)
    }

    func testAProjectWithNoRunFallsBackToARunWithNoProjectOnly() {
        let history = AutoTaskRunHistory(storeURL: storeURL)
        let unscoped = Date(timeIntervalSince1970: 2_000)
        history.record(record(task: "reviewCode", project: nil, finishedAt: unscoped))
        history.record(record(task: "reviewCode", project: "other", finishedAt: unscoped.addingTimeInterval(900)))
        XCTAssertEqual(history.lastFinishedAt(taskId: "reviewCode", projectId: "mine"), unscoped)
        XCTAssertEqual(history.lastFinishedAt(taskId: "reviewCode", projectId: nil), unscoped)
    }

    func testAnotherProjectsRunIsNeverReportedAndOtherTasksDoNotCount() {
        let history = AutoTaskRunHistory(storeURL: storeURL)
        history.record(record(task: "reviewCode", project: "other", finishedAt: Date(timeIntervalSince1970: 3_000)))
        history.record(record(task: "tests", project: "mine", finishedAt: Date(timeIntervalSince1970: 4_000)))
        XCTAssertNil(history.lastFinishedAt(taskId: "reviewCode", projectId: "mine"))
        XCTAssertNil(history.lastFinishedAt(taskId: "reviewCode", projectId: nil))
    }

    func testTheLookupReadsRunsThatAreOlderThanTheRecentWindow() {
        // The store keeps the newest 200 runs. A run of this task older than the
        // 50 most recent (what the old `recentEntries(limit: 200)` call looked at)
        // is still found.
        let history = AutoTaskRunHistory(storeURL: storeURL)
        let old = Date(timeIntervalSince1970: 5_000)
        history.record(record(task: "reviewCode", project: "mine", finishedAt: old))
        for i in 0..<60 {
            history.record(record(task: "filler\(i)", project: "mine", finishedAt: old.addingTimeInterval(Double(i + 1))))
        }
        XCTAssertEqual(history.lastFinishedAt(taskId: "reviewCode", projectId: "mine"), old)
    }
}
