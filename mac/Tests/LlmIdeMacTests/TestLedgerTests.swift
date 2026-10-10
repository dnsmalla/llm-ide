import XCTest
@testable import LlmIdeMacLib

final class TestLedgerTests: XCTestCase {
    func testDiff() {
        let prev = TestLedger(runId: "1", recordedAt: Date(), failing: ["A/t1", "A/t2"], passing: ["A/t3"])
        let d = TestLedger.diff(previous: prev, currentFailing: ["A/t2", "B/t9"], currentPassing: ["A/t1", "A/t3"])
        XCTAssertEqual(d.newFailures, ["B/t9"]); XCTAssertEqual(d.stillFailing, ["A/t2"]); XCTAssertEqual(d.fixed, ["A/t1"])
        XCTAssertEqual(TestLedger.diff(previous: nil, currentFailing: ["X/y"], currentPassing: []).newFailures, ["X/y"])
    }
    func testRoundTrip() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try TestLedger(runId: "r", recordedAt: Date(), failing: ["a"], passing: []).write(gitRoot: root)
        XCTAssertEqual(TestLedger.load(gitRoot: root)?.failing, ["a"])
    }
}
