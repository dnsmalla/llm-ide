import Foundation

/// What to do when a repair edits a path it was not allowed to touch.
public enum ProtectedPathPolicy: String, Codable, CaseIterable {
    /// Undo the offending edits (`git checkout --`) and stop the run. The
    /// default: the working tree is left as the agent found it, and the stage is
    /// reported as blocked rather than fixed.
    case revert
    /// Leave the edits in place but stop the run so a human can look.
    case stop
    /// Leave the edits in place and keep looping; the violation is logged and
    /// journalled. For projects where the "protected" set is too coarse to be
    /// authoritative.
    case warn
    /// Do not check at all. Restores pre-guard behaviour.
    case off

    var label: String {
        switch self {
        case .revert: return "Revert & stop"
        case .stop: return "Stop"
        case .warn: return "Warn only"
        case .off: return "Off"
        }
    }
}

/// The result of checking what a repair changed.
enum RepairScopeCheck: Equatable {
    /// The repair touched no protected path.
    case clean(changedPaths: [String])
    /// The repair touched these protected paths.
    case violated(paths: [String], allChangedPaths: [String])
    /// The check could not run — not a git working tree, git unavailable, or the
    /// command failed. Deliberately NOT folded into `.clean`: reporting "no
    /// violations" when the check never ran is exactly the silent-pass this
    /// whole mechanism exists to prevent.
    case indeterminate(reason: String)
}

/// Detects and undoes repairs that edit the things a repair must never edit.
///
/// **Why this is code and not a prompt.** `AgentLoopStageRepairer.buildPrompt`
/// already asks the agent not to "weaken or delete tests/assertions, or skip
/// cases to make it pass". That instruction is unenforceable: the repair agent
/// has write access to the whole working tree, and for a stubborn failure the
/// cheapest way to make `swift test` exit 0 is to delete the failing test. The
/// loop would then observe exit 0, report `.success`, and the harness would have
/// certified a regression as fixed. A verifier the thing-being-verified can edit
/// is not a verifier.
///
/// So the protected set covers three groups, all of which are inputs to the
/// verdict rather than the code under repair:
/// 1. **Tests** — the assertions that define "passing".
/// 2. **Build and verify config** — `Makefile`, `Package.swift`, `package.json`
///    (whose `scripts.test` the detector reads), `pytest.ini`, `.githooks/`.
/// 3. **The harness's own state** — `system/faults.csv`, `system/faults/`,
///    `system/loop-runs/`. Editing the fault list is a direct way to make a
///    regression sweep pass.
protocol RepairScopeGuarding: AnyObject {
    /// Opaque token describing the working tree before a repair.
    func snapshot(gitRoot: URL) async -> RepairScopeSnapshot
    /// What changed since `snapshot`, and whether any of it is protected.
    func check(since snapshot: RepairScopeSnapshot, gitRoot: URL, protectedGlobs: [String]) async -> RepairScopeCheck
    /// Restores `paths` to their committed state. Returns `nil` on success, or a
    /// diagnostic.
    func revert(paths: [String], gitRoot: URL) async -> String?
}

/// The set of dirty paths in the working tree at a point in time, plus a
/// content hash of each of them.
///
/// Dirty-set membership catches every path the repair newly touched. The hashes
/// catch the rest: a path that was ALREADY dirty (the user's own uncommitted
/// edit, or an earlier stage of the same loop) and that the repair edited again
/// — a Loop that dirtied a test in iteration 1 could otherwise rewrite it freely
/// in every later repair.
struct RepairScopeSnapshot: Equatable {
    /// Repo-relative paths already dirty before the repair ran — rename and
    /// copy SOURCES included, so moving a protected file away is seen too.
    let dirtyPaths: Set<String>
    /// False when the snapshot could not be taken (not a git tree, git missing).
    let usable: Bool
    let reason: String?
    /// `git hash-object` of each dirty path (`GitRepairScopeGuard.missingHash`
    /// for one that no longer exists). A path absent here could not be hashed
    /// and is judged by dirty-set membership alone.
    var contentHashes: [String: String] = [:]

    static func unusable(_ reason: String) -> RepairScopeSnapshot {
        RepairScopeSnapshot(dirtyPaths: [], usable: false, reason: reason)
    }
}

