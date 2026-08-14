import XCTest
@testable import LlmIdeMacLib

final class LoopStageTests: XCTestCase {
    func testRegressionSweepStageRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
    }

    func testShellCommandStageRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertEqual(decoded.command, "swift test")
    }

    func testSkillStageRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "s1", name: "Fix Skill", kind: .skill,
                              command: nil, order: 2,
                              skillId: "skills/fix-code", targetPath: "~/src/App.swift",
                              prompt: "Fix the bug")
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertEqual(decoded.skillId, "skills/fix-code")
        XCTAssertEqual(decoded.targetPath, "~/src/App.swift")
        XCTAssertEqual(decoded.prompt, "Fix the bug")
    }

    func testIsDefaultRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0, isDefault: true)
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertTrue(decoded.isDefault)
    }

    func testOldPayloadWithoutIsDefaultDecodesFalse() throws {
        // A stage saved before isDefault existed must decode as a normal, deletable stage.
        let json = """
        {"id":"t1","name":"Test","kind":"shellCommand","command":"swift test","order":1,
         "skillId":null,"targetPath":null,"prompt":null}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LoopStage.self, from: json)
        XCTAssertEqual(decoded.isDefault, false)
    }

    func testOutputPathRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "s2", name: "Write docs", kind: .skill,
                              command: nil, order: 0,
                              skillId: "skills/write-docs", targetPath: "src/payments",
                              outputPath: "docs/payments.md", prompt: "Document this module")
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertEqual(decoded.outputPath, "docs/payments.md")
    }

    func testOldPayloadWithoutEnabledDecodesTrue() throws {
        // A stage saved before `enabled` existed must decode as enabled —
        // anything else would silently switch off stages in every existing
        // config the first time it is loaded by a build with this field.
        let json = """
        {"id":"t1","name":"Test","kind":"shellCommand","command":"swift test","order":1}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LoopStage.self, from: json)
        XCTAssertTrue(decoded.enabled)
    }

    func testOldPayloadWithoutDefaultKeyDecodesNil() throws {
        let json = """
        {"id":"t1","name":"Test","kind":"shellCommand","command":"swift test","order":1}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LoopStage.self, from: json)
        XCTAssertNil(decoded.defaultKey)
    }

    func testDefaultKeyRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "s1", name: "Skills", kind: .shellCommand,
                              command: "cmd", order: 1, defaultKey: "skills")
        let decoded = try JSONDecoder().decode(LoopStage.self, from: JSONEncoder().encode(stage))
        XCTAssertEqual(decoded, stage)
        XCTAssertEqual(decoded.defaultKey, "skills")
    }

    func testEnabledFalseRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "t1", name: "Test", kind: .shellCommand,
                              command: "swift test", order: 1, enabled: false)
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertFalse(decoded.enabled)
    }

    // MARK: - Reorder helpers

    private func stage(_ id: String, order: Int) -> LoopStage {
        LoopStage(id: id, name: id, kind: .shellCommand, command: "true", order: order)
    }

    func testMovingUpSwapsWithPredecessorAndRenumbers() {
        let stages = [stage("a", order: 0), stage("b", order: 1), stage("c", order: 2)]
        let moved = LoopStage.moving(stages, id: "c", by: -1)
        XCTAssertEqual(LoopStage.runOrder(moved).map(\.id), ["a", "c", "b"])
        // Every order value is renumbered to its final position, not swapped —
        // so later moves can't be confused by colliding or gapped orders.
        XCTAssertEqual(LoopStage.runOrder(moved).map(\.order), [0, 1, 2])
    }

    func testMovingDownSwapsWithSuccessor() {
        let stages = [stage("a", order: 0), stage("b", order: 1), stage("c", order: 2)]
        let moved = LoopStage.moving(stages, id: "a", by: 1)
        XCTAssertEqual(LoopStage.runOrder(moved).map(\.id), ["b", "a", "c"])
    }

    func testMovingOffEitherEndIsANoOp() {
        let stages = [stage("a", order: 0), stage("b", order: 1)]
        XCTAssertEqual(LoopStage.moving(stages, id: "a", by: -1), stages)
        XCTAssertEqual(LoopStage.moving(stages, id: "b", by: 1), stages)
        XCTAssertEqual(LoopStage.moving(stages, id: "missing", by: 1), stages)
    }

    func testMovingResolvesCollidingOrderValues() {
        // Two stages with the same `order` (possible after remove + add) —
        // the id tie-break defines their run order, and a move must renumber
        // both so the result is unambiguous.
        let stages = [stage("b", order: 0), stage("a", order: 0)]
        XCTAssertEqual(LoopStage.runOrder(stages).map(\.id), ["a", "b"])
        let moved = LoopStage.moving(stages, id: "b", by: -1)
        XCTAssertEqual(LoopStage.runOrder(moved).map(\.id), ["b", "a"])
        XCTAssertEqual(LoopStage.runOrder(moved).map(\.order), [0, 1])
    }

    func testOldPayloadWithoutOutputPathDecodesNil() throws {
        // A stage saved before outputPath existed must decode with no output set,
        // not fail to decode (same rule as isDefault above).
        let json = """
        {"id":"s1","name":"Fix Skill","kind":"skill","command":null,"order":2,
         "skillId":"skills/fix-code","targetPath":"~/src/App.swift","prompt":"Fix the bug"}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LoopStage.self, from: json)
        XCTAssertNil(decoded.outputPath)
        XCTAssertEqual(decoded.targetPath, "~/src/App.swift")
    }
}
