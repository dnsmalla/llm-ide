import Foundation

/// What was modified when the run began: the user's own work in progress.
struct LoopShipBaseline: Equatable {
    /// Tracked files git reports as modified, deleted, renamed or staged.
    var tracked: Set<String>
    /// Untracked, non-ignored files, each one listed (never a collapsed directory).
    var untracked: Set<String>
}

/// What the runner asks for when a run ends. The concrete coordinator needs the
/// app config (tokens, the repo allow-list), which the runner deliberately does
/// not know — so the runner holds this seam and tests substitute a fake.
@MainActor
protocol LoopChangeShipping {
    /// The paths git reports as modified (tracked changes AND untracked files,
    /// every file listed, never a collapsed directory) BEFORE the run's first stage
    /// — the user's own work in progress. nil when git could not say.
    func baseline(gitRoot: URL) async -> LoopShipBaseline?

    /// Preconditions: `record` is the finished run's record (not yet journaled),
    /// `gitRoot` its working tree, `baseline` what `baseline(gitRoot:)` returned
    /// when the run began.
    /// Postconditions: returns nil when there is nothing to do (the run did not
    /// succeed, opening requests is off, or no file is left modified); otherwise
    /// what happened. Never throws; never touches the checkout (HEAD, index,
    /// working tree, local branches) or the default branch.
    func ship(record: LoopRunRecord, config: LoopEngineConfig, gitRoot: URL,
              ranInWorktree: Bool, baseline: LoopShipBaseline?) async -> LoopShipment?
}

/// The decisions behind shipping a run, separated from the I/O so they can be
/// tested without a repository.
enum LoopShipPlanning {
    enum Decision: Equatable {
        /// Nothing to report: not a successful run, or the loop opted out.
        case notApplicable
        /// Deliberately not shipped; the reason is shown.
        case skip(reason: String)
        case ship
    }

    static func decide(statusCode: String, openMergeRequest: Bool, ranInWorktree: Bool,
                       touchedProtectedPath: Bool) -> Decision {
        guard statusCode == LoopEngineStatus.success.code, openMergeRequest else { return .notApplicable }
        if ranInWorktree {
            return .skip(reason: "this run used an isolated worktree, which keeps its changes for review")
        }
        if touchedProtectedPath {
            return .skip(reason: "a repair edited a protected path and the edit was left in place — review it by hand")
        }
        return .ship
    }

