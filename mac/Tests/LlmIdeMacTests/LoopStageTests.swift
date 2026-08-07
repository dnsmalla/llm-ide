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
}
