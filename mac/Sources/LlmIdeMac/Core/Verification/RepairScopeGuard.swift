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
    /// A probe ran but its output was cut short, so a changed protected path
    /// could have been hidden. FAIL-CLOSED — unlike `.indeterminate`, which is
    /// "git is not available here": the runner blocks the run as for a
    /// violation, because an incomplete list is worse than none.
    case unverifiable(reason: String)
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
    /// Snapshots the working tree (tracked + untracked, honouring .gitignore)
    /// into a git tree object WITHOUT touching the real index; returns its id,
    /// or `nil` when that is not possible.
    func snapshotTree(gitRoot: URL) async -> String?
    /// What changed between two `snapshotTree` ids: every changed path, the
    /// stat, and the diff limited to paths `isQuotable` accepts. `nil` on failure.
    func treeDiff(from: String, to: String, gitRoot: URL, maxChars: Int,
                  isQuotable: (String) -> Bool) async -> RepairDiffSummary?
    /// Opaque token describing the working tree before a repair. The globs
    /// say which already-dirty paths are worth content-hashing: only one that
    /// is protected, or outside a non-empty scope allowlist, can ever produce
    /// a violation.
    func snapshot(gitRoot: URL, protectedGlobs: [String], scopeGlobs: [String]) async -> RepairScopeSnapshot
    /// What changed since `snapshot`, and whether any of it is protected.
    func check(since snapshot: RepairScopeSnapshot, gitRoot: URL, protectedGlobs: [String]) async -> RepairScopeCheck
    /// Restores `paths` to their committed state. Returns `nil` on success, or a
    /// diagnostic.
    func revert(paths: [String], gitRoot: URL) async -> String?
    /// Undo edits to paths `git status` does not list (ignored files the agent
    /// wrote): restore each from HEAD when it is tracked there, else delete it
    /// only when it is in `created` (the agent made it); a file that existed
    /// before the edit and is not in HEAD cannot be restored and is left in
    /// place. Returns nil on success, else why not.
    func revertUnlisted(paths: [String], created: Set<String>, gitRoot: URL) async -> String?
    /// As above, but told the pre-edit snapshot: a tracked file hidden from
    /// `git status` (assume-unchanged / skip-worktree) is restored from HEAD
    /// only when its pre-edit content equalled HEAD's blob — else the local
    /// edit that was there first would be destroyed, so it is left in place.
    func revertUnlisted(paths: [String], created: Set<String>, before: RepairScopeSnapshot,
                        gitRoot: URL) async -> String?
}

/// What a repair changed, tree to tree: all changed paths, `git diff --stat`,
/// and a trimmed diff of the paths that are safe to quote.
struct RepairDiffSummary: Equatable {
    var changedPaths: [String] = []
    var stat: String = ""
    var diff: String = ""
}

extension RepairScopeGuarding {
    /// Defaults: no tree snapshots (a guard that cannot run git).
    func snapshotTree(gitRoot: URL) async -> String? { nil }
    func treeDiff(from: String, to: String, gitRoot: URL, maxChars: Int,
                  isQuotable: (String) -> Bool) async -> RepairDiffSummary? { nil }

    /// Fail-closed default: a guard that cannot restore unlisted paths says
    /// so, which keeps the violation (and the run) blocked.
    func revertUnlisted(paths: [String], created: Set<String>, gitRoot: URL) async -> String? {
        paths.isEmpty ? nil : "cannot restore unlisted path(s): \(paths.joined(separator: ", "))"
    }

    func revertUnlisted(paths: [String], created: Set<String>, before: RepairScopeSnapshot,
                        gitRoot: URL) async -> String? {
        await revertUnlisted(paths: paths, created: created, gitRoot: gitRoot)
    }
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
    /// True when a snapshot probe's output was elided — `check` then fails
    /// closed with `.unverifiable`.
    var elided: Bool = false
    /// Tracked files git hides from `status` (assume-unchanged / skip-worktree)
    /// that could violate, with their content hash ("" when it could not be
    /// taken). Their local content may differ from HEAD with no trace in git.
    var hiddenHashes: [String: String] = [:]