/// Production guard, driving `git` through `FaultVerifier` — the codebase's
/// single sanctioned subprocess path (see `ShellFaultVerifier`), so no new code
/// reaches `/bin/sh` directly.
final class GitRepairScopeGuard: RepairScopeGuarding {
    /// Default protected globs, matched against repo-relative paths by
    /// `GlobMatch`. Users extend (never replace) this via
    /// `LoopEngineConfig.extraProtectedGlobs`.
    static let defaultProtectedGlobs: [String] = [
        // 1. Tests — the definition of "passing".
        "**/Tests/**", "**/tests/**", "**/test/**", "**/__tests__/**",
        "**/*Tests.swift", "**/*Test.swift", "**/*.test.mjs", "**/*.test.ts",
        "**/*.test.js", "**/*.test.tsx", "**/*_test.go", "**/test_*.py",
        "**/*_test.py", "**/*.spec.ts", "**/*.spec.js",
        // 2. Build + verify configuration — what the stage command resolves to.
        "Makefile", "**/Makefile", "**/Package.swift", "**/package.json",
        "pytest.ini", "**/pytest.ini", "**/pyproject.toml", "**/setup.cfg",
        ".githooks/**", "**/jest.config.js", "**/vitest.config.ts",
        // 3. The harness's own state — editing this rigs the verdict directly.
        "system/faults.csv", "system/faults/**", "system/loop-runs/**"
    ]

    private let verifier: FaultVerifier
    private let timeout: TimeInterval

    init(verifier: FaultVerifier = ShellFaultVerifier(), timeout: TimeInterval = 60) {
        self.verifier = verifier
        self.timeout = timeout
    }

    func snapshot(gitRoot: URL) async -> RepairScopeSnapshot {
        switch await dirtyPaths(gitRoot: gitRoot) {
        case .success(let paths):
            return RepairScopeSnapshot(dirtyPaths: paths, usable: true, reason: nil,
                                       contentHashes: await hashes(of: paths, gitRoot: gitRoot))
        case .failure(let reason):
            return .unusable(reason)
        }
    }

    /// The hash recorded for a dirty path that does not exist on disk (a
    /// deletion, a rename source). Not a valid object id, so it never equals one.
    static let missingHash = "<missing>"

    /// `git hash-object` for each path, batched. Best-effort: a batch whose
    /// output does not line up with its input is left out, so those paths fall
    /// back to membership-only checking rather than being guessed at.
    private func hashes(of paths: Set<String>, gitRoot: URL) async -> [String: String] {
        var out: [String: String] = [:]
        var present: [String] = []
        for path in paths.sorted() {
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(
                atPath: gitRoot.appendingPathComponent(path).path, isDirectory: &isDir)
            if !exists { out[path] = Self.missingHash } else if !isDir.boolValue { present.append(path) }
        }
        var start = 0
        while start < present.count {
            let batch = Array(present[start..<min(start + 100, present.count)])
            start += batch.count
            guard case .success(let output) = await run(
                "git hash-object -- \(Self.shellQuoted(batch))", gitRoot: gitRoot) else { continue }
            let lines = output.split(whereSeparator: \.isNewline).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            guard lines.count == batch.count else { continue }
            for (path, hash) in zip(batch, lines) { out[path] = hash }
        }
        return out
    }

