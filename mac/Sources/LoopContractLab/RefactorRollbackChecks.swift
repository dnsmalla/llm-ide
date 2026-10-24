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

    // MARK: - markingTodo (a rollback that does not implicate the batch)

    let applied = plan.replacingOccurrences(of: "### R2 Break cycle  (status: todo)",
                                            with: "### R2 Break cycle  (status: done, applied by the loop)")
    let backToTodo = RefactorPlanDiff.markingTodo(applied, id: "R2")
    expect(backToTodo == plan, "markingTodo puts an applied (done) batch back to exactly its todo header")
    let fromBlocked = RefactorPlanDiff.markingTodo(blocked, id: "R2")
    expect(fromBlocked == plan, "markingTodo also drops the `- Blocked:` line under the header")
    expect(RefactorPlanDiff.markingTodo(plan, id: "R2") == plan, "a todo batch stays as it is")
    expect(RefactorPlanDiff.markingTodo(plan, id: "R9") == plan, "an unknown batch id leaves the plan unchanged")

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

    // The "batch": stages a NON-head, non-base value for a.txt (one of the
    // paths actually passed to restore), then dirties the worktree AGAIN on
    // top of that — index and worktree now diverge from each other and from
    // both HEAD and `base`. This is the one shape that can tell `--worktree`
    // apart from `--staged`: a.txt's base-tree content equals HEAD's blob, so
    // staging IT with base's own content (or leaving it alone) would read as
    // index-untouched either way. Only a THIRD, distinct staged value exposes
    // a `restore` that wrongly touches the index.
    try? "aX\n".write(to: root.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    git(["add", "a.txt"], root)
    try? "aY\n".write(to: root.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try? "n1\n".write(to: root.appendingPathComponent("n.txt"), atomically: true, encoding: .utf8)
    try? FileManager.default.removeItem(at: root.appendingPathComponent("b.txt"))
    try? "u1\n".write(to: root.appendingPathComponent("u.txt"), atomically: true, encoding: .utf8)

    let indexBefore = gitOutput(["show", ":a.txt"], root)
    expect(indexBefore == "aX\n", "a.txt's staged (index) content is X before restore runs")

    let restoreError = await guardUnderTest.restore(
        paths: ["a.txt", "n.txt", "b.txt"], fromTree: base, gitRoot: root)
    expect(restoreError == nil, "restore reports no error, got \(restoreError ?? "nil")")

    let a = try? String(contentsOf: root.appendingPathComponent("a.txt"), encoding: .utf8)
    let b = try? String(contentsOf: root.appendingPathComponent("b.txt"), encoding: .utf8)
    let n = FileManager.default.fileExists(atPath: root.appendingPathComponent("n.txt").path)
    let u = try? String(contentsOf: root.appendingPathComponent("u.txt"), encoding: .utf8)
    expect(a == "a1\n", "restore puts a.txt's WORKTREE back to its base-tree content")
    expect(b == "b1\n", "restore recreates b.txt, deleted since the base, from the base tree")
    expect(!n, "restore deletes n.txt, which the base tree never had")
    expect(u == "u1\n", "restore leaves u.txt (not in the restore list) at its second edit")

    // Index-safety: a.txt's STAGED content is still X, not base's "a1" — a
    // `--staged` (or `--staged --worktree`) restore would have overwritten
    // the index entry to match `base`, and this assertion would catch it.
    let indexAfter = gitOutput(["show", ":a.txt"], root)
    expect(indexAfter == indexBefore,
           "restore leaves a.txt's staged (index) content untouched — --worktree only, never --staged")

    // Empty path list is a no-op (mirrors `revert`'s contract).
    let noop = await guardUnderTest.restore(paths: [], fromTree: base, gitRoot: root)
    expect(noop == nil, "restore with no paths is a no-op")

    // A nested path is found in the base tree (not misread as absent).
    try? FileManager.default.createDirectory(at: root.appendingPathComponent("dir"), withIntermediateDirectories: true)
    try? "c1\n".write(to: root.appendingPathComponent("dir/c.txt"), atomically: true, encoding: .utf8)
    if let nestedBase = await guardUnderTest.snapshotTree(gitRoot: root) {
        try? "c2\n".write(to: root.appendingPathComponent("dir/c.txt"), atomically: true, encoding: .utf8)
        let nestedError = await guardUnderTest.restore(paths: ["dir/c.txt"], fromTree: nestedBase, gitRoot: root)
        let c = try? String(contentsOf: root.appendingPathComponent("dir/c.txt"), encoding: .utf8)
        expect(nestedError == nil && c == "c1\n", "restore puts a nested path back from the base tree")
    } else {
        expect(false, "snapshotTree produced a second base tree id")
    }

    // A presence probe that FAILS (here: a tree id git does not know; a Stop
    // cancelling the probe fails the same way) is never read as "absent":
    // the restore aborts before touching anything, so nothing is deleted.
    try? "keep\n".write(to: root.appendingPathComponent("k.txt"), atomically: true, encoding: .utf8)
    let bogus = await guardUnderTest.restore(
        paths: ["k.txt", "a.txt"], fromTree: "0000000000000000000000000000000000000000", gitRoot: root)
    expect(bogus?.contains("nothing was restored") == true,
           "restore from an unreadable tree fails closed, got \(bogus ?? "nil")")
    let k = try? String(contentsOf: root.appendingPathComponent("k.txt"), encoding: .utf8)
    expect(k == "keep\n", "a failed presence probe never deletes the file")

    // Names git would otherwise read as pathspec magic (`:x.txt`), a glob
    // (`a*.txt`, which also matches `ab.txt`) or trim away (` `): each is the
    // file of that exact name, found in the base tree and put back — never
    // misread as absent and deleted, never widened to a neighbour.
    func url(_ name: String) -> URL { root.appendingPathComponent(name) }
    for (name, text) in [(":x.txt", "colon\n"), (" ", "space\n"), ("a*.txt", "star\n"), ("ab.txt", "ab\n")] {
        try? text.write(to: url(name), atomically: true, encoding: .utf8)
    }
    if let oddBase = await guardUnderTest.snapshotTree(gitRoot: root) {
        try? "edited\n".write(to: url(":x.txt"), atomically: true, encoding: .utf8)
        try? FileManager.default.removeItem(at: url(" "))
        try? "edited\n".write(to: url("a*.txt"), atomically: true, encoding: .utf8)
        try? "user\n".write(to: url("ab.txt"), atomically: true, encoding: .utf8)
        let oddError = await guardUnderTest.restore(paths: [":x.txt", " ", "a*.txt"], fromTree: oddBase, gitRoot: root)
        expect(oddError == nil, "restore of odd names reports no error, got \(oddError ?? "nil")")
        expect((try? String(contentsOf: url(":x.txt"), encoding: .utf8)) == "colon\n",
               "a leading-colon name is restored, not read as pathspec magic")
        expect((try? String(contentsOf: url(" "), encoding: .utf8)) == "space\n",
               "a whitespace-only name is found in the base tree and recreated")
        expect((try? String(contentsOf: url("a*.txt"), encoding: .utf8)) == "star\n",
               "a name with a glob character is restored")
        expect((try? String(contentsOf: url("ab.txt"), encoding: .utf8)) == "user\n",
               "the glob-looking name never widens the restore to ab.txt")
    } else {
        expect(false, "snapshotTree produced a base for the odd-name check")
    }

    // A case-only rename inside the batch (`Foo.txt` → `foo.txt`, then an
    // edit). `treeDiff` lists `Foo.txt` (in the base) and `foo.txt` (not), and
    // on a case-insensitive file system — macOS's default — both names are
    // one file: deleting `foo.txt` must never take the restored `Foo.txt`
    // (and the user's uncommitted edit in it) with it.
    try? "committed\n".write(to: url("Foo.txt"), atomically: true, encoding: .utf8)
    git(["add", "Foo.txt"], root)
    git(["commit", "-qm", "foo"], root)
    try? "user edit\n".write(to: url("Foo.txt"), atomically: true, encoding: .utf8)
    if let caseBase = await guardUnderTest.snapshotTree(gitRoot: root) {
        git(["mv", "Foo.txt", "foo.txt"], root)
        try? "batch edit\n".write(to: url("foo.txt"), atomically: true, encoding: .utf8)
        let after = await guardUnderTest.snapshotTree(gitRoot: root) ?? ""
        // What the runner's `treeDiff` reports — its own query, not a copy.
        let changed = await guardUnderTest.changedPaths(from: caseBase, to: after, gitRoot: root) ?? []
        expect(Set(changed) == ["Foo.txt", "foo.txt"],
               "the case-only rename shows up as Foo.txt and foo.txt, got \(changed)")
        let caseError = await guardUnderTest.restore(paths: changed, fromTree: caseBase, gitRoot: root)
        expect(caseError == nil, "restore after a case-only rename reports no error, got \(caseError ?? "nil")")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        expect(names.contains("Foo.txt") && !names.contains("foo.txt"),
               "the base tree's Foo.txt is back under its own name, got \(names.sorted())")
        expect((try? String(contentsOf: url("Foo.txt"), encoding: .utf8)) == "user edit\n",
               "the restored Foo.txt survives the delete of foo.txt, with the user's pre-batch edit")
    } else {
        expect(false, "snapshotTree produced a base for the case-rename check")
    }

    // A MOVE with a small edit — git's rename detection would list only the
    // new name, so the old one was never restored and the new one (absent
    // from the base) was deleted: the file was gone. `changedPaths` runs with
    // `--no-renames`, so the move is both halves and the rollback puts the
    // file back under its old name with its pre-move content.
    let body = (1...30).map { "line \($0)\n" }.joined()
    let moveRoot = makeTempDir()
    defer { try? FileManager.default.removeItem(at: moveRoot) }
    git(["init", "-q"], moveRoot)
    try? FileManager.default.createDirectory(at: moveRoot.appendingPathComponent("old"),
                                             withIntermediateDirectories: true)
    try? (body + "flag = 1\n").write(to: moveRoot.appendingPathComponent("old/mod.txt"),
                                     atomically: true, encoding: .utf8)
    git(["add", "."], moveRoot)
    git(["commit", "-qm", "init"], moveRoot)
    if let moveBase = await guardUnderTest.snapshotTree(gitRoot: moveRoot) {
        try? FileManager.default.createDirectory(at: moveRoot.appendingPathComponent("new"),
                                                 withIntermediateDirectories: true)
        git(["mv", "old/mod.txt", "new/mod.txt"], moveRoot)
        try? (body + "flag = 2\n").write(to: moveRoot.appendingPathComponent("new/mod.txt"),
                                         atomically: true, encoding: .utf8)
        let moveAfter = await guardUnderTest.snapshotTree(gitRoot: moveRoot) ?? ""
        // Precondition: git itself sees this as a rename (so the check tests
        // the flag, not a move too big to be detected anyway).
        let detected = gitOutput(["diff", "--name-status", "-M", moveBase, moveAfter], moveRoot)
        expect(detected.hasPrefix("R"), "precondition: git's default diff reads the move as a rename, got \(detected)")
        let moved = await guardUnderTest.changedPaths(from: moveBase, to: moveAfter, gitRoot: moveRoot) ?? []
        expect(Set(moved) == ["old/mod.txt", "new/mod.txt"],
               "a moved-and-edited file is listed under BOTH names, got \(moved)")
        let moveError = await guardUnderTest.restore(paths: moved, fromTree: moveBase, gitRoot: moveRoot)
        expect(moveError == nil, "restore after a move reports no error, got \(moveError ?? "nil")")
        expect((try? String(contentsOf: moveRoot.appendingPathComponent("old/mod.txt"), encoding: .utf8))
               == body + "flag = 1\n", "the moved file is back at its ORIGINAL path with its pre-move content")
        expect(!FileManager.default.fileExists(atPath: moveRoot.appendingPathComponent("new/mod.txt").path),
               "the moved-to path is gone")
    } else {
        expect(false, "snapshotTree produced a base for the move check")
    }

    // Names git C-quotes outside `-z` (a quote, a backslash, a tab, a
    // newline) come back verbatim, so they are restorable at all.
    let oddNames = ["q\"uote.txt", "back\\slash.txt", "tab\there.txt", "new\nline.txt"]
    if let oddNameBase = await guardUnderTest.snapshotTree(gitRoot: moveRoot) {
        for name in oddNames {
            try? "x\n".write(to: moveRoot.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
        let oddAfter = await guardUnderTest.snapshotTree(gitRoot: moveRoot) ?? ""
        let listed = await guardUnderTest.changedPaths(from: oddNameBase, to: oddAfter, gitRoot: moveRoot) ?? []
        expect(Set(listed) == Set(oddNames), "quote/backslash/tab/newline names are listed raw, got \(listed)")
        let oddRestore = await guardUnderTest.restore(paths: listed, fromTree: oddNameBase, gitRoot: moveRoot)
        expect(oddRestore == nil, "they roll back cleanly, got \(oddRestore ?? "nil")")
        expect(oddNames.allSatisfy { !FileManager.default.fileExists(atPath: moveRoot.appendingPathComponent($0).path) },
               "each odd-named new file is deleted by the rollback")
    } else {
        expect(false, "snapshotTree produced a base for the odd-name list check")
    }

    // A batch that un-ignores a file: the base has `.env` ignored (so never
    // snapshotted); the batch drops the pattern and the file reads as "added
    // since the base". Deleting it as absent from the base would lose a file
    // that was never in any git object — so the restore refuses outright.
    let ignoreRoot = makeTempDir()
    defer { try? FileManager.default.removeItem(at: ignoreRoot) }
    git(["init", "-q"], ignoreRoot)
    try? ".env\n*.log\n".write(to: ignoreRoot.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
    try? "SECRET=keep\n".write(to: ignoreRoot.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
    git(["add", "."], ignoreRoot)
    git(["commit", "-qm", "init"], ignoreRoot)
    if let ignoreBase = await guardUnderTest.snapshotTree(gitRoot: ignoreRoot) {
        try? "*.log\n".write(to: ignoreRoot.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
        let ignoreAfter = await guardUnderTest.snapshotTree(gitRoot: ignoreRoot) ?? ""
        let unIgnored = await guardUnderTest.changedPaths(from: ignoreBase, to: ignoreAfter, gitRoot: ignoreRoot) ?? []
        expect(Set(unIgnored) == [".gitignore", ".env"],
               "precondition: the un-ignored .env reads as changed since the base, got \(unIgnored)")
        let ignoreError = await guardUnderTest.restore(paths: unIgnored, fromTree: ignoreBase, gitRoot: ignoreRoot)
        expect(ignoreError?.contains("nothing was restored") == true && ignoreError?.contains(".gitignore") == true,
               "a restore touching a .gitignore fails closed and says why, got \(ignoreError ?? "nil")")
        expect((try? String(contentsOf: ignoreRoot.appendingPathComponent(".env"), encoding: .utf8)) == "SECRET=keep\n",
               "the un-ignored .env survives untouched")
        expect((try? String(contentsOf: ignoreRoot.appendingPathComponent(".gitignore"), encoding: .utf8)) == "*.log\n",
               "nothing else is touched either: the .gitignore keeps the batch's edit for review")
        let nested = await guardUnderTest.restore(paths: ["sub/.gitignore", "a.txt"], fromTree: ignoreBase,
                                                  gitRoot: ignoreRoot)
        expect(nested?.contains("nothing was restored") == true, "a nested .gitignore fails closed the same way")
    } else {
        expect(false, "snapshotTree produced a base for the .gitignore check")
    }

    // A directory the batch swapped for a symlink to OUTSIDE the repo: a path
    // under it that is "absent from the base" must not be deleted through the
    // link — `standardizedFileURL` alone resolves no symlink on the way.
    let outside = makeTempDir()
    defer { try? FileManager.default.removeItem(at: outside) }
    try? "outside\n".write(to: outside.appendingPathComponent("victim.txt"), atomically: true, encoding: .utf8)
    if let linkBase = await guardUnderTest.snapshotTree(gitRoot: ignoreRoot) {
        try? FileManager.default.createSymbolicLink(at: ignoreRoot.appendingPathComponent("sub"),
                                                    withDestinationURL: outside)
        let linkError = await guardUnderTest.restore(paths: ["sub/victim.txt"], fromTree: linkBase, gitRoot: ignoreRoot)
        expect(linkError?.contains("outside the repository") == true,
               "a delete through a symlinked directory is refused, got \(linkError ?? "nil")")
        expect(FileManager.default.fileExists(atPath: outside.appendingPathComponent("victim.txt").path),
               "the file outside the repository survives")
        // The link itself is a path the batch created: deleting it removes the
        // link, never what it points at.
        let unlinkError = await guardUnderTest.restore(paths: ["sub"], fromTree: linkBase, gitRoot: ignoreRoot)
        expect(unlinkError == nil, "a symlink the batch created is deleted, got \(unlinkError ?? "nil")")
        expect((try? FileManager.default.destinationOfSymbolicLink(atPath: ignoreRoot.appendingPathComponent("sub").path)) == nil
               && FileManager.default.fileExists(atPath: outside.appendingPathComponent("victim.txt").path),
               "the link is gone and its target is not")
    } else {
        expect(false, "snapshotTree produced a base for the symlink check")
    }

    // Tree ids: only the LAST line of `write-tree`'s combined output, and only
    // a full hex object id, is ever used — the id is later spliced into git
    // command lines, so a warning (or anything worse) must never ride along.
    let sha1 = String(repeating: "a1", count: 20)
    let sha256 = String(repeating: "0f", count: 32)
    expect(GitRepairScopeGuard.treeId(fromWriteTreeOutput: "\(sha1)\n") == sha1, "a bare SHA-1 tree id parses")
    expect(GitRepairScopeGuard.treeId(fromWriteTreeOutput: sha256) == sha256, "a SHA-256 tree id parses")
    expect(GitRepairScopeGuard.treeId(fromWriteTreeOutput:
            "warning: in the working copy of 'a.txt', LF will be replaced by CRLF\n\(sha1)\n") == sha1,
           "a git warning before the id is dropped")
    for garbage in ["", "\n", "not a tree", "\(sha1); rm -rf ~", "$(touch pwned)", String(sha1.dropLast()),
                    sha1.uppercased(), "\(sha1)\nwarning: trailing"] {
        expect(GitRepairScopeGuard.treeId(fromWriteTreeOutput: garbage) == nil,
               "a non-id write-tree output is rejected: \(garbage.debugDescription)")
    }
    // For real: CRLF conversion makes `git add` warn on stderr, which the
    // verifier folds into the same output as `write-tree`'s id.
    let crlfRoot = makeTempDir()
    defer { try? FileManager.default.removeItem(at: crlfRoot) }
    git(["init", "-q"], crlfRoot)
    git(["config", "core.autocrlf", "true"], crlfRoot)
    try? "lf\n".write(to: crlfRoot.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    let crlfTree = await guardUnderTest.snapshotTree(gitRoot: crlfRoot)
    expect(crlfTree.map { gitOutput(["cat-file", "-t", $0], crlfRoot) == "tree\n" } == true,
           "a snapshot whose `git add` warns still yields a real tree id, got \(crlfTree ?? "nil")")

    // A path absent from the base is deleted only when it is in `deletable`
    // (the agent reported creating it): the user's own new file looks the same
    // to git and must survive; the agent's created file goes.
    let delRoot = makeTempDir()
    defer { try? FileManager.default.removeItem(at: delRoot) }
    git(["init", "-q"], delRoot)
    try? "a1\n".write(to: delRoot.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    git(["add", "."], delRoot)
    git(["commit", "-qm", "init"], delRoot)
    if let delBase = await guardUnderTest.snapshotTree(gitRoot: delRoot) {
        try? "agent\n".write(to: delRoot.appendingPathComponent("agent-new.txt"), atomically: true, encoding: .utf8)
        try? "user\n".write(to: delRoot.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)
        try? "a2\n".write(to: delRoot.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        let outcome = await guardUnderTest.restore(
            paths: ["a.txt", "agent-new.txt", "notes.md"], fromTree: delBase, gitRoot: delRoot,
            deletable: ["agent-new.txt"])
        expect(outcome.problem == nil, "deletable restore reports no error, got \(outcome.problem ?? "nil")")
        expect(outcome.leftAlone == ["notes.md"], "the unreported absent path is reported left alone")
        expect(!FileManager.default.fileExists(atPath: delRoot.appendingPathComponent("agent-new.txt").path),
               "a file the agent reported creating is deleted on rollback")
        expect((try? String(contentsOf: delRoot.appendingPathComponent("notes.md"), encoding: .utf8)) == "user\n",
               "a file the agent did not report creating is never deleted")
        expect((try? String(contentsOf: delRoot.appendingPathComponent("a.txt"), encoding: .utf8)) == "a1\n",
               "present paths are still restored alongside the filtered deletes")
    } else {
        expect(false, "snapshotTree produced a base for the deletable check")
    }

    // Two source trees in ONE call, with a case-only rename across the groups:
    // `Foo.txt` (edited by edit 1, restored from the base) and `foo.txt` (made
    // by edit 2, created per the agent, absent from the tree before edit 2).
    // Deletions must run before EVERY restore, whatever the tree-id order, or on
    // a case-insensitive file system the delete would take the restored file.
    let grpRoot = makeTempDir()
    defer { try? FileManager.default.removeItem(at: grpRoot) }
    git(["init", "-q"], grpRoot)
    try? "base\n".write(to: grpRoot.appendingPathComponent("Foo.txt"), atomically: true, encoding: .utf8)
    git(["add", "."], grpRoot)
    git(["commit", "-qm", "init"], grpRoot)
    if let t0 = await guardUnderTest.snapshotTree(gitRoot: grpRoot) {
        try? "e1\n".write(to: grpRoot.appendingPathComponent("Foo.txt"), atomically: true, encoding: .utf8)
        if let t1 = await guardUnderTest.snapshotTree(gitRoot: grpRoot) {
            try? FileManager.default.removeItem(at: grpRoot.appendingPathComponent("Foo.txt"))
            try? "e2\n".write(to: grpRoot.appendingPathComponent("foo.txt"), atomically: true, encoding: .utf8)
            let grp = await guardUnderTest.restore(
                groups: [t0: ["Foo.txt"], t1: ["foo.txt"]], gitRoot: grpRoot, deletable: ["foo.txt"])
            expect(grp.problem == nil, "multi-tree restore reports no error, got \(grp.problem ?? "nil")")
            expect((try? String(contentsOf: grpRoot.appendingPathComponent("Foo.txt"), encoding: .utf8)) == "base\n",
                   "a case-only rename across groups ends with the restored Foo.txt, not the deleted one")
            expect(Set(grp.changed) == ["Foo.txt", "foo.txt"], "the result lists every path it changed")
        } else {
            expect(false, "snapshotTree produced the second tree for the multi-tree check")
        }
    } else {
        expect(false, "snapshotTree produced the first tree for the multi-tree check")
    }

    // The `RepairScopeGuarding` default (a guard that cannot run git) and
    // index-safety of the default protocol extension are internal-only
    // concerns (the protocol itself is not `public`) and are asserted by
    // `RepairScopeGuardTests` via `@testable import` instead.
}
#endif
