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
}
