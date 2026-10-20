import Foundation
import LlmIdeMacLib

// Mikado rollback primitives (design doc §3.5): `RefactorPlanDiff.markingBlocked`
// rewrites a batch header to `(status: blocked)` and the `RepairScopeGuarding`
// tree-restore puts the working tree back to a `snapshotTree` point without
// ever touching the index. The restore check needs a REAL git repository —
// the index-safety claim ("`git restore --worktree` never touches the
// index") is exactly what a scripted/fake verifier cannot prove.

#if FEATURE_AUTOTASK
func runRefactorRollbackChecks() async {
    print("refactor rollback (Mikado) primitives")

    // MARK: - markingBlocked

    let plan = """
    ### R1 Split Big  (status: todo)
    - Files: `Sources/Big.swift`
    - Expect: filesOver500Count 3 → 2
    ### R2 Break cycle  (status: todo)
    - Files: `a.mjs`
    - Expect: cycleCount 1 → 0
    ### R3 Rename thing  (status: todo)
    - Files: `b.mjs`
    - Expect: none
    """

    let blocked = RefactorPlanDiff.markingBlocked(plan, id: "R2", reason: "Refactor Test — test_cycle failed")
    expect(blocked.contains("### R2 Break cycle  (status: blocked)"),
           "markingBlocked rewrites R2's header status to blocked")
    expect(blocked.contains("- Blocked: Refactor Test — test_cycle failed"),
           "markingBlocked inserts a Blocked: reason line")
    guard let r2Section = RefactorPlanDiff.section(of: "R2", in: blocked) else {
        expect(false, "R2 section still parses after being marked blocked")
        return
    }
    expect(r2Section.components(separatedBy: "\n")[1] == "- Blocked: Refactor Test — test_cycle failed",
           "the Blocked: line sits directly under R2's header")
    expect(RefactorPlanDiff.section(of: "R1", in: blocked) == RefactorPlanDiff.section(of: "R1", in: plan),
           "R1's section is byte-identical after R2 is marked blocked")
    expect(RefactorPlanDiff.section(of: "R3", in: blocked) == RefactorPlanDiff.section(of: "R3", in: plan),
           "R3's section is byte-identical after R2 is marked blocked")

    let blockedTwice = RefactorPlanDiff.markingBlocked(blocked, id: "R2", reason: "second reason")
    let occurrences = blockedTwice.components(separatedBy: "- Blocked:").count - 1
    expect(occurrences == 1, "marking an already-blocked batch again leaves exactly one Blocked: line")
    expect(blockedTwice.contains("- Blocked: second reason"), "the second call's reason replaces the first")

    expect(RefactorPlanDiff.markingBlocked(plan, id: "R9", reason: "x") == plan,
           "marking an unknown batch id leaves the plan unchanged")

    // MARK: - restore (real git repo)

    func git(_ args: [String], _ dir: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-c", "user.name=lab", "-c", "user.email=lab@example.invalid"] + args
        p.currentDirectoryURL = dir
        p.standardOutput = Pipe(); p.standardError = Pipe()
        try? p.run(); p.waitUntilExit()
    }
    func gitOutput(_ args: [String], _ dir: URL) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-c", "user.name=lab", "-c", "user.email=lab@example.invalid"] + args
        p.currentDirectoryURL = dir
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        try? p.run(); p.waitUntilExit()
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    let root = makeTempDir()
    defer { try? FileManager.default.removeItem(at: root) }
    git(["init", "-q"], root)
    try? "a1\n".write(to: root.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try? "b1\n".write(to: root.appendingPathComponent("b.txt"), atomically: true, encoding: .utf8)
    git(["add", "."], root)
    git(["commit", "-qm", "init"], root)
    // The user's own uncommitted edit, present before the batch base is taken —
    // it belongs to `batchBaseTree` and must survive a rollback untouched.
    try? "u0\n".write(to: root.appendingPathComponent("u.txt"), atomically: true, encoding: .utf8)

    let guardUnderTest = GitRepairScopeGuard()
    guard let base = await guardUnderTest.snapshotTree(gitRoot: root) else {
        expect(false, "snapshotTree produced a base tree id")
        return
    }

    // The "batch": edits a.txt, creates n.txt, deletes b.txt, edits u.txt again.
    try? "a2\n".write(to: root.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try? "n1\n".write(to: root.appendingPathComponent("n.txt"), atomically: true, encoding: .utf8)
    try? FileManager.default.removeItem(at: root.appendingPathComponent("b.txt"))
    try? "u1\n".write(to: root.appendingPathComponent("u.txt"), atomically: true, encoding: .utf8)

    let restoreError = await guardUnderTest.restore(
        paths: ["a.txt", "n.txt", "b.txt"], fromTree: base, gitRoot: root)
    expect(restoreError == nil, "restore reports no error, got \(restoreError ?? "nil")")

    let a = try? String(contentsOf: root.appendingPathComponent("a.txt"), encoding: .utf8)
    let b = try? String(contentsOf: root.appendingPathComponent("b.txt"), encoding: .utf8)
    let n = FileManager.default.fileExists(atPath: root.appendingPathComponent("n.txt").path)
    let u = try? String(contentsOf: root.appendingPathComponent("u.txt"), encoding: .utf8)
    expect(a == "a1\n", "restore puts a.txt back to its base-tree content")
    expect(b == "b1\n", "restore recreates b.txt, deleted since the base, from the base tree")
    expect(!n, "restore deletes n.txt, which the base tree never had")
    expect(u == "u1\n", "restore leaves u.txt (not in the restore list) at its second edit")

    // Index-safety: `--worktree` never staged anything, so the index still
    // matches HEAD exactly — `git diff --cached` is empty.
    let staged = gitOutput(["diff", "--cached"], root)
    expect(staged.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           "restore never touches the index — git diff --cached is empty")

    // Empty path list is a no-op (mirrors `revert`'s contract).
    let noop = await guardUnderTest.restore(paths: [], fromTree: base, gitRoot: root)
    expect(noop == nil, "restore with no paths is a no-op")

    // The `RepairScopeGuarding` default (a guard that cannot run git) and
    // index-safety of the default protocol extension are internal-only
    // concerns (the protocol itself is not `public`) and are asserted by
    // `RepairScopeGuardTests` via `@testable import` instead.
}
#endif
