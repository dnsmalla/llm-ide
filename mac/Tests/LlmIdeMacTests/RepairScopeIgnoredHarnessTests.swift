import Foundation
import Testing
@testable import LlmIdeMacLib

/// The Loop's machine data (`system/loop/**`) must be protected without git's
/// help: in a repo whose `.gitignore` covers `system/`, `git status` never lists
/// a file under it, so a repair's `sed -i` on the test ledger would be invisible
/// to a status-based check. These tests run the real guard against such a repo.
@Suite("Repair guard: protected loop data in a git-ignored system/ tree")
struct RepairScopeIgnoredHarnessTests {

    private let globs = GitRepairScopeGuard.defaultProtectedGlobs

    /// A temp git repo with `system/` ignored, one commit, and no `system/` content tracked.
    private func ignoredSystemRepo() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ignored-harness-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try shell("git init -q && git config user.email t@example.com && git config user.name t", in: root)
        try "system/\n".write(to: root.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
        try "readme\n".write(to: root.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        try shell("git add .gitignore README.md && git commit -q -m init", in: root)
        return root
    }

    private func write(_ text: String, _ relative: String, in root: URL) throws {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func read(_ relative: String, in root: URL) throws -> String {
        try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    private func shell(_ command: String, in root: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        process.currentDirectoryURL = root
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0, "setup command failed: \(command)")
    }

    @Test("an edit to the ignored test ledger is a violation the status check alone would miss")
    func ignoredLedgerEditIsViolation() async throws {
        let root = try ignoredSystemRepo()
        defer { try? FileManager.default.removeItem(at: root) }
        try write("{\"runId\":\"real\"}", "system/loop/test/ledger.json", in: root)
        let guardUnderTest = GitRepairScopeGuard()
        let before = await guardUnderTest.snapshot(gitRoot: root, protectedGlobs: globs, scopeGlobs: [])

        try write("{\"runId\":\"forged\"}", "system/loop/test/ledger.json", in: root)

        let check = await guardUnderTest.check(since: before, gitRoot: root, protectedGlobs: globs)
        guard case .violated(let paths, _) = check else {
            Issue.record("expected .violated for an ignored ledger edit, got \(check)")
            return
        }
        #expect(paths == ["system/loop/test/ledger.json"])
    }

    @Test("a deleted or newly created protected loop file is a violation")
    func deletionAndCreationAreViolations() async throws {
        let root = try ignoredSystemRepo()
        defer { try? FileManager.default.removeItem(at: root) }
        try write("{}", "system/loop/test/TEST-MAP.json", in: root)
        let guardUnderTest = GitRepairScopeGuard()
        let before = await guardUnderTest.snapshot(gitRoot: root, protectedGlobs: globs, scopeGlobs: [])

        try FileManager.default.removeItem(at: root.appendingPathComponent("system/loop/test/TEST-MAP.json"))
        try write("{}", "system/loop/refactor/graph/after.json", in: root)

        let check = await guardUnderTest.check(since: before, gitRoot: root, protectedGlobs: globs)
        guard case .violated(let paths, _) = check else {
            Issue.record("expected .violated for a deleted and a created loop file, got \(check)")
            return
        }
        #expect(paths == ["system/loop/refactor/graph/after.json", "system/loop/test/TEST-MAP.json"])
    }

    @Test("an edit to an ignored file that is not protected stays clean")
    func unprotectedIgnoredFileIsClean() async throws {
        let root = try ignoredSystemRepo()
        defer { try? FileManager.default.removeItem(at: root) }
        try write("{}", "system/graph/graph.json", in: root)
        let guardUnderTest = GitRepairScopeGuard()
        let before = await guardUnderTest.snapshot(gitRoot: root, protectedGlobs: globs, scopeGlobs: [])

        try write("{\"changed\":true}", "system/graph/graph.json", in: root)

        let check = await guardUnderTest.check(since: before, gitRoot: root, protectedGlobs: globs)
        guard case .clean = check else {
            Issue.record("system/graph is not protected; expected .clean, got \(check)")
            return
        }
    }

    @Test("reverting a violation puts the exact pre-repair bytes back into the ignored file")
    func revertRestoresPreRepairBytes() async throws {
        let root = try ignoredSystemRepo()
        defer { try? FileManager.default.removeItem(at: root) }
        let original = "{\"runId\":\"real\",\"failing\":[\"A/testOne\"]}"
        try write(original, "system/loop/test/ledger.json", in: root)
        let guardUnderTest = GitRepairScopeGuard()
        let before = await guardUnderTest.snapshot(gitRoot: root, protectedGlobs: globs, scopeGlobs: [])
        try write("{\"runId\":\"forged\",\"failing\":[]}", "system/loop/test/ledger.json", in: root)

        let error = await guardUnderTest.revertUnlisted(paths: ["system/loop/test/ledger.json"], created: [],
                                                        before: before, gitRoot: root)

        #expect(error == nil)
        #expect(try read("system/loop/test/ledger.json", in: root) == original)
        let after = await guardUnderTest.check(since: before, gitRoot: root, protectedGlobs: globs)
        guard case .clean = after else {
            Issue.record("after the revert the tree should match the snapshot, got \(after)")
            return
        }
    }

    @Test("the harness-path predicate covers system/loop and nothing else")
    func harnessPathPredicate() {
        #expect(GitRepairScopeGuard.isIgnoredHarnessPath("system/loop/test/ledger.json"))
        #expect(GitRepairScopeGuard.isIgnoredHarnessPath("system/loop"))
        #expect(!GitRepairScopeGuard.isIgnoredHarnessPath("system/loop.json"))
        #expect(!GitRepairScopeGuard.isIgnoredHarnessPath("system/graph/graph.json"))
        #expect(!GitRepairScopeGuard.isIgnoredHarnessPath("llm-doc/loop/test/ledger.json"))
    }
}
