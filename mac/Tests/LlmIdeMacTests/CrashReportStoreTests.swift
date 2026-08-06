import XCTest
@testable import LlmIdeMacLib

@MainActor
final class CrashReportStoreTests: XCTestCase {
    var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("crash-report-store-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    private func writeCrashFile(_ name: String, text: String = "crash text") {
        try? text.write(to: root.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    func testScanWithNoDirectoryYieldsEmpty() {
        let missing = root.appendingPathComponent("does-not-exist")
        let store = CrashReportStore(directory: missing)
        store.scanForPendingCrashes()
        XCTAssertEqual(store.pendingCrashes, [])
    }

    func testScanFindsLogFiles() {
        writeCrashFile("crash-1.log")
        writeCrashFile("crash-2.log")
        writeCrashFile("not-a-crash.txt")

        let store = CrashReportStore(directory: root)
        store.scanForPendingCrashes()

        XCTAssertEqual(store.pendingCrashes.count, 2)
        XCTAssertTrue(store.pendingCrashes.allSatisfy { $0.url.pathExtension == "log" })
    }

    func testScanCapsAtFiveNewestAndDeletesOlder() {
        for i in 0..<8 {
            writeCrashFile("crash-\(i).log")
            // Ensure distinct modification times so newest-5 selection is deterministic.
            let url = root.appendingPathComponent("crash-\(i).log")
            try? FileManager.default.setAttributes(
                [.modificationDate: Date().addingTimeInterval(TimeInterval(i))],
                ofItemAtPath: url.path)
        }

        let store = CrashReportStore(directory: root)
        store.scanForPendingCrashes()

        XCTAssertEqual(store.pendingCrashes.count, 5)
        // The 3 oldest (crash-0, crash-1, crash-2) should have been deleted from disk.
        for i in 0..<3 {
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: root.appendingPathComponent("crash-\(i).log").path))
        }
        for i in 3..<8 {
            XCTAssertTrue(FileManager.default.fileExists(
                atPath: root.appendingPathComponent("crash-\(i).log").path))
        }
    }

    func testContentsReturnsFileText() {
        writeCrashFile("crash-1.log", text: "Fatal signal 11")
        let store = CrashReportStore(directory: root)
        store.scanForPendingCrashes()

        let file = try! XCTUnwrap(store.pendingCrashes.first)
        XCTAssertEqual(store.contents(of: file), "Fatal signal 11")
    }

    func testDismissAllDeletesFilesAndClearsList() {
        writeCrashFile("crash-1.log")
        writeCrashFile("crash-2.log")
        let store = CrashReportStore(directory: root)
        store.scanForPendingCrashes()
        XCTAssertEqual(store.pendingCrashes.count, 2)

        store.dismissAll()

        XCTAssertEqual(store.pendingCrashes, [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }
}
