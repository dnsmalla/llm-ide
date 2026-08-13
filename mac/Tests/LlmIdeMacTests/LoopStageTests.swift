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
