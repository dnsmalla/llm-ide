import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct RegressionPipelineTests {
    final class FakePrompter: RegressionPrompter {
        var replies: [String: String] = [:]
        func ask(prompt: String) async throws -> String { replies[prompt] ?? "" }
    }
    final class FakeVerifier: FaultVerifier, @unchecked Sendable {
        var outcomes: [VerifyOutcome] = []
        var calls = 0
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            defer { calls += 1 }
            return calls < outcomes.count ? outcomes[calls] : VerifyOutcome(exitCode: 0, output: "")
        }
    }
    final class FakeRepairer: FaultRepairer {
        var repaired = false
        func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws { repaired = true }
    }

    private func tmpRepo() throws -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pipe-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
    private func writeFault(_ store: MemoryStore, at repo: URL, prompt: String,
                            response: String, verify: String?) throws -> URL {
        try store.writeFault(at: repo, FaultReport(
            prompt: prompt, response: response, notes: "", severity: .major,
            reportedAt: Date(timeIntervalSince1970: 1_716_465_600), gitHead: nil,
            appVersion: "0.1", agent: "claude_code", status: .fixed, tags: [],
            verify: verify, verifyKind: verify == nil ? nil : .command))
    }
    private func approvals() -> VerifyApprovalStore {
        VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    }

    @Test func verifyPassMarksUnchanged() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "ok-cmd")
        let verifier = FakeVerifier(); verifier.outcomes = [VerifyOutcome(exitCode: 0, output: "")]
        let appr = approvals()
        appr.approve(repo: repo, faultFile: url.lastPathComponent, command: "ok-cmd")
        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: verifier, approvals: appr)
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .unchanged)
    }

    @Test func unapprovedCommandNeedsApproval() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "ok-cmd")
        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: FakeVerifier(), approvals: approvals())
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .needsApproval)
    }

    @Test func verifyFailThenRepairFixesMarksRepaired() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "c")
        let verifier = FakeVerifier()
        verifier.outcomes = [VerifyOutcome(exitCode: 1, output: "boom"),
                             VerifyOutcome(exitCode: 0, output: "")]
        let appr = approvals(); appr.approve(repo: repo, faultFile: url.lastPathComponent, command: "c")
        let repairer = FakeRepairer()
        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: verifier, repairer: repairer, approvals: appr)
        await runner.run(at: repo, attemptRepair: true)
        #expect(repairer.repaired)
        #expect(runner.results.first?.verdict == .repaired)
    }

    @Test func verifyFailRepairOffMarksRegressed() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFault(store, at: repo, prompt: "q", response: "a", verify: "c")
        let verifier = FakeVerifier(); verifier.outcomes = [VerifyOutcome(exitCode: 1, output: "x")]
        let appr = approvals(); appr.approve(repo: repo, faultFile: url.lastPathComponent, command: "c")
        let runner = RegressionRunner(prompter: FakePrompter(), store: store,
                                      verifier: verifier, approvals: appr)
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .regressed)
    }

    @Test func commandlessFaultUsesAnswerCompareFallback() async throws {
        let repo = try tmpRepo(); defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFault(store, at: repo, prompt: "q", response: "same", verify: nil)
        let prompter = FakePrompter(); prompter.replies["q"] = "same"
        let runner = RegressionRunner(prompter: prompter, store: store,
                                      verifier: FakeVerifier(), approvals: approvals())
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .unchanged)
    }
}
