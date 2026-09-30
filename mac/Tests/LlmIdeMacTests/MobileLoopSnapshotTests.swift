import XCTest
@testable import LlmIdeMacLib

final class MobileLoopSnapshotTests: XCTestCase {
    func testStartedHereClearsOnlyAfterTheRunWasSeenToEnd() {
        var t = StartedHereTracker()
        t.markStarted()
        t.observe(running: false)          // queued, not active yet
        XCTAssertTrue(t.startedHere)
        t.observe(running: true)
        XCTAssertTrue(t.startedHere)
        t.observe(running: false)          // run ended
        XCTAssertFalse(t.startedHere)
    }

    func testScopedHistoryWithoutRootIsEmpty() {
        XCTAssertTrue(MobileLoopBridge.scopedHistory(root: nil, primaryId: "p", limit: 3).isEmpty)
    }

    func testLoadSnapshotWithoutProjectHasNoPrimaryAndNoHistory() {
        let snap = MobileLoopBridge.loadSnapshot(projectRoot: nil, projectId: "x", gitRoot: nil)
        XCTAssertNil(snap.primary)
        XCTAssertNil(snap.recent)
    }
}