    /// Every path a repair or skill stage changed in this run, in first-seen
    /// order, without duplicates.
    static func changedPaths(in record: LoopRunRecord) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for iteration in record.iterations {
            for attempt in iteration.attempts {
                for path in attempt.changedPaths where seen.insert(path).inserted {
                    // Repo-relative only: an absolute or `..` path is outside the working
                    // tree (a notes folder), and `git status` would refuse it.
                    guard !path.hasPrefix("/"), !path.hasPrefix("../"), path != ".." else { continue }
                    out.append(path)
                }
            }
        }
        return out
    }

    /// True when a repair touched a protected path and the edit stayed (policy
    /// `warn` / `stop`). Such a run must not be shipped on its own authority.
    static func touchedProtectedPath(in record: LoopRunRecord) -> Bool {
        record.iterations.contains { $0.attempts.contains { $0.scopeVerdict == .violated } }
    }

    /// The paths to ship: those of `entries` (from `git status`) that this run
    /// changed — a rename contributes both names, so the old file's deletion is
    /// committed with the new file. A change already committed, or reverted since,
    /// is not listed by git and so is not shipped. A generated artifact (coverage
    /// data, caches, byte-code) that a re-run of the tests rewrote is left out. In
    /// `among`'s order, no duplicates.
    static func shippablePaths(entries: [ShipPlanning.StatusEntry], among changed: [String]) -> [String] {
        let wanted = Set(changed)
        var seen = Set<String>()
        var out: [String] = []
        for entry in entries where entry.allPaths.contains(where: wanted.contains) {
            if entry.isUntracked && ShipPlanning.isGeneratedArtifact(entry.path) { continue }
            for path in entry.allPaths where seen.insert(path).inserted { out.append(path) }
        }
        return out
    }

    /// Why a run's changes cannot be shipped given what was modified before it began, or nil.
    ///
    /// Only TRACKED modifications block: a repair that edits a file the user was already
    /// changing would ship half a fix (the run attributes only the files that became dirty),
    /// and the user's own work must never ride along in a push. Untracked files do NOT
    /// block — a virtual environment or a test artifact is untracked and owned by nobody —
    /// unless the run changed one of them, because then the file's content is the user's
    /// plus the repair's.
    static func baselineProblem(_ baseline: LoopShipBaseline?, files: [String]) -> String? {
        guard let baseline else {
            return "git could not say what was modified before the run, so its changes were left for you to review"
        }
        if !baseline.tracked.isEmpty {
            let shown = baseline.tracked.sorted().prefix(3).joined(separator: ", ")
            return "your working tree had uncommitted changes when the run began (\(shown)\(baseline.tracked.count > 3 ? ", …" : "")), so its changes were left for you to review. If these are the changes from an earlier merge request, discard them with git restore once it is merged; otherwise commit or stash them. A request is only made from a clean start"
        }
        let mixed = files.filter(baseline.untracked.contains)
        if !mixed.isEmpty {
            return "\(mixed.prefix(3).joined(separator: ", ")) was an untracked file of yours before the run and the run changed it, so a request would publish your own content — review it by hand"
        }
        return nil
    }

    /// TRACKED files that are modified now but that no repair accounts for. Since a run
    /// only ships from a tree that was clean when it began, such a change was made by
    /// something else while the run was going — most likely the user. (Untracked files
    /// are not counted: only attributed paths are ever shipped, so an unrelated new file
    /// cannot enter a request, and test artifacts would otherwise block every run.)
    static func foreignTrackedChanges(entries: [ShipPlanning.StatusEntry], attributed: Set<String>) -> [String] {
        entries.filter { entry in
            !entry.isUntracked && !entry.allPaths.contains(where: attributed.contains)
        }.map(\.path)
    }

    private static func oneLine(_ text: String) -> String {
        text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    }

    static func commitMessage(loopName: String, fileCount: Int, runId: String) -> String {
        let name = oneLine(loopName).isEmpty ? "loop" : oneLine(loopName)
        return "fix: loop \(name) repairs (\(fileCount) file\(fileCount == 1 ? "" : "s"))\n\nProduced by the \(name) loop in LLM-IDE (run \(runId)).\nReview before merging."
    }

    static func title(loopName: String, fileCount: Int) -> String {
        let name = oneLine(loopName).isEmpty ? "loop" : oneLine(loopName)
        return "Loop “\(name)”: repairs to \(fileCount) file\(fileCount == 1 ? "" : "s")"
    }

    /// The request's description. Stage names, outcomes and counts only — never
    /// stage output, which can carry paths, tokens or other things that should
    /// not be copied into a merge request.
    static func description(record: LoopRunRecord, files: [String]) -> String {
        let name = oneLine(record.loopName ?? "loop")
        var lines: [String] = []
        lines.append("Opened automatically by the **\(name)** loop in LLM-IDE after a successful run. Nothing was merged — review the changes before merging.")
        lines.append("")
        lines.append("- Run: `\(record.id)`")
        lines.append("- Result: \(record.statusSummary) after \(record.iterationsUsed) iteration\(record.iterationsUsed == 1 ? "" : "s") in \(Int(record.durationSeconds.rounded())) s")

        // The last attempt of each stage is its final word.
        var finalByStage: [(name: String, passed: Bool, repaired: Bool)] = []
        var indexByStage: [String: Int] = [:]
        var repairs = 0
        for iteration in record.iterations {
            for attempt in iteration.attempts {
                if attempt.repairAttempted { repairs += 1 }
                if let index = indexByStage[attempt.stageId] {
                    finalByStage[index] = (attempt.stageName, attempt.passed, finalByStage[index].repaired || attempt.repairAttempted)
                } else {
                    indexByStage[attempt.stageId] = finalByStage.count
                    finalByStage.append((attempt.stageName, attempt.passed, attempt.repairAttempted))
                }
            }
        }
        lines.append("- Repair attempts: \(repairs)")
        if !finalByStage.isEmpty {
            lines.append("")
            lines.append("### Stages")
            for stage in finalByStage {
                lines.append("- \(stage.passed ? "✅" : "❌") \(oneLine(stage.name))\(stage.repaired ? " (repaired)" : "")")
            }
        }
        lines.append("")
        lines.append("### Files changed (\(files.count))")
        for path in files.prefix(50) { lines.append("- `\(path)`") }
        if files.count > 50 { lines.append("- … and \(files.count - 50) more") }
        lines.append("")
        lines.append("> The working tree on the machine that ran the loop still holds these changes, uncommitted. Before pulling the merged result there, discard them (`git restore -- <these files>`), or git will refuse to overwrite them.")
        return String(lines.joined(separator: "\n").prefix(6_000))
    }
}

