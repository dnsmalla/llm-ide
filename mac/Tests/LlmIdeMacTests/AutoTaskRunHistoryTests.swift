import XCTest
@testable import LlmIdeMacLib

final class AutoTaskRunHistoryTests: XCTestCase {

    private var storeURL: URL!

    override func setUp() {
        super.setUp()
        storeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("auto-task-runs-\(UUID().uuidString).json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: storeURL)
        storeURL = nil
        super.tearDown()
    }

    func testRecordAndReloadPreservesNewestFirst() {
        let history = AutoTaskRunHistory(storeURL: storeURL)
        let first = sampleRecord(taskId: "a", label: "First")
        let second = sampleRecord(taskId: "b", label: "Second")
        history.record(first)
        history.record(second)

        let reloaded = AutoTaskRunHistory(storeURL: storeURL)
        reloaded.bootstrap()
        let entries = reloaded.recentEntries()
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0].taskId, "b")
        XCTAssertEqual(entries[1].taskId, "a")
    }

    func testCapsAtTwoHundredRecords() {
        let history = AutoTaskRunHistory(storeURL: storeURL)
        for i in 0..<210 {
            history.record(sampleRecord(taskId: "t\(i)", label: "Task \(i)"))
        }
        XCTAssertEqual(history.recentEntries(limit: 300).count, 200)
        XCTAssertEqual(history.recentEntries().first?.taskId, "t209")
    }

    /// Regression: `record()` used to save an unseeded array when nothing had
    /// called `bootstrap()` — which is the default, since `start()` only runs
    /// with the Auto Task cron enabled. That truncated the stored history.
    func testRecordWithoutBootstrapPreservesExistingHistory() {
        let seeded = AutoTaskRunHistory(storeURL: storeURL)
        seeded.record(sampleRecord(taskId: "old", label: "Old"))

        // Fresh instance, no explicit bootstrap — exactly the cron-disabled path.
        let fresh = AutoTaskRunHistory(storeURL: storeURL)
        fresh.record(sampleRecord(taskId: "new", label: "New"))

        let reloaded = AutoTaskRunHistory(storeURL: storeURL)
        reloaded.bootstrap()
        XCTAssertEqual(reloaded.recentEntries().map(\.taskId), ["new", "old"])
    }

    func testCapIsPersistedNotJustInMemory() {
        let history = AutoTaskRunHistory(storeURL: storeURL)
        for i in 0..<210 {
            history.record(sampleRecord(taskId: "t\(i)", label: "Task \(i)"))
        }
        let reloaded = AutoTaskRunHistory(storeURL: storeURL)
        reloaded.bootstrap()
        XCTAssertEqual(reloaded.recentEntries(limit: 300).count, 200)
        XCTAssertEqual(reloaded.recentEntries().first?.taskId, "t209")
    }

    /// An unreadable file must be moved aside, not silently overwritten by the
    /// next `record()` — otherwise the evidence is destroyed with the data.
    func testCorruptFileIsQuarantinedRatherThanClobbered() throws {
        try Data("not json".utf8).write(to: storeURL)
        let history = AutoTaskRunHistory(storeURL: storeURL)
        history.bootstrap()
        XCTAssertNotNil(history.loadError)

        let quarantine = storeURL.appendingPathExtension("corrupt")
        defer { try? FileManager.default.removeItem(at: quarantine) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: quarantine.path))
        XCTAssertEqual(try String(contentsOf: quarantine, encoding: .utf8), "not json")
    }

    private func sampleRecord(taskId: String, label: String) -> AutoTaskRunRecord {
        let now = Date()
        return AutoTaskRunRecord(
            id: UUID().uuidString,
            taskId: taskId,
            taskLabel: label,
            trigger: .manual,
            startedAt: now.addingTimeInterval(-5),
            finishedAt: now,
            status: .success,
            summary: nil,
            logFileName: "auto-task-\(taskId).log",
            projectId: nil
        )
    }
}
