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

final class CommandCandidateRankingTests: XCTestCase {
    func testRankingMatchesDetectionAndIsPure() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rank-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "// swift-tools-version:5.9".write(to: dir.appendingPathComponent("Package.swift"), atomically: true, encoding: .utf8)
        let base = LoopStageDetector.detectCommandCandidates(gitRoot: dir)
        XCTAssertFalse(base.isEmpty)
        // Detect once, rank per stage name: same answer as detecting per name.
        for name in ["", "build", "Test"] {
            XCTAssertEqual(LoopStageDetector.rankCandidates(base, stageName: name).map(\.command),
                           LoopStageDetector.detectCommandCandidates(gitRoot: dir, stageName: name).map(\.command))
        }
        XCTAssertEqual(LoopStageDetector.rankCandidates(base, stageName: "build").first?.command, "swift build")
    }
}