/// Ships a successful run's edits through `ChangeShipping`.
@MainActor
final class LoopShipCoordinator: LoopChangeShipping {
    private let config: AppConfig
    private let repo: RepoManager

    init(config: AppConfig, repo: RepoManager? = nil) {
        self.config = config
        self.repo = repo ?? RepoManager()
    }

    func baseline(gitRoot: URL) async -> LoopShipBaseline? {
        guard let raw = try? await repo.runGit(["status", "--porcelain", "-z", "--untracked-files=all"], at: gitRoot,
                                               environment: ["GIT_LITERAL_PATHSPECS": "1"]) else { return nil }
        let entries = ShipPlanning.statusEntries(porcelainZ: raw)
        return LoopShipBaseline(
            tracked: Set(entries.filter { !$0.isUntracked }.flatMap(\.allPaths)),
            untracked: Set(entries.filter(\.isUntracked).map(\.path)))
    }

    func ship(record: LoopRunRecord, config loopConfig: LoopEngineConfig, gitRoot: URL,
              ranInWorktree: Bool, baseline: LoopShipBaseline?) async -> LoopShipment? {
        switch LoopShipPlanning.decide(
            statusCode: record.statusCode, openMergeRequest: loopConfig.openMergeRequest,
            ranInWorktree: ranInWorktree,
            touchedProtectedPath: LoopShipPlanning.touchedProtectedPath(in: record)) {
        case .notApplicable:
            return nil
        case .skip(let reason):
            return LoopShipment(status: .skipped, summary: "No merge request: \(reason)")
        case .ship:
            break
        }

        let changed = LoopShipPlanning.changedPaths(in: record)
        guard !changed.isEmpty else { return nil }
        let raw: String
        do {
            raw = try await repo.runGit(["status", "--porcelain", "-z", "--untracked-files=all"], at: gitRoot,
                                        environment: ["GIT_LITERAL_PATHSPECS": "1"])
        } catch {
            return LoopShipment(status: .failed,
                                summary: "Merge request not created: could not read git status — \(error.localizedDescription)")
        }
        let entries = ShipPlanning.statusEntries(porcelainZ: raw)
        let files = LoopShipPlanning.shippablePaths(entries: entries, among: changed)
        guard !files.isEmpty else { return nil }

        // A request is only made from a tree whose TRACKED files were clean when the run began.
        if let problem = LoopShipPlanning.baselineProblem(baseline, files: files) {
            return LoopShipment(status: .skipped, summary: "No merge request: \(problem)")
        }
        // …and nothing else may have changed while it ran (a file the user edited meanwhile).
        let attributed = Set(changed).union(files)
        let foreign = LoopShipPlanning.foreignTrackedChanges(entries: entries, attributed: attributed)
        if !foreign.isEmpty {
            return LoopShipment(status: .skipped, summary: "No merge request: \(foreign.prefix(3).joined(separator: ", ")) changed during the run and no repair accounts for it — it may be your own edit, so nothing was pushed")
        }

        switch ChangeShippingFactory.make(for: gitRoot, config: config) {
        case .unavailable(let reason):
            return LoopShipment(status: .skipped, summary: "No merge request: \(reason)")
        case .available(let shipper):
            let name = record.loopName ?? "loop"
            let outcome = await shipper.ship(ShipRequest(
                gitRoot: gitRoot, paths: files,
                branchPrefix: ShipPlanning.branchPrefix(for: name),
                commitMessage: LoopShipPlanning.commitMessage(loopName: name, fileCount: files.count, runId: record.id),
                title: LoopShipPlanning.title(loopName: name, fileCount: files.count),
                description: LoopShipPlanning.description(record: record, files: files)))
            switch outcome {
            case .shipped(let branch, let url, _):
                return LoopShipment(status: .shipped, summary: outcome.summary,
                                    mergeRequestURL: url, branch: branch, files: files)
            case .skipped:
                return LoopShipment(status: .skipped, summary: outcome.summary)
            case .failed:
                return LoopShipment(status: .failed, summary: outcome.summary)
            }
        }
    }
}