    static func unusable(_ reason: String) -> RepairScopeSnapshot {
        RepairScopeSnapshot(dirtyPaths: [], usable: false, reason: reason)
    }
}

/// Matching against a protected-path list, with exemption entries.
public enum ProtectedGlobs {
    /// Marks an exemption entry in a protected list: `!<glob>` un-protects the
    /// paths it matches. Only the runner adds one (`LoopEngineConfig.protectedGlobs`,
    /// which drops any a user stored); a caller that matches entries with plain
    /// `GlobMatch` sees it as a pattern no real path matches, so it fails closed.
    public static let exemptionPrefix = "!"

    /// Whether `path` matches a protected glob and no exemption entry.
    public static func isProtected(_ path: String, by globs: [String]) -> Bool {
        var isHit = false
        for glob in globs {
            if glob.hasPrefix(exemptionPrefix) {
                let pattern = String(glob.dropFirst(exemptionPrefix.count))
                // A bare "!" would match everything (GlobMatch treats an empty
                // pattern as a wildcard) and un-protect the whole tree.
                guard !pattern.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                if GlobMatch.matches(path: path, pattern: pattern) { return false }
            } else if !isHit, GlobMatch.matches(path: path, pattern: glob) {
                isHit = true
            }
        }
        return isHit
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

    /// Uncapped by default: git's output here is paths and hashes, and the
    /// capped head+tail capture would drop the middle of a long path list.
    init(verifier: FaultVerifier = ShellFaultVerifier.uncapped(), timeout: TimeInterval = 60) {
        self.verifier = verifier
        self.timeout = timeout
    }

    /// Snapshot with the default protected set and no scope allowlist.
    func snapshot(gitRoot: URL) async -> RepairScopeSnapshot {
        await snapshot(gitRoot: gitRoot, protectedGlobs: Self.defaultProtectedGlobs, scopeGlobs: [])
    }

    func snapshot(gitRoot: URL, protectedGlobs: [String],
                  scopeGlobs: [String]) async -> RepairScopeSnapshot {
        switch await dirtyPaths(gitRoot: gitRoot) {
        case .success(let paths):
            let worth = paths.filter {
                Self.canViolate($0, protectedGlobs: protectedGlobs, scopeGlobs: scopeGlobs)
            }
            let hashed = await hashes(of: worth, gitRoot: gitRoot)
            var snap = RepairScopeSnapshot(dirtyPaths: paths, usable: true, reason: nil,
                                           contentHashes: hashed.hashes, elided: hashed.truncated)
            snap.hiddenHashes = await hiddenTracked(gitRoot: gitRoot, protectedGlobs: protectedGlobs,
                                                    scopeGlobs: scopeGlobs)
            return snap
        case .truncated:
            return RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil, elided: true)
        case .failure(let reason):
            return .unusable(reason)
        }
    }

    /// Tracked files marked assume-unchanged or skip-worktree (`git ls-files -v`
    /// tags: lowercase, or `S`) that could violate, each with its content hash.
    private func hiddenTracked(gitRoot: URL, protectedGlobs: [String],
                               scopeGlobs: [String]) async -> [String: String] {
        guard case .success(let output) = await run("git ls-files -v", gitRoot: gitRoot) else { return [:] }
        var hidden = Set<String>()
        for line in output.split(whereSeparator: \.isNewline) where line.count > 2 {
            let tag = line.first!
            let hides = tag == "S" || (tag.isLetter && tag.isLowercase)
            let path = String(line.dropFirst(2))
            if hides, Self.canViolate(path, protectedGlobs: protectedGlobs, scopeGlobs: scopeGlobs) {
                hidden.insert(path)
            }
        }
        guard !hidden.isEmpty else { return [:] }
        let hashed = await hashes(of: hidden, gitRoot: gitRoot).hashes
        return Dictionary(uniqueKeysWithValues: hidden.map { ($0, hashed[$0] ?? "") })
    }

