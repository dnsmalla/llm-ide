import Foundation

/// What the runner asks for when a run ends. The concrete coordinator needs the
/// app config (tokens, the repo allow-list), which the runner deliberately does
/// not know — so the runner holds this seam and tests substitute a fake.
@MainActor
protocol LoopChangeShipping {
    /// The paths git already reports as modified BEFORE the run's first stage —
    /// the user's own work in progress. nil when git could not say.
    func baseline(gitRoot: URL) async -> Set<String>?

    /// Preconditions: `record` is the finished run's record (not yet journaled),
    /// `gitRoot` its working tree, `baseline` what `baseline(gitRoot:)` returned
    /// when the run began.
    /// Postconditions: returns nil when there is nothing to do (the run did not
    /// succeed, opening requests is off, or no file is left modified); otherwise
    /// what happened. Never throws; never touches the checkout (HEAD, index,
    /// working tree, local branches) or the default branch.
    func ship(record: LoopRunRecord, config: LoopEngineConfig, gitRoot: URL,
              ranInWorktree: Bool, baseline: Set<String>?) async -> LoopShipment?
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
    /// is not listed by git and so is not shipped. In `among`'s order, no duplicates.
    static func shippablePaths(entries: [ShipPlanning.StatusEntry], among changed: [String]) -> [String] {
        let wanted = Set(changed)
        var seen = Set<String>()
        var out: [String] = []
        for entry in entries where entry.allPaths.contains(where: wanted.contains) {
            for path in entry.allPaths where seen.insert(path).inserted { out.append(path) }
        }
        return out
    }

    /// Files the user was already editing when the run began that the run also
    /// changed. Their working-tree content is the user's work PLUS the repair, and
    /// a request made from it would publish the user's work.
    static func overlap(files: [String], baseline: Set<String>) -> [String] {
        files.filter(baseline.contains)
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

    func baseline(gitRoot: URL) async -> Set<String>? {
        guard let raw = try? await repo.runGit(["status", "--porcelain", "-z"], at: gitRoot,
                                               environment: ["GIT_LITERAL_PATHSPECS": "1"]) else { return nil }
        return Set(ShipPlanning.statusEntries(porcelainZ: raw).flatMap(\.allPaths))
    }

    func ship(record: LoopRunRecord, config loopConfig: LoopEngineConfig, gitRoot: URL,
              ranInWorktree: Bool, baseline: Set<String>?) async -> LoopShipment? {
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
            raw = try await repo.runGit(["status", "--porcelain", "-z", "--"] + changed, at: gitRoot,
                                        environment: ["GIT_LITERAL_PATHSPECS": "1"])
        } catch {
            return LoopShipment(status: .failed,
                                summary: "Merge request not created: could not read git status — \(error.localizedDescription)")
        }
        let files = LoopShipPlanning.shippablePaths(entries: ShipPlanning.statusEntries(porcelainZ: raw), among: changed)
        guard !files.isEmpty else { return nil }

        // The user's own work in progress must never ride along in the request.
        guard let baseline else {
            return LoopShipment(status: .skipped,
                                summary: "No merge request: git could not say which files were already modified before the run, so its changes were left for you to review")
        }
        let mixed = LoopShipPlanning.overlap(files: files, baseline: baseline)
        if !mixed.isEmpty {
            return LoopShipment(status: .skipped, summary: "No merge request: \(mixed.prefix(3).joined(separator: ", ")) already had your uncommitted changes before the run, so a request would publish them — review and commit by hand")
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
