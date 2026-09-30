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
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: true)
        XCTAssertTrue(outcome.passed)
        XCTAssertEqual(outcome.total, 0)
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
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertFalse(outcome.passed)
        XCTAssertEqual(outcome.failed, 1)
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
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertTrue(outcome.passed)
        XCTAssertEqual(outcome.unchanged, 1)
        XCTAssertEqual(outcome.total, 1)
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
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertFalse(outcome.passed)
        XCTAssertEqual(outcome.regressed, 1)
        XCTAssertEqual(outcome.total, 1)
    }

    // MARK: - Guarded repairs

    private final class CountingVerifier: FaultVerifier, @unchecked Sendable {
        var calls = 0
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            calls += 1
            return VerifyOutcome(exitCode: calls == 1 ? 1 : 0, output: "boom")
        }
    }

    private final class CountingRepairer: FaultRepairer {
        var calls = 0
        func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws -> LoopAgentResult {
            calls += 1
            return LoopAgentResult()
        }
    }

    /// A repair the guard rejects is `.repairFailed` and is NOT re-verified —
    /// a re-verify would observe the pass a rigged test bought.
    private func runGuardedCommandFault(keep: Bool) async throws -> (SweepOutcome, CountingVerifier, CountingRepairer, Int) {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("regression-sweep-guard-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        var fault = FaultReport(prompt: "p", response: "r", notes: "", severity: .info,
                                reportedAt: Date(), appVersion: "test", agent: "claude_code",
                                status: .fixed, tags: [])
        fault.verify = "make check"
        let store = MemoryStore()
        let url = try store.writeFault(at: tempDir, fault)
        let approvals = VerifyApprovalStore(
            defaults: UserDefaults(suiteName: "sweep-guard-\(UUID().uuidString)")!)
        approvals.approve(repo: tempDir, faultFile: url.lastPathComponent, command: "make check")
        let verifier = CountingVerifier()
        let repairer = CountingRepairer()
        let runner = RegressionRunner(prompter: StubPrompter(), store: store, verifier: verifier,
                                      repairer: repairer, approvals: approvals)
        var guardCalls = 0
        let outcome = await RegressionRunnerSweepAdapter(runner: runner).sweep(
            faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: true,
            repairGuard: { _, repair in
                guardCalls += 1
                try await repair()
                return keep
            })
        return (outcome, verifier, repairer, guardCalls)
    }

    func testRejectedGuardedRepairIsRepairFailedWithoutReVerify() async throws {
        let (outcome, verifier, repairer, guardCalls) = try await runGuardedCommandFault(keep: false)
        XCTAssertEqual(guardCalls, 1)
        XCTAssertEqual(repairer.calls, 1)
        XCTAssertEqual(verifier.calls, 1, "not re-verified after a rejected repair")
        XCTAssertEqual(outcome.repairFailed, 1)
        XCTAssertFalse(outcome.passed)
    }

    func testKeptGuardedRepairIsReVerified() async throws {
        let (outcome, verifier, _, guardCalls) = try await runGuardedCommandFault(keep: true)
        XCTAssertEqual(guardCalls, 1)
        XCTAssertEqual(verifier.calls, 2)
        XCTAssertEqual(outcome.repaired, 1)
        XCTAssertTrue(outcome.passed)
    }
}

