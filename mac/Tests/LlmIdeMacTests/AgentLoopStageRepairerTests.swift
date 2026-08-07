import XCTest
@testable import LlmIdeMacLib

final class AgentLoopStageRepairerTests: XCTestCase {
    func testPromptIncludesStageNameCommandAndFailureOutput() {
        let prompt = AgentLoopStageRepairer.buildPrompt(
            stageName: "Test",
            command: "swift test",
            failureOutput: "XCTAssertEqual failed: (\"1\") is not equal to (\"2\")",
            repoRoot: URL(fileURLWithPath: "/tmp/repo")
        )
        XCTAssertTrue(prompt.contains("\"Test\""))
        XCTAssertTrue(prompt.contains("swift test"))
        XCTAssertTrue(prompt.contains("XCTAssertEqual failed"))
        XCTAssertTrue(prompt.contains("/tmp/repo"))
        XCTAssertTrue(prompt.contains("Do not modify the stage command"))
        XCTAssertTrue(prompt.contains("weaken or delete tests"))
    }

    func testPromptOmitsCommandLineWhenNil() {
        let prompt = AgentLoopStageRepairer.buildPrompt(
            stageName: "Regression",
            command: nil,
            failureOutput: "some failure",
            repoRoot: URL(fileURLWithPath: "/tmp/repo")
        )
        XCTAssertFalse(prompt.contains("Command:"))
    }

    func testLongFailureOutputIsTruncated() {
        let huge = String(repeating: "x", count: 10_000)
        let prompt = AgentLoopStageRepairer.buildPrompt(
            stageName: "Test", command: "swift test", failureOutput: huge,
            repoRoot: URL(fileURLWithPath: "/tmp/repo")
        )
        XCTAssertLessThan(prompt.count, huge.count)
    }

    func testLongFailureOutputKeepsTailNotHead() {
        let huge = "HEAD_NOISE" + String(repeating: "x", count: 10_000) + "TAIL_ERROR"
        let prompt = AgentLoopStageRepairer.buildPrompt(
            stageName: "Test", command: "swift test", failureOutput: huge,
            repoRoot: URL(fileURLWithPath: "/tmp/repo")
        )
        XCTAssertTrue(prompt.contains("TAIL_ERROR"))
        XCTAssertFalse(prompt.contains("HEAD_NOISE"))
    }
}
