import XCTest
@testable import LlmIdeMacLib

@MainActor
final class RegressionRunnerSweepAdapterTests: XCTestCase {
    private final class StubPrompter: RegressionPrompter {
        func ask(prompt: String) async throws -> String { prompt }
    }

    func testSweepPassedTrueWhenNoFixedFaultsExist() async {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("regression-sweep-adapter-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let runner = RegressionRunner(prompter: StubPrompter())
        let adapter = RegressionRunnerSweepAdapter(runner: runner)
        let passed = await adapter.sweepPassed(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: true)
        XCTAssertTrue(passed)
    }
}
