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
        var timeouts: [TimeInterval] = []
        /// Simulated slow verify (seconds) — lets a deadline pass mid-sweep.
        var delay: TimeInterval = 0
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            calls += 1
            timeouts.append(timeout)
            if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            return VerifyOutcome(exitCode: calls == 1 ? 1 : 0, output: "boom")
        }
    }

    private final class CountingRepairer: FaultRepairer {
        var calls = 0
        func repair(fault: FaultReport, failureOutput: String, repoRoot: URL,
                    timeout: TimeInterval?) async throws -> LoopAgentResult {
            calls += 1
            return LoopAgentResult()
        }
    }

    /// A repair the guard rejects is `.repairFailed` and is NOT re-verified —
    /// a re-verify would observe the pass a rigged test bought.
    /// `keep == nil` sweeps with NO guard at all.
    private func runGuardedCommandFault(keep: Bool?, deadline: Date? = nil,
                                        verifyDelay: TimeInterval = 0) async throws -> (SweepOutcome, CountingVerifier, CountingRepairer, Int) {
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
        verifier.delay = verifyDelay
        let repairer = CountingRepairer()
        let runner = RegressionRunner(prompter: StubPrompter(), store: store, verifier: verifier,
                                      repairer: repairer, approvals: approvals)
        var guardCalls = 0
        var repairGuard: FaultRepairGuard?
        if let keep {
            repairGuard = { _, repair in
                guardCalls += 1
                _ = try await repair(nil)
                return keep
            }
        }
        let outcome = await RegressionRunnerSweepAdapter(runner: runner).sweep(
            faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: true, repairGuard: repairGuard,
            deadline: deadline)
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

    /// No guard, no repair: an unguarded agent edit could rewrite the test it
    /// is meant to satisfy, so the fault is left regressed and flagged.
    func testRepairWithoutAGuardIsSkippedNotRun() async throws {
        let (outcome, verifier, repairer, _) = try await runGuardedCommandFault(keep: nil)
        XCTAssertEqual(repairer.calls, 0, "never repaired unguarded")
        XCTAssertEqual(verifier.calls, 1)
        XCTAssertEqual(outcome.regressed, 1)
        XCTAssertFalse(outcome.passed)
    }

    // MARK: - Run time budget (deadline)

    func testVerifyTimeoutIsClampedToTheRemainingBudget() async throws {
        let (_, verifier, _, _) = try await runGuardedCommandFault(
            keep: true, deadline: Date().addingTimeInterval(100))
        XCTAssertFalse(verifier.timeouts.isEmpty)
        XCTAssertTrue(verifier.timeouts.allSatisfy { $0 > 0 && $0 <= 100 }, "\(verifier.timeouts)")
    }

    func testExhaustedBudgetChecksNothingAndRecordsWhy() async throws {
        let (outcome, verifier, repairer, _) = try await runGuardedCommandFault(
            keep: true, deadline: Date().addingTimeInterval(-1))
        XCTAssertEqual(verifier.calls, 0)
        XCTAssertEqual(repairer.calls, 0)
        XCTAssertEqual(outcome.failed, 1, "unchecked fault = failed, never a silent pass")
        XCTAssertFalse(outcome.passed)
    }

    func testBudgetSpentDuringVerifySkipsTheRepair() async throws {
        let (outcome, verifier, repairer, guardCalls) = try await runGuardedCommandFault(
            keep: true, deadline: Date().addingTimeInterval(0.05), verifyDelay: 0.15)
        XCTAssertEqual(verifier.calls, 1)
        XCTAssertEqual(guardCalls, 0)
        XCTAssertEqual(repairer.calls, 0, "no repair once the budget is gone")
        XCTAssertEqual(outcome.regressed, 1)
        XCTAssertFalse(outcome.passed)
    }

    // MARK: - ProtectedPathRepairGuard (the Auto Task sweep's guard)

    private final class ScriptedScopeGuard: RepairScopeGuarding {
        var check: RepairScopeCheck
        private(set) var reverted: [String] = []
        private(set) var revertedUnlisted: [String] = []
        init(_ check: RepairScopeCheck) { self.check = check }
        func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot {
            RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil)
        }
        func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
                   protectedGlobs: [String]) async -> RepairScopeCheck { check }
        func revert(paths: [String], gitRoot: URL) async -> String? { reverted += paths; return nil }
        func revertUnlisted(paths: [String], created: Set<String>, gitRoot: URL) async -> String? {
            revertedUnlisted += paths; return nil
        }
    }

    private func runProtectedGuard(_ scope: ScriptedScopeGuard,
                                   result: LoopAgentResult = LoopAgentResult()) async throws -> Bool {
        let repairGuard = ProtectedPathRepairGuard.make(scopeGuard: scope)
        return try await repairGuard(URL(fileURLWithPath: "/tmp/r")) { _ in result }
    }

    func testProtectedGuardKeepsACleanRepair() async throws {
        let scope = ScriptedScopeGuard(.clean(changedPaths: ["src/a.swift"]))
        let kept = try await runProtectedGuard(scope)
        XCTAssertTrue(kept)
        XCTAssertEqual(scope.reverted, [])
    }

    func testProtectedGuardRevertsAndRejectsATestEdit() async throws {
        let scope = ScriptedScopeGuard(.violated(paths: ["Tests/ATests.swift"],
                                                 allChangedPaths: ["Tests/ATests.swift", "src/a.swift"]))
        let kept = try await runProtectedGuard(scope)
        XCTAssertFalse(kept)
        XCTAssertEqual(scope.reverted, ["Tests/ATests.swift"])
    }

    func testProtectedGuardSeesAnIgnoredProtectedWriteTheAgentReported() async throws {
        let scope = ScriptedScopeGuard(.clean(changedPaths: []))
        let kept = try await runProtectedGuard(scope, result: LoopAgentResult(changedPaths: ["tests/snap.json"]))
        XCTAssertFalse(kept)
        XCTAssertEqual(scope.revertedUnlisted, ["tests/snap.json"])
    }
}
