import Foundation

/// What to do when a repair edits a path it was not allowed to touch.
enum ProtectedPathPolicy: String, Codable, CaseIterable {
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

/// The set of dirty paths in the working tree at a point in time.
///
/// Comparing dirty-set membership (rather than diffing file contents) is what
/// makes the check cheap enough to run around every repair. It does mean a file
/// the repair modified that was *already* dirty before the repair is not flagged
/// — see `GitRepairScopeGuard.check` for why that tradeoff is the right one.
struct RepairScopeSnapshot: Equatable {
    /// Repo-relative paths already dirty before the repair ran.
    let dirtyPaths: Set<String>
    /// False when the snapshot could not be taken (not a git tree, git missing).
    let usable: Bool
    let reason: String?

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
            return RepairScopeSnapshot(dirtyPaths: paths, usable: true, reason: nil)
        case .failure(let reason):
            return .unusable(reason)
        }
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

        // Newly-dirty paths only. A file that was ALREADY modified before the
        // repair cannot be attributed to the repair — flagging it would block
        // every loop run started from a working tree with uncommitted test edits
        // (the normal state while developing), which would make the guard so
        // annoying it would be turned off. The gap is bounded and understood: a
        // repair that further edits an already-dirty protected file goes
        // unflagged. The pre-existing edit is the user's own, and the loop's
        // other defences (the run's stage list is user-approved, and `.revert`
        // never touches files it did not attribute) still apply.
        let changed = after.subtracting(snapshot.dirtyPaths).sorted()
        let violations = changed.filter { path in
            protectedGlobs.contains { GlobMatch.matches(path: path, pattern: $0) }
        }
        return violations.isEmpty
            ? .clean(changedPaths: changed)
            : .violated(paths: violations, allChangedPaths: changed)
    }

    func revert(paths: [String], gitRoot: URL) async -> String? {
        guard !paths.isEmpty else { return nil }
        // `--` separates paths from revisions so a path that looks like a ref
        // cannot be reinterpreted; each path is single-quoted with embedded
        // quotes escaped, since these strings come from git's own output rather
        // than from a user but still reach a shell.
        let quoted = paths.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }
            .joined(separator: " ")
        switch await run("git checkout -- \(quoted)", gitRoot: gitRoot) {
        case .success: return nil
        case .failure(let reason): return reason
        }
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
            let paths = StatusParser.parse(porcelain: output).map(\.path)
            return .success(Set(paths))
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
