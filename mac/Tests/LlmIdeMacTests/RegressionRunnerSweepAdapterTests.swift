import XCTest
@testable import LlmIdeMacLib

@MainActor
final class RegressionRunnerSweepAdapterTests: XCTestCase {
    private final class StubPrompter: RegressionPrompter {
        func ask(prompt: String) async throws -> String { prompt }
    }

    /// Simulates a CLI/network error mid-sweep — the `.failed(String)`
    /// verdict path in `RegressionRunner.runAnswerCompareFault`, which
    /// catches whatever `prompter.ask` throws.
    private final class ThrowingPrompter: RegressionPrompter {
        struct BoomError: Error {}
        func ask(prompt: String) async throws -> String { throw BoomError() }
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

    /// A fault that can't even be checked (prompter throws) must NOT
    /// read as a pass — fail-closed, matching `VerifyApprovalStore`'s
    /// stance elsewhere: ambiguity blocks, it never silently succeeds.
    func testSweepPassedFalseWhenAFaultCouldNotBeChecked() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("regression-sweep-adapter-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // No `verify` command → runner takes the answer-compare path,
        // where `prompter.ask` throwing surfaces as `.failed`.
        let fault = FaultReport(
            prompt: "does X still work?",
            response: "yes",
            notes: "",
            severity: .info,
            reportedAt: Date(),
            appVersion: "test",
            agent: "claude_code",
            status: .fixed,
            tags: []
        )
        let store = MemoryStore()
        try store.writeFault(at: tempDir, fault)

        let runner = RegressionRunner(prompter: ThrowingPrompter(), store: store)
        let adapter = RegressionRunnerSweepAdapter(runner: runner)
        let passed = await adapter.sweepPassed(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertFalse(passed)
    }

    /// Non-vacuous positive case: a fault that actually gets checked and
    /// lands on `.unchanged` (fresh answer matches the saved one). The
    /// no-fixed-faults test above passes trivially on an empty result
    /// set; this one proves a real verdict flows through as a pass.
    func testSweepPassedTrueForAnActualUnchangedVerdict() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("regression-sweep-adapter-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // StubPrompter echoes the prompt back; giving the fault a
        // `response` identical to its `prompt` makes the fresh reply
        // match the saved answer exactly → `.unchanged`.
        let text = "does X still work?"
        let fault = FaultReport(
            prompt: text,
            response: text,
            notes: "",
            severity: .info,
            reportedAt: Date(),
            appVersion: "test",
            agent: "claude_code",
            status: .fixed,
            tags: []
        )
        let store = MemoryStore()
        try store.writeFault(at: tempDir, fault)

        let runner = RegressionRunner(prompter: StubPrompter(), store: store)
        let adapter = RegressionRunnerSweepAdapter(runner: runner)
        let passed = await adapter.sweepPassed(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertTrue(passed)
    }

    /// Mirror case: a fresh answer that no longer matches the saved one
    /// lands on `.regressed` (no judge configured, so no semantic
    /// second chance) and must report as not-passed.
    func testSweepPassedFalseForARegressedVerdict() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("regression-sweep-adapter-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // StubPrompter echoes the prompt, which differs from the saved
        // `response` below → exact-match verdict comes back `.regressed`.
        let fault = FaultReport(
            prompt: "does X still work?",
            response: "yes, it does",
            notes: "",
            severity: .info,
            reportedAt: Date(),
            appVersion: "test",
            agent: "claude_code",
            status: .fixed,
            tags: []
        )
        let store = MemoryStore()
        try store.writeFault(at: tempDir, fault)

        let runner = RegressionRunner(prompter: StubPrompter(), store: store)
        let adapter = RegressionRunnerSweepAdapter(runner: runner)
        let passed = await adapter.sweepPassed(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertFalse(passed)
    }
}
