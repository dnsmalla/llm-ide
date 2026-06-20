import Testing
import Foundation
@testable import LlmIdeMac

/// End-to-end integration of the regression pipeline against a REAL git
/// repo, the REAL ShellFaultVerifier (actual subprocesses), and the REAL
/// MemoryStore — only the agent repair step is a local stand-in (it edits
/// a file, which is exactly what the production repairer's agent would do).
///
/// This is the automatable substitute for the manual UI smoke: it proves
/// verify → fail → repair → re-verify → repaired-paths/diff all work with
/// real commands and real files, not fakes.
@MainActor
struct RegressionPipelineIntegrationTests {
    /// A repairer that "fixes the code" by writing the marker file —
    /// the real agent would edit source; the verify command is identical.
    final class FileWritingRepairer: FaultRepairer {
        let target: URL
        let contents: String
        init(target: URL, contents: String) { self.target = target; self.contents = contents }
        func repair(fault: FaultReport, failureOutput: String, repoRoot: URL) async throws {
            try contents.write(to: target, atomically: true, encoding: .utf8)
        }
    }

    private func git(_ args: [String], at repo: URL) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", repo.path] + args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        try p.run(); p.waitUntilExit()
    }

    /// A committed git repo with `marker.txt` = `initial`.
    private func makeRepo(marker: String) throws -> URL {
        let repo = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("regr-int-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try git(["init", "-q"], at: repo)
        try git(["config", "user.email", "t@t.t"], at: repo)
        try git(["config", "user.name", "t"], at: repo)
        try marker.write(to: repo.appendingPathComponent("marker.txt"), atomically: true, encoding: .utf8)
        try git(["add", "."], at: repo)
        try git(["commit", "-q", "-m", "init"], at: repo)
        return repo
    }

    private func writeFixedFault(_ store: MemoryStore, at repo: URL, verify: String) throws -> URL {
        try store.writeFault(at: repo, FaultReport(
            prompt: "marker must contain FIXED", response: "ensure marker.txt says FIXED",
            notes: "", severity: .major, reportedAt: Date(timeIntervalSince1970: 1_716_465_600),
            gitHead: nil, appVersion: "0.1", agent: "claude_code", status: .fixed, tags: [],
            verify: verify, verifyKind: .command))
    }

    private func approvals(approving command: String, repo: URL, file: String) -> VerifyApprovalStore {
        let s = VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        s.approve(repo: repo, faultFile: file, command: command)
        return s
    }

    final class NoPrompter: RegressionPrompter {
        func ask(prompt: String) async throws -> String { "" }
    }

    private let cmd = "grep -q FIXED marker.txt"

    @Test func realVerifyPassesWhenMarkerIsFixed() async throws {
        let repo = try makeRepo(marker: "FIXED\n")
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFixedFault(store, at: repo, verify: cmd)
        let appr = approvals(approving: cmd, repo: repo, file: url.lastPathComponent)
        let runner = RegressionRunner(prompter: NoPrompter(), store: store,
                                      verifier: ShellFaultVerifier(), approvals: appr)
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .unchanged)
    }

    @Test func realVerifyFailsAndRepairFixesIt() async throws {
        let repo = try makeRepo(marker: "BROKEN\n")
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFixedFault(store, at: repo, verify: cmd)
        let appr = approvals(approving: cmd, repo: repo, file: url.lastPathComponent)
        let repairer = FileWritingRepairer(target: repo.appendingPathComponent("marker.txt"),
                                           contents: "FIXED\n")
        let runner = RegressionRunner(prompter: NoPrompter(), store: store,
                                      verifier: ShellFaultVerifier(), repairer: repairer, approvals: appr)
        await runner.run(at: repo, attemptRepair: true)

        #expect(runner.results.first?.verdict == .repaired)
        // The repair touched marker.txt and the real re-verify passed.
        #expect(runner.results.first?.repairedPaths.contains("marker.txt") == true)
        let after = try String(contentsOf: repo.appendingPathComponent("marker.txt"), encoding: .utf8)
        #expect(after.contains("FIXED"))
    }

    @Test func realVerifyFailsAndRepairOffMarksRegressed() async throws {
        let repo = try makeRepo(marker: "BROKEN\n")
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        let url = try writeFixedFault(store, at: repo, verify: cmd)
        let appr = approvals(approving: cmd, repo: repo, file: url.lastPathComponent)
        let runner = RegressionRunner(prompter: NoPrompter(), store: store,
                                      verifier: ShellFaultVerifier(), approvals: appr)
        await runner.run(at: repo, attemptRepair: false)
        #expect(runner.results.first?.verdict == .regressed)
    }

    @Test func unapprovedCommandIsGatedBeforeAnySubprocessRuns() async throws {
        let repo = try makeRepo(marker: "BROKEN\n")
        defer { try? FileManager.default.removeItem(at: repo) }
        let store = MemoryStore()
        _ = try writeFixedFault(store, at: repo, verify: cmd)
        // Empty approval store → command is not approved.
        let appr = VerifyApprovalStore(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        let runner = RegressionRunner(prompter: NoPrompter(), store: store,
                                      verifier: ShellFaultVerifier(), approvals: appr)
        await runner.run(at: repo, attemptRepair: true)
        #expect(runner.results.first?.verdict == .needsApproval)
    }
}
