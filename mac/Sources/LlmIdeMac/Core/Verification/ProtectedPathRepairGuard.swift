import Foundation

/// A `FaultRepairGuard` for fault repairs that run OUTSIDE a Loop — the Auto
/// Task regression sweep. It applies the protected-path rule with the
/// `.revert` policy: snapshot the tree, run the repair, check what changed
/// (git's view plus the agent's own reported writes), revert protected edits
/// and reject the repair. The Loop has its own, policy-aware guard
/// (`LoopEngineRunner.withScopeGuard`); this is the same check with the
/// default protected globs and no configuration, so an unattended sweep can
/// never keep a repair that edited a test to make it pass.
enum ProtectedPathRepairGuard {

    static func make(scopeGuard: RepairScopeGuarding = GitRepairScopeGuard(),
                     protectedGlobs: [String] = GitRepairScopeGuard.defaultProtectedGlobs,
                     log: @escaping @MainActor (String) -> Void = { _ in }) -> FaultRepairGuard {
        { repoRoot, repair in
            let before = await scopeGuard.snapshot(gitRoot: repoRoot, protectedGlobs: protectedGlobs,
                                                   scopeGlobs: [])
            var reported = Set<String>()
            var created = Set<String>()
            var thrown: Error?
            do {
                let result = try await repair(nil)
                reported = Set(result.changedPaths)
                created = Set(result.createdPaths)
            } catch {
                thrown = error
            }
            // In a task a Stop does not cancel, so a cancelled repair's edits
            // are still checked (and reverted) before the error propagates.
            let kept = await Task { @MainActor in
                await judge(before: before, reported: reported, created: created, repoRoot: repoRoot,
                            scopeGuard: scopeGuard, protectedGlobs: protectedGlobs, log: log)
            }.value
            if let thrown { throw thrown }
            return kept
        }
    }

    /// True to keep the repair. `.indeterminate` (git unavailable) keeps it —
    /// the same fail-open rule the Loop applies — unless the agent itself
    /// reported a protected write.
    @MainActor
    private static func judge(before: RepairScopeSnapshot, reported: Set<String>, created: Set<String>,
                              repoRoot: URL, scopeGuard: RepairScopeGuarding, protectedGlobs: [String],
                              log: (String) -> Void) async -> Bool {
        let isProtected = { (path: String) in
            protectedGlobs.contains { GlobMatch.matches(path: path, pattern: $0) }
        }
        let gitChanged: Set<String>
        var violations: Set<String>
        switch await scopeGuard.check(since: before, gitRoot: repoRoot, protectedGlobs: protectedGlobs) {
        case .clean(let changed):
            gitChanged = Set(changed); violations = []
        case .violated(let paths, let changed):
            gitChanged = Set(changed); violations = Set(paths)
        case .unverifiable(let reason):
            log("repair rejected: protected-path check incomplete: \(reason)")
            return false
        case .indeterminate(let reason):
            let hits = reported.filter(isProtected)
            guard hits.isEmpty else {
                log("repair rejected: it reported editing protected path(s) \(hits.sorted().joined(separator: ", ")) "
                    + "and git could not check them (\(reason))")
                return false
            }
            return true
        }
        let unlisted = reported.subtracting(gitChanged).subtracting(before.dirtyPaths)
        violations.formUnion(unlisted.filter(isProtected))
        guard !violations.isEmpty else { return true }

        // Already-dirty paths keep their earlier (often the user's) edits.
        let revertable = violations.subtracting(before.dirtyPaths).sorted()
        var errors: [String] = []
        let listed = revertable.filter { !unlisted.contains($0) }
        let others = revertable.filter { unlisted.contains($0) }
        if !listed.isEmpty, let error = await scopeGuard.revert(paths: listed, gitRoot: repoRoot) {
            errors.append(error)
        }
        if !others.isEmpty,
           let error = await scopeGuard.revertUnlisted(paths: others, created: created, gitRoot: repoRoot) {
            errors.append(error)
        }
        let note = errors.isEmpty ? "reverted" : "could not revert all of them: \(errors.joined(separator: "; "))"
        log("repair rejected: it edited protected path(s) \(violations.sorted().joined(separator: ", ")) — \(note)")
        return false
    }
}
