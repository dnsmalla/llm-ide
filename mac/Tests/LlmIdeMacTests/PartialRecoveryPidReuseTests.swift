import XCTest
@testable import LlmIdeMacLib

final class PartialRecoveryPidReuseTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pr-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testOwnerAliveMatchingStartTime() {
        let pid = ProcessInfo.processInfo.processIdentifier
        let st = ProcessTree.startTime(of: pid)
        XCTAssertNotNil(st)
        XCTAssertTrue(PartialRecovery.isOwnerAlive(pid: pid, startTime: st))
    }

    func testRecycledPidWithDifferentStartTimeIsNotAlive() {
        let pid = ProcessInfo.processInfo.processIdentifier
        let st = (ProcessTree.startTime(of: pid) ?? 1_000_000) &+ 5_000_000
        XCTAssertFalse(PartialRecovery.isOwnerAlive(pid: pid, startTime: st))
    }

    func testLegacyRecordWithoutStartTimeKeepsPidOnlyBehaviour() {
        let pid = ProcessInfo.processInfo.processIdentifier
        XCTAssertTrue(PartialRecovery.isOwnerAlive(pid: pid, startTime: nil))
    }

    func testScanOffersOrphanWhenPidRecycled() throws {
        let rec = PartialRecovery(notesFolder: dir)
        let pid = ProcessInfo.processInfo.processIdentifier
        let wrong = (ProcessTree.startTime(of: pid) ?? 1_000_000) &+ 5_000_000
        try rec.record(id: "a", path: dir.appendingPathComponent("a.partial.md"),
                       pid: pid, startedAt: Date(), pidStartTime: wrong)
        XCTAssertEqual(try rec.scanOrphans().map(\.id), ["a"])
    }

    func testScanHidesRecordOwnedByLiveProcess() throws {
        let rec = PartialRecovery(notesFolder: dir)
        try rec.record(id: "b", path: dir.appendingPathComponent("b.partial.md"),
                       startedAt: Date())
        XCTAssertTrue(try rec.scanOrphans().isEmpty)
    }
}
