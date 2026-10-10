import XCTest
@testable import LlmIdeMacLib

final class LoopStageCodeGraphKindTests: XCTestCase {
    func testRoundTrip() throws {
        let s = LoopStage(name: "Graph", kind: .codeGraph, order: 0, isDefault: true,
                          defaultKey: "refactor-graph", graphOp: .snapshot)
        let b = try JSONDecoder().decode(LoopStage.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(b.kind, .codeGraph)
        XCTAssertEqual(b.graphOp, .snapshot)
        XCTAssertFalse(b.verifies)
        XCTAssertTrue(b.allowsRepair)
    }

    func testAllowsRepairDecodesAbsentAsTrue() throws {
        let json = #"{"id":"x","name":"T","kind":"shellCommand","command":"swift test","order":0}"#
        XCTAssertTrue(try JSONDecoder().decode(LoopStage.self, from: Data(json.utf8)).allowsRepair)
    }

    func testAllowsRepairFalseRoundTrips() throws {
        var s = LoopStage(name: "Build", kind: .shellCommand, command: "swift build", order: 0)
        s.allowsRepair = false
        let b = try JSONDecoder().decode(LoopStage.self, from: JSONEncoder().encode(s))
        XCTAssertFalse(b.allowsRepair)
    }

    func testRefactorApplyIsRecognised() {
        let apply = LoopStage(name: "Apply", kind: .skill, order: 0, skillId: "skills/refactor-apply")
        XCTAssertTrue(apply.isRefactorApply)
        let other = LoopStage(name: "Apply", kind: .skill, order: 0, skillId: "skills/test-gap-writer")
        XCTAssertFalse(other.isRefactorApply)
    }

    func testAttemptFields() throws {
        var a = LoopStageAttempt(stageId: "x", stageName: "Graph Check", kind: .codeGraph,
                                 severity: .blocking, startedAt: Date(), durationSeconds: 0,
                                 exitCode: nil, passed: true, outputTail: "",
                                 outputHash: nil, score: nil)
        a.batchId = "R2"
        a.graphDelta = ["cycleCount": -1]
        let b = try JSONDecoder().decode(LoopStageAttempt.self, from: JSONEncoder().encode(a))
        XCTAssertEqual(b.batchId, "R2")
        XCTAssertEqual(b.graphDelta?["cycleCount"], -1)
    }

    func testOutputLayoutConstants() {
        XCTAssertEqual(LoopOutputLayout.refactorDir, "llm-doc/loop/refactor")
        XCTAssertEqual(LoopOutputLayout.refactorGraphDir, "llm-doc/loop/refactor/graph")
        XCTAssertEqual(LoopOutputLayout.refactorGraphBefore, "llm-doc/loop/refactor/graph/before.json")
        XCTAssertEqual(LoopOutputLayout.refactorGraphAfter, "llm-doc/loop/refactor/graph/after.json")
        XCTAssertEqual(LoopOutputLayout.refactorGraphMD, "llm-doc/loop/refactor/GRAPH.md")
        XCTAssertEqual(LoopOutputLayout.refactorGraphDelta, "llm-doc/loop/refactor/GRAPH-DELTA.md")
    }
}