    func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
               protectedGlobs: [String]) async -> RepairScopeCheck {
        guard snapshot.usable else {
            return .indeterminate(reason: snapshot.reason ?? "no usable pre-repair snapshot")
        }
        let after: Set<String>
        switch await dirtyPaths(gitRoot: gitRoot) {
        case .success(let paths): after = paths
        case .failure(let reason): return .indeterminate(reason: reason)
        }

        // Newly-dirty paths, plus already-dirty paths whose CONTENT changed.
        // Mere membership of an already-dirty file is not attributed to the
        // repair — flagging it would block every loop run started from a tree
        // with uncommitted test edits (the normal state while developing). But
        // an already-dirty file the repair edited AGAIN is the repair's edit:
        // without the hash comparison a loop that dirtied a test once could
        // rewrite it in every later repair unseen. A pre-dirty path that is
        // clean afterwards was restored by the repair — also an edit.
        var changedSet = after.subtracting(snapshot.dirtyPaths)
        changedSet.formUnion(snapshot.dirtyPaths.subtracting(after)
            .filter { snapshot.contentHashes[$0] != nil })
        let stillDirty = after.intersection(snapshot.dirtyPaths)
            .filter { snapshot.contentHashes[$0] != nil }
        if !stillDirty.isEmpty {
            let now = await hashes(of: stillDirty, gitRoot: gitRoot)
            for path in stillDirty {
                if let old = snapshot.contentHashes[path], let new = now[path], old != new {
                    changedSet.insert(path)
                }
            }
        }
        let changed = changedSet.sorted()
        let violations = changed.filter { path in
            protectedGlobs.contains { GlobMatch.matches(path: path, pattern: $0) }
        }
        return violations.isEmpty
            ? .clean(changedPaths: changed)
            : .violated(paths: violations, allChangedPaths: changed)
    }

    func revert(paths: [String], gitRoot: URL) async -> String? {
        guard !paths.isEmpty else { return nil }
        // `git checkout --` only restores TRACKED files. An untracked file the
        // repair ADDED (a shadowing conftest.py — exactly what `dirtyPaths`
        // lists untracked files to catch) makes it fail with "pathspec did not
        // match", which aborts the whole command, so the rigged file stayed
        // AND the tracked violations beside it were not reverted either.
        // Split first: untracked paths are deleted with `git clean -f`,
        // tracked ones restored with checkout. If the probe itself fails,
        // fall back to treating everything as tracked (the old behaviour) so
        // a tracked-only revert still works.
        var untracked: Set<String> = []
        if case .success(let output) = await run(
            "git status --porcelain --untracked-files=all -- \(Self.shellQuoted(paths))", gitRoot: gitRoot) {
            untracked = Set(StatusParser.parse(porcelain: output)
                .filter { $0.status == .untracked }.map(\.path))
        }
        let tracked = paths.filter { !untracked.contains($0) }
        let added = paths.filter { untracked.contains($0) }

        var failures: [String] = []
        if !tracked.isEmpty,
           case .failure(let reason) = await run("git checkout -- \(Self.shellQuoted(tracked))",
                                                 gitRoot: gitRoot) {
            failures.append(reason)
        }
        if !added.isEmpty,
           case .failure(let reason) = await run("git clean -f -- \(Self.shellQuoted(added))",
                                                 gitRoot: gitRoot) {
            failures.append(reason)
        }
        return failures.isEmpty ? nil : failures.joined(separator: "; ")
    }

    /// `--` (at each call site) separates paths from revisions so a path that
    /// looks like a ref cannot be reinterpreted; each path is single-quoted
    /// with embedded quotes escaped, since these strings come from git's own
    /// output rather than from a user but still reach a shell.
    private static func shellQuoted(_ paths: [String]) -> String {
        paths.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }
            .joined(separator: " ")
    }

    /// A git probe either produced output or explains why it could not. A plain
    /// `Result` would need `String: Error`; the failure here is a diagnostic to
    /// show the user, not a thrown error, so it gets its own type.
    private enum Probe<T> {
        case success(T)
        case failure(String)
    }

    /// Every path git considers changed: tracked modifications plus untracked
    /// files. Untracked matters — "make the test pass" can mean adding a new
    /// conftest.py or a shadowing test file, not only editing an existing one.
    private func dirtyPaths(gitRoot: URL) async -> Probe<Set<String>> {
        switch await run("git status --porcelain --untracked-files=all", gitRoot: gitRoot) {
        case .failure(let reason):
            return .failure(reason)
        case .success(let output):
            // Rename/copy SOURCES count as dirty too: `git mv` of a protected
            // test to a non-protected name leaves only the destination in
            // `path`, and the vanished source is the edit that matters.
            var paths = Set<String>()
            for change in StatusParser.parse(porcelain: output) {
                paths.insert(change.path)
                if let source = change.renamedFrom { paths.insert(source) }
            }
            return .success(paths)
        }
    }

    private func run(_ command: String, gitRoot: URL) async -> Probe<String> {
        do {
            let outcome = try await verifier.verify(command: command, repoRoot: gitRoot, timeout: timeout)
            guard outcome.exitCode == 0 else {
                return .failure("`\(command)` exited \(outcome.exitCode): \(outcome.output.suffix(200))")
            }
            return .success(outcome.output)
        } catch {
            return .failure("`\(command)` failed: \(error.localizedDescription)")
        }
    }
}
