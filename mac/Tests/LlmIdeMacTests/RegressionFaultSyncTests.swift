import XCTest
@testable import LlmIdeMacLib

final class RegressionFaultSyncTests: XCTestCase {
    func testCreatesDedupesAndFixes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let sync = RegressionFaultSync(gitRoot: root)
        let xroot = TestRoot(packageDir: "", testDir: "Tests/T", runner: .xctest, command: "swift test", namingRule: "", languages: ["swift"])
        let first = try sync.apply(diff: .init(newFailures: ["T.FooTests/testBar"], stillFailing: [], fixed: []), root: xroot, suiteCommand: "swift test", gitHead: "abc", appVersion: "1")
        XCTAssertEqual(first.created, ["T.FooTests/testBar"])
        let faults = MemoryStore().listFaults(at: root)
        XCTAssertEqual(faults.count, 1)
        let f = try MemoryStore().loadFault(at: faults[0])
        XCTAssertEqual(f.verify, "swift test --filter 'FooTests/testBar'"); XCTAssertTrue(f.tags.contains("test:T.FooTests/testBar")); XCTAssertEqual(f.status, .open)
        let again = try sync.apply(diff: .init(newFailures: ["T.FooTests/testBar"], stillFailing: [], fixed: []), root: xroot, suiteCommand: "swift test", gitHead: nil, appVersion: "1")
        XCTAssertEqual(again.skippedExisting, ["T.FooTests/testBar"]); XCTAssertEqual(MemoryStore().listFaults(at: root).count, 1)
        let fixed = try sync.apply(diff: .init(newFailures: [], stillFailing: [], fixed: ["T.FooTests/testBar"]), root: xroot, suiteCommand: "swift test", gitHead: nil, appVersion: "1")
        XCTAssertEqual(fixed.markedFixed, ["T.FooTests/testBar"])
        XCTAssertEqual(try MemoryStore().loadFault(at: MemoryStore().listFaults(at: root)[0]).status, .fixed)
    }
}