    /// Whether an edit to `path` could be a violation: it is protected, or a
    /// non-empty scope allowlist (blank rows ignored, as in the runner) does
    /// not cover it. Hashing anything else is wasted work.
    static func canViolate(_ path: String, protectedGlobs: [String], scopeGlobs: [String]) -> Bool {
        if ProtectedGlobs.isProtected(path, by: protectedGlobs) { return true }
        let scope = scopeGlobs.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return !scope.isEmpty && !scope.contains { GlobMatch.matches(path: path, pattern: $0) }
    }

    /// The hash recorded for a dirty path that does not exist on disk (a
    /// deletion, a rename source). Not a valid object id, so it never equals one.
    static let missingHash = "<missing>"

    /// Files larger than this are not hashed; they are judged by dirty-set
    /// membership alone, so one huge fixture cannot make every repair slow.
    static let maxHashedFileBytes = 1_000_000

    /// `git hash-object` for each path, in ONE process (`--stdin-paths`).
    /// Best-effort: output that does not line up with the input is dropped,
    /// so those paths fall back to membership-only checking rather than being
    /// guessed at; a path containing a newline cannot travel through stdin
    /// and is skipped the same way.
    private func hashes(of paths: Set<String>,
                        gitRoot: URL) async -> (hashes: [String: String], truncated: Bool) {
        var out: [String: String] = [:]
        var present: [String] = []
        for path in paths.sorted() where !path.contains("\n") {
            let file = gitRoot.appendingPathComponent(path).path
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: file) else {
                if !FileManager.default.fileExists(atPath: file) { out[path] = Self.missingHash }
                continue
            }
            guard attrs[.type] as? FileAttributeType == .typeRegular,
                  let size = attrs[.size] as? NSNumber,
                  size.intValue <= Self.maxHashedFileBytes else { continue }
            present.append(path)
        }
        guard !present.isEmpty else { return (out, false) }
        // `printf` is a shell builtin: the list travels in the one command
        // string, and git reads it on stdin — one process however many paths.
        let command = "printf '%s\\n' \(Self.shellQuoted(present)) | git hash-object --stdin-paths"
        let output: String
        switch await run(command, gitRoot: gitRoot) {
        case .success(let text): output = text
        case .truncated: return (out, true)
        case .failure: return (out, false)
        }
        let lines = output.split(whereSeparator: \.isNewline).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard lines.count == present.count else { return (out, false) }
        for (path, hash) in zip(present, lines) { out[path] = hash }
        return (out, false)
    }

    func check(since snapshot: RepairScopeSnapshot, gitRoot: URL,
               protectedGlobs: [String]) async -> RepairScopeCheck {
        guard snapshot.usable else {
            return .indeterminate(reason: snapshot.reason ?? "no usable pre-repair snapshot")
        }
        if snapshot.elided { return .unverifiable(reason: Self.truncatedReason) }
        let after: Set<String>
        switch await dirtyPaths(gitRoot: gitRoot) {
        case .success(let paths): after = paths
        case .truncated: return .unverifiable(reason: Self.truncatedReason)
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
            let hashed = await hashes(of: stillDirty, gitRoot: gitRoot)
            if hashed.truncated { return .unverifiable(reason: Self.truncatedReason) }
            let now = hashed.hashes
            for path in stillDirty {
                if let old = snapshot.contentHashes[path], let new = now[path], old != new {
                    changedSet.insert(path)
                }
            }
        }
        let changed = changedSet.sorted()
        let violations = changed.filter { ProtectedGlobs.isProtected($0, by: protectedGlobs) }
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
        //
        // Tracked paths are restored from HEAD (`git checkout HEAD --`), not
        // from the index: a staged rename or deletion has already removed the
        // path from the index, so a plain `git checkout --` of a rename SOURCE
        // failed with "did not match" and the moved-away test stayed gone.
        // A path that exists only in the index (staged as added, or a rename
        // destination) is not in HEAD, so checkout HEAD would fail on it; it is
        // new — the edit created it — and is removed with `git rm -f`.
        var untracked: Set<String> = []
        var indexOnly: Set<String> = []
        if case .success(let output) = await run(
            "git status --porcelain --untracked-files=all -- \(Self.shellQuoted(paths))", gitRoot: gitRoot) {
            for change in StatusParser.parse(porcelain: output) {
                switch change.status {
                case .untracked: untracked.insert(change.path)
                case .added where change.staged: indexOnly.insert(change.path)
                case .renamed where change.staged: indexOnly.insert(change.path)
                default: break
                }
            }
        }
        let added = paths.filter { untracked.contains($0) }
        let staged = paths.filter { indexOnly.contains($0) && !untracked.contains($0) }
        let tracked = paths.filter { !untracked.contains($0) && !indexOnly.contains($0) }

        var failures: [String] = []
        if !staged.isEmpty,
           case .failure(let reason) = await run("git rm -q -f -- \(Self.shellQuoted(staged))",
                                                 gitRoot: gitRoot) {
            failures.append(reason)
        }
        if !tracked.isEmpty,
           case .failure(let reason) = await run("git checkout HEAD -- \(Self.shellQuoted(tracked))",
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
    func revertUnlisted(paths: [String], created: Set<String>, gitRoot: URL) async -> String? {
        await revertUnlisted(paths: paths, created: created,
                             before: RepairScopeSnapshot(dirtyPaths: [], usable: true, reason: nil),
                             gitRoot: gitRoot)
    }

    func revertUnlisted(paths: [String], created: Set<String>, before: RepairScopeSnapshot,
                        gitRoot: URL) async -> String? {
        var failures: [String] = []
        for path in paths {
            if case .success = await run("git cat-file -e \(Self.shellQuoted(["HEAD:" + path]))", gitRoot: gitRoot) {
                // Hidden from `status` before the edit: its local content may
                // have been the user's own. Restore only if it equalled HEAD.
                if let pre = before.hiddenHashes[path] {
                    guard case .success(let head) = await run(
                        "git rev-parse \(Self.shellQuoted(["HEAD:" + path]))", gitRoot: gitRoot),
                          !pre.isEmpty, head.trimmingCharacters(in: .whitespacesAndNewlines) == pre else {
                        failures.append("\(path) is hidden from git status (assume-unchanged/skip-worktree) and "
                                        + "its pre-edit content differed from HEAD, so it was left in place")
                        continue
                    }
                }
                if case .failure(let reason) = await run("git checkout HEAD -- \(Self.shellQuoted([path]))",
                                                         gitRoot: gitRoot) {
                    failures.append(reason)
                }
            } else if created.contains(path) {
                do {
                    // `created` paths come from the server's report. A `..` or
                    // absolute entry must never turn this into a delete outside
                    // the repo, so contain the resolved path first.
                    let url = gitRoot.appendingPathComponent(path).standardizedFileURL
                    let rootPrefix = gitRoot.standardizedFileURL.path.hasSuffix("/")
                        ? gitRoot.standardizedFileURL.path : gitRoot.standardizedFileURL.path + "/"
                    guard !path.hasPrefix("/"), url.path.hasPrefix(rootPrefix) else {
                        failures.append("refusing to delete \(path): it is outside the repository")
                        continue
                    }
                    if FileManager.default.fileExists(atPath: url.path) {
                        try FileManager.default.removeItem(at: url)
                    }
                } catch {
                    failures.append("could not delete \(path): \(error.localizedDescription)")
                }
            } else {
                failures.append("\(path) existed before the edit and is not in HEAD, so it was left in place")
            }
        }
        return failures.isEmpty ? nil : failures.joined(separator: "; ")
    }

    func snapshotTree(gitRoot: URL) async -> String? {
        // A throwaway index in its own temp dir: the user's real index is never
        // written. It is seeded from a COPY of the real index when there is one —
        // its stat cache lets `add -A` hash only files that changed, instead of
        // every tracked file (0.5 s → 0.08 s on this repo, and it grows with the
        // file count) — else from `read-tree HEAD` (empty on an unborn branch).
        // `add -A` then records the working tree, honouring .gitignore.
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-idx-\(UUID().uuidString)", isDirectory: true)
        guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil
        else { return nil }
        defer { try? FileManager.default.removeItem(at: dir) }
        let tmpIndex = Self.shellQuoted([dir.appendingPathComponent("index").path])
        // The real index path is resolved BEFORE GIT_INDEX_FILE is set (after,
        // it would name the temp file), and GIT_INDEX_FILE is exported
        // unconditionally first thing after that, so no later command can ever
        // fall through to the user's real index.
        let command = "real=$(git rev-parse --git-path index 2>/dev/null); "
            + "export GIT_INDEX_FILE=\(tmpIndex); "
            + "if [ -n \"$real\" ] && [ -f \"$real\" ]; then cp \"$real\" \"$GIT_INDEX_FILE\"; "
            + "else git read-tree HEAD 2>/dev/null || git read-tree --empty; fi; "
            + "git add -A && git write-tree"
        guard case .success(let out) = await run(command, gitRoot: gitRoot) else { return nil }
        let id = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return id.isEmpty ? nil : id
    }

    func treeDiff(from: String, to: String, gitRoot: URL, maxChars: Int,
                  isQuotable: (String) -> Bool) async -> RepairDiffSummary? {
        guard case .success(let names) = await run(
            "git -c core.quotepath=off diff --name-only \(from) \(to)", gitRoot: gitRoot) else { return nil }
        let paths = names.split(whereSeparator: \.isNewline).map(String.init)
        var out = RepairDiffSummary(changedPaths: paths)
        guard !paths.isEmpty else { return out }
        if case .success(let stat) = await run("git -c core.quotepath=off diff --stat \(from) \(to)", gitRoot: gitRoot) {
            out.stat = stat.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let quotable = paths.filter(isQuotable)
        if !quotable.isEmpty,
           case .success(let diff) = await run(
               "git -c core.quotepath=off diff \(from) \(to) -- \(Self.shellQuoted(quotable))", gitRoot: gitRoot) {
            out.diff = String(diff.prefix(maxChars))
        }
        return out
    }

    private static func shellQuoted(_ paths: [String]) -> String {
        paths.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }
            .joined(separator: " ")
    }

    /// A git probe either produced output or explains why it could not. A plain
    /// `Result` would need `String: Error`; the failure here is a diagnostic to
    /// show the user, not a thrown error, so it gets its own type.
    private enum Probe<T> {
        case success(T)
        /// The probe succeeded but its output was elided — never trusted.
        case truncated
        case failure(String)
    }

    static let truncatedReason =
        "git output was cut short, so a change to a protected path could be hidden"

    /// Every path git considers changed: tracked modifications plus untracked
    /// files. Untracked matters — "make the test pass" can mean adding a new
    /// conftest.py or a shadowing test file, not only editing an existing one.
    private func dirtyPaths(gitRoot: URL) async -> Probe<Set<String>> {
        switch await run("git status --porcelain --untracked-files=all", gitRoot: gitRoot) {
        case .failure(let reason):
            return .failure(reason)
        case .truncated:
            return .truncated
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
            return outcome.elided ? .truncated : .success(outcome.output)
        } catch {
            return .failure("`\(command)` failed: \(error.localizedDescription)")
        }
    }
}
