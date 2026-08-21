import Foundation

// Split out of AutoCodeUpdateService.swift (which had grown to the largest
// file in the app) — the 7 built-in "pipeline" task bodies (everything that
// isn't one of the 5 prompt-based tasks routed through runCLI(prompt:...) in
// +CLI.swift). Called from runTaskBody(_:resolved:projectId:logDir:) in the
// main file.
// These methods were `private`; Swift's `private` is file-scoped, so moving
// them here without widening would make them uncallable from the main
// file's runTaskBody — see the access-control note at the top of
// AutoCodeUpdateService.swift for why they're `internal` (default) instead.
extension AutoCodeUpdateService {

    // MARK: - Pipeline task bodies

    /// Reduce a list of per-item failure messages into the value to write to
    /// `taskErrors[key]`: `nil` when nothing failed (caller clears the key),
    /// or the failures joined with " · " when at least one did. This is the
    /// shared accumulate-then-surface pattern already used inline in
    /// `runSourceUpdate` and `runReviewMerge`; factored out so the other
    /// pipeline tasks (e.g. `runSourcesToIssue`) can't regress to the old
    /// "clear `taskErrors[key]` unconditionally at the end" form that
    /// silently swallowed partial failures.
    static func taskErrorFromFailures(_ failures: [String]) -> String? {
        failures.isEmpty ? nil : failures.joined(separator: " · ")
    }

    /// Reduce a count of failed issues into the value to write to the
    /// `implementIssues` `taskErrors` key: `nil` when all succeeded (caller
    /// clears the key), or "N issue(s) failed — see log" when at least one
    /// failed. Per-issue failure detail continues to be written to the
    /// `#<n>` keys and the log; this only surfaces the aggregate count to the
    /// UI-visible card key (`AutoCodeView` reads `taskErrors[task.rawValue]`,
    /// never the `#<n>` keys), so a run that fails every issue no longer
    /// flips the card to clean via the old trailing
    /// `taskErrors.removeValue(forKey:)`.
    static func implementIssuesErrorMessage(failedCount: Int) -> String? {
        failedCount > 0 ? "\(failedCount) issue(s) failed — see log" : nil
    }

    /// Pure summary of a regression sweep's verdict list, factored out of
    /// `runRegressionSweep` so the fail-closed verdict accounting is
    /// unit-testable without spinning up the full `RegressionRunner`.
    ///
    /// The non-passing verdict set mirrors `RegressionRunnerSweepAdapter`'s
    /// `SweepOutcome.passed` logic (regressed + repairFailed + needsApproval
    /// + failed + pending): any verdict that isn't `.unchanged` or `.repaired`
    /// means the fault could NOT be confirmed still-fixed, so the sweep must
    /// signal an error rather than report a false green. Before this helper,
    /// `runRegressionSweep` keyed the card off `.regressed` ALONE, so a run
    /// where every fixed fault came back `.failed`/`.needsApproval`/
    /// `.repairFailed`/`.pending` logged "no regressions" and cleared the card.
    struct RegressionSweepSummary: Equatable {
        /// Human-readable line for the task log.
        let logLine: String
        /// True when at least one fault was regressed or could not be verified
        /// — caller sets `taskErrors[.regression]` (flips the card red).
        /// False means all re-verified faults passed (or there were none) —
        /// caller clears `taskErrors[.regression]`.
        let shouldSignalError: Bool
    }

    static func regressionSweepSummary(
        verdicts: [RegressionRunner.Verdict],
        autoReopen: Bool
    ) -> RegressionSweepSummary {
        let total = verdicts.count
        guard total > 0 else {
            return RegressionSweepSummary(
                logLine: "No fixed faults to re-verify.",
                shouldSignalError: false)
        }
        var regressed = 0
        var nonPassing = 0
        // Exhaustive switch (no `default:`) so a future `Verdict` case can't
        // silently fall into "passing" — same stance as
        // `RegressionRunnerSweepAdapter.sweep`.
        for verdict in verdicts {
            switch verdict {
            case .unchanged, .repaired:
                break // passing — confirmed still fixed
            case .regressed:
                regressed += 1
                nonPassing += 1
            case .repairFailed, .needsApproval, .pending, .failed:
                nonPassing += 1
            }
        }
        if regressed > 0 {
            let reopened = autoReopen ? " (auto-reopened)" : ""
            return RegressionSweepSummary(
                logLine: "Regression: \(regressed)/\(total) regressed\(reopened).",
                shouldSignalError: true)
        }
        if nonPassing > 0 {
            // Regressions are zero, but at least one fault couldn't be
            // verified — fail-closed rather than claiming "no regressions".
            return RegressionSweepSummary(
                logLine: "\(nonPassing)/\(total) fault(s) could not be verified — see log.",
                shouldSignalError: true)
        }
        return RegressionSweepSummary(
            logLine: "\(total) faults re-verified — no regressions.",
            shouldSignalError: false)
    }

    /// Fetch configured email/Slack sources into the meeting library.
    func runSourceUpdate() async {
        let key = AutoTask.sourceUpdate.rawValue
        guard let api else {
            taskErrors[key] = "Source update skipped — no API client wired."
            logStore.append(.sourceUpdate, "Skipped — no API client.", level: .error)
            return
        }
        guard let env = environment else {
            taskErrors[key] = "Source update skipped — open a project first."
            logStore.append(.sourceUpdate, "Skipped — no project environment.", level: .error)
            return
        }
        let service = SourceIngestService(
            api: api,
            config: config,
            root: env.notesConfig.currentFolder,
            notesOutputFolder: env.notesOutputFolder,
            indexer: env.indexer)
        var importedTotal = 0
        var failures: [String] = []
        for source in SourceRegistry.fetchSources {
            if Task.isCancelled { break }
            logStore.append(.sourceUpdate, "Fetching \(source.displayName)…")
            switch await service.importSource(id: source.id) {
            case .imported(let n, let more, let oversize):
                importedTotal += n
                var line = "Imported \(n) from \(source.displayName)."
                if more > 0 { line += " \(more) more pending." }
                if oversize > 0 { line += " \(oversize) skipped (too large)." }
                logStore.append(.sourceUpdate, line)
            case .none:
                logStore.append(.sourceUpdate, "No new \(source.displayName) items.")
            case .noSource:
                logStore.append(.sourceUpdate, "\(source.displayName) not configured.")
            case .failure(let msg, let partial):
                if partial > 0 { importedTotal += partial }
                failures.append("\(source.displayName): \(msg)")
                logStore.append(.sourceUpdate, "\(source.displayName) failed: \(msg)", level: .error)
            }
        }
        if importedTotal > 0 {
            logStore.append(.sourceUpdate, "Re-indexed library after import.")
        }
        if failures.isEmpty {
            taskErrors.removeValue(forKey: key)
        } else {
            taskErrors[key] = failures.joined(separator: " · ")
        }
        logStore.append(.sourceUpdate, "— run finished —")
    }

    /// Extract action items from recent notes and create upstream issues.
    func runSourcesToIssue(resolved: ResolvedRepo) async {
        let key = AutoTask.sourcesToIssue.rawValue
        let client = resolved.client
        let autoSteps = Self.allowedAutoSteps(config: config, provider: client.kind)
        guard autoSteps.createIssue else {
            taskErrors[key] = "Issue creation not allowed — enable Create issue in repo allow-list."
            logStore.append(.sourcesToIssue, "Skipped — create issue not allowed.", level: .error)
            return
        }

        let notesFolderURL = NotesFolderConfig().currentFolder
        let indexRoot = projectStore?.activeProject
            .map { URL(fileURLWithPath: $0.localPath) } ?? notesFolderURL
        let indexURL = ProjectLayout(root: indexRoot).indexDB
        let index: MeetingIndex
        do {
            index = try MeetingIndex(url: indexURL)
        } catch {
            taskErrors[key] = "Meeting index unavailable: \(error.localizedDescription)"
            logStore.append(.sourcesToIssue, taskErrors[key]!, level: .error)
            return
        }

        let rows: [MeetingIndex.Row]
        do {
            rows = try index.list()
        } catch {
            taskErrors[key] = "Meeting index read failed: \(error.localizedDescription)"
            logStore.append(.sourcesToIssue, taskErrors[key]!, level: .error)
            return
        }

        let sortedRows = rows.sorted { $0.startedAt > $1.startedAt }
        let recentRows: [MeetingIndex.Row]
        if autoTaskSettings.lookbackByDays {
            let cutoffMs = Self.lookbackCutoffMs(now: Date(), days: autoTaskSettings.lookbackDays)
            recentRows = sortedRows.filter { $0.startedAt >= cutoffMs }
        } else {
            recentRows = Array(sortedRows.prefix(autoTaskSettings.lookbackMeetingCount))
        }

        if recentRows.isEmpty {
            let msg = autoTaskSettings.lookbackByDays
                ? "No notes in the last \(max(1, autoTaskSettings.lookbackDays)) days."
                : "No notes in lookback window."
            logStore.append(.sourcesToIssue, msg)
            taskErrors.removeValue(forKey: key)
            return
        }

        let actions = NoteActionExtractor.extract(from: recentRows, notesRoot: notesFolderURL)
        let newActions = actions.filter { !registry.isKnown(id: $0.id) }
        if newActions.isEmpty {
            logStore.append(.sourcesToIssue, "No new action items to file as issues.")
            taskErrors.removeValue(forKey: key)
            return
        }

        let existingIssues: [RepoIssue]
        do {
            existingIssues = try await fetchAllIssues(client: client, projectId: resolved.projectId)
        } catch {
            taskErrors[key] = "\(client.kind.displayName) error: \(error.localizedDescription)"
            logStore.append(.sourcesToIssue, taskErrors[key]!, level: .error)
            return
        }

        let normalizedExistingTitles = Set(existingIssues.map { NoteActionExtractor.normalize($0.title) })
        var failures: [String] = []
        for action in newActions {
            if Task.isCancelled { break }
            let normalized = NoteActionExtractor.normalize(action.text)
            if normalizedExistingTitles.contains(normalized) {
                registry.register(action: action, issueIid: nil)
                registry.markDone(id: action.id)
                continue
            }
            do {
                let payload = RepoIssuePayload(
                    title: action.text,
                    body: "Action item from meeting: \(action.meetingTitle)"
                )
                let created = try await client.createIssue(projectId: resolved.projectId, payload: payload)
                registry.register(action: action, issueIid: created.number)
                createdCount += 1
                logStore.append(.sourcesToIssue, "Created issue #\(created.number): \(created.title)")
                activity?.report(
                    kind: .issueCreated,
                    title: "Issue created — \(created.title)",
                    detail: ["title": created.title, "number": created.number, "url": created.webUrl],
                    link: created.webUrl
                )
            } catch {
                log.error("Failed to create issue for action \(action.id): \(error)")
                let msg = "Issue \(action.id): \(error.localizedDescription)"
                failures.append(msg)
                logStore.append(.sourcesToIssue, "Failed to create issue: \(error.localizedDescription)", level: .error)
            }
        }
        // Surface partial failures — without this the task card flipped to
        // clean even when every createIssue threw. Mirrors runReviewMerge /
        // runSourceUpdate: set the key when anything failed, clear otherwise.
        if let msg = Self.taskErrorFromFailures(failures) {
            taskErrors[key] = msg
        } else {
            taskErrors.removeValue(forKey: key)
        }
        logStore.append(.sourcesToIssue, "— run finished —")
    }

    /// Run the CLI against pending registry entries (local fix branches).
    func runImplementIssues(resolved: ResolvedRepo, logDir: URL) async {
        let key = AutoTask.implementIssues.rawValue
        let client = resolved.client
        let autoSteps = Self.allowedAutoSteps(config: config, provider: client.kind)
        let capturedGitRoot = resolved.gitRoot

        guard autoSteps.createBranch, autoSteps.autoCommit else {
            log.info("auto_code_skip_implement reason=allowlist provider=\(client.kind.rawValue, privacy: .public)")
            logStore.append(.implementIssues, "Skipped — branch/commit not allowed by repo allow-list.")
            taskErrors[key] = "Implement skipped — enable Create branch + Auto-commit in allow-list."
            return
        }

        let pending = registry.pendingEntries()
        if pending.isEmpty {
            logStore.append(.implementIssues, "No pending issues to implement.")
            taskErrors.removeValue(forKey: key)
            return
        }

        let existingIssues: [RepoIssue]
        do {
            existingIssues = try await fetchAllIssues(client: client, projectId: resolved.projectId)
        } catch {
            taskErrors[key] = "Could not fetch issues: \(error.localizedDescription)"
            logStore.append(.implementIssues, taskErrors[key]!, level: .error)
            return
        }

        let baseBranch = await Task.detached { Self.currentBranch(at: capturedGitRoot) }.value
        let failedBefore = failedCount   // per-run delta (failedCount is cumulative, reset only by a full run())
        for entry in pending {
            if Task.isCancelled { break }
            guard let number = entry.issueIid else { continue }

            let issue: RepoIssue
            if let found = existingIssues.first(where: { $0.number == number }) {
                issue = found
            } else {
                do {
                    issue = try await client.getIssue(projectId: resolved.projectId, number: number)
                } catch {
                    log.error("Failed to fetch issue \(number, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    registry.markFailed(id: entry.actionId)
                    failedCount += 1
                    logStore.append(.implementIssues, "Issue #\(number): fetch failed.", level: .error)
                    continue
                }
            }

            registry.markImplementing(id: entry.actionId)
            logStore.append(.implementIssues, "Implementing issue #\(number)…")

            if let base = baseBranch {
                let switched = await Task.detached { Self.checkout(base, at: capturedGitRoot) }.value
                if !switched {
                    let msg = "Issue #\(number): couldn't switch to base branch \(base)."
                    taskErrors["#\(number)"] = msg
                    logStore.append(.implementIssues, msg, level: .error)
                    registry.markFailed(id: entry.actionId)
                    failedCount += 1
                    continue
                }
            }
            let baseSha = await Task.detached { Self.headSha(at: capturedGitRoot) }.value

            let succeeded = await runCLI(issue: issue, localPath: capturedGitRoot, logDir: logDir)
            let headAfter = await Task.detached { Self.headSha(at: capturedGitRoot) }.value
            let committed = succeeded && headAfter != nil && headAfter != baseSha

            if committed {
                let branchAfter = await Task.detached { Self.currentBranch(at: capturedGitRoot) }.value
                if let base = baseBranch, let baseSha, branchAfter == base {
                    let rescue = "fix/\(number)-auto"
                    _ = await Task.detached {
                        Self.rescueCommitToBranch(rescue, base: base, baseSha: baseSha, at: capturedGitRoot)
                    }.value
                }
                registry.markDone(id: entry.actionId)
                implementedCount += 1
                logStore.append(.implementIssues, "Issue #\(number): fix committed locally on fix branch.")
                if config.isAllowed(.commentIssue, provider: client.kind) {
                    do {
                        _ = try await client.createNote(
                            projectId: resolved.projectId,
                            number: number,
                            body: "A fix branch was prepared locally by Auto Tasks and is awaiting human review before push."
                        )
                    } catch {
                        log.error("Failed to add review note to issue \(number): \(error)")
                    }
                }
            } else {
                if succeeded {
                    taskErrors["#\(number)"] = "Issue #\(number): CLI finished but made no commit."
                    logStore.append(.implementIssues, taskErrors["#\(number)"]!, level: .error)
                }
                registry.markFailed(id: entry.actionId)
                failedCount += 1
            }
        }
        // Surface THIS run's failures to the UI-visible card key. Use the
        // per-run delta, not cumulative `failedCount` (which is reset only by
        // a full `run()` — the cumulative value would leave a stale red card
        // after a successful single-task run). AutoCodeView reads only
        // `taskErrors[task.rawValue]`, never the `#<n>` keys.
        let failedThisRun = failedCount - failedBefore
        if let msg = Self.implementIssuesErrorMessage(failedCount: failedThisRun) {
            taskErrors[key] = msg
        } else {
            taskErrors.removeValue(forKey: key)
        }
        logStore.append(.implementIssues, "— run finished —")
    }

    /// Push local fix/* branches and open MR/PRs. Conservative: never auto-merge.
    func runReviewMerge(resolved: ResolvedRepo) async {
        let key = AutoTask.reviewMerge.rawValue
        let client = resolved.client
        let gitRoot = resolved.gitRoot
        let repoURL = URL(fileURLWithPath: gitRoot)

        guard config.isAllowed(.push, provider: client.kind) else {
            taskErrors[key] = "Push not allowed — enable Push in repo allow-list."
            logStore.append(.reviewMerge, taskErrors[key]!, level: .error)
            return
        }
        guard config.isAllowed(.createPR, provider: client.kind) else {
            taskErrors[key] = "MR/PR creation not allowed — enable Create PR/MR in allow-list."
            logStore.append(.reviewMerge, taskErrors[key]!, level: .error)
            return
        }

        let token = gitPushToken(for: client.kind)
        guard !token.isEmpty else {
            taskErrors[key] = "Missing \(client.kind.displayName) token for push."
            logStore.append(.reviewMerge, taskErrors[key]!, level: .error)
            return
        }

        let branches = await Task.detached { Self.localBranches(prefix: "fix/", at: gitRoot) }.value
        if branches.isEmpty {
            logStore.append(.reviewMerge, "No local fix/* branches to push.")
            taskErrors.removeValue(forKey: key)
            return
        }

        let defaultBranch = await Task.detached { Self.defaultBranch(at: gitRoot) }.value
        let openMRs: [RepoMergeRequest]
        do {
            openMRs = try await client.listOpenMergeRequests(projectId: resolved.projectId)
        } catch {
            taskErrors[key] = "Could not list open MRs: \(error.localizedDescription)"
            logStore.append(.reviewMerge, taskErrors[key]!, level: .error)
            return
        }

        var pushed = 0
        var opened = 0
        var failures: [String] = []
        for branch in branches {
            if Task.isCancelled { break }
            if openMRs.contains(where: { $0.sourceBranch == branch }) {
                logStore.append(.reviewMerge, "Skip \(branch) — MR already open.")
                continue
            }

            do {
                try await repoManager.push(at: repoURL, branch: branch, token: token,
                                           backend: pushBackend(for: client.kind))
                pushed += 1
                logStore.append(.reviewMerge, "Pushed \(branch).")
            } catch {
                let msg = "Push failed for \(branch): \(error.localizedDescription)"
                failures.append(msg)
                logStore.append(.reviewMerge, msg, level: .error)
                continue
            }

            let title: String
            if let num = Self.issueNumber(fromFixBranch: branch) {
                title = "Fix #\(num) (auto task)"
            } else {
                title = branch
            }

            do {
                let payload = RepoMergeRequestPayload(
                    title: title,
                    description: "Auto Tasks pushed branch `\(branch)` for review. Merge manually when ready.",
                    sourceBranch: branch,
                    targetBranch: defaultBranch
                )
                let mr = try await client.createMergeRequest(projectId: resolved.projectId, payload: payload)
                opened += 1
                logStore.append(.reviewMerge, "Opened MR !\(mr.number): \(mr.webUrl)")

                if let num = Self.issueNumber(fromFixBranch: branch),
                   config.isAllowed(.commentIssue, provider: client.kind) {
                    let comment = "Branch `\(branch)` pushed. Merge request: \(mr.webUrl)"
                    _ = try? await client.createNote(projectId: resolved.projectId, number: num, body: comment)
                }
            } catch {
                let msg = "MR creation failed for \(branch): \(error.localizedDescription)"
                failures.append(msg)
                logStore.append(.reviewMerge, msg, level: .error)
            }
        }

        logStore.append(.reviewMerge, "Pushed \(pushed), opened \(opened) MR(s). Human merge required.")
        if failures.isEmpty {
            taskErrors.removeValue(forKey: key)
        } else {
            taskErrors[key] = failures.joined(separator: " · ")
        }
        logStore.append(.reviewMerge, "— run finished —")
    }

    func gitPushToken(for kind: RepoBackendKind) -> String {
        switch kind {
        case .gitlab: return config.gitLabToken
        case .github: return config.gitHubToken
        }
    }

    func pushBackend(for kind: RepoBackendKind) -> RepoManager.Backend {
        switch kind {
        case .gitlab: return .gitlab
        case .github: return .github
        }
    }

    /// True when the user's per-task enable checkbox is on for `task`. Drives
    /// the `enabledOrder` loop in `run()` (per-task manual runs via `runSingle`
    /// ignore this — they run the task regardless).
    func isTaskEnabled(_ task: AutoTask) -> Bool {
        switch task {
        case .sourceUpdate:      return autoTaskSettings.runSourceUpdate
        case .sourcesToIssue:    return autoTaskSettings.runSourcesToIssue
        case .implementIssues:   return autoTaskSettings.runImplementIssues
        case .reviewMerge:       return autoTaskSettings.runReviewMerge
        case .reviewCode:        return autoTaskSettings.runReviewCode
        case .reviewDoc:         return autoTaskSettings.runReviewDoc
        case .reviewConflicts:   return autoTaskSettings.runReviewConflicts
        case .regression:        return autoTaskSettings.runRegression
        case .loopEngineering:   return autoTaskSettings.runLoopEngineering
        case .generateKnowledge: return autoTaskSettings.runGenerateKnowledge
        case .generateDoc:       return autoTaskSettings.runGenerateDoc
        case .updateIssues:      return autoTaskSettings.runUpdateIssues
        case .updatePlanStatus:  return autoTaskSettings.runUpdatePlanStatus
        }
    }

    /// Read-only review row for the Auto Tasks panel: report the current state
    /// of the auto-generated knowledge (code-graph file count + agent-memory
    /// files) for the active project. Generation is automatic (GraphAutoUpdater
    /// + the code index); this only surfaces "what's there" so the user can
    /// review it. Reads disk only — never generates, never blocks.
    func reportKnowledge(projectRoot: String) {
        let key = AutoTask.generateKnowledge.rawValue
        guard let repo = GraphAutoUpdater.repoToGraph(projectRoot: URL(fileURLWithPath: projectRoot)) else {
            logStore.append(.generateKnowledge, "No code to graph in this project yet.")
            taskErrors.removeValue(forKey: key)
            return
        }
        var lines: [String] = ["Repo: \(repo.lastPathComponent)"]
        let graphJSON = ProjectLayout(root: repo).graphDir.appendingPathComponent("graph.json")
        if let data = try? Data(contentsOf: graphJSON),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            let files = (obj["files"] as? [Any])?.count ?? 0
            lines.append("Graph: \(files) files (\(repo.lastPathComponent)/system/graph/graph.json)")
        } else {
            lines.append("Graph: not generated yet — auto-generates on open.")
        }
        let memDir = ProjectLayout(root: repo).memoryDir
        let mem = ((try? FileManager.default.contentsOfDirectory(atPath: memDir.path)) ?? [])
            .filter { $0.hasSuffix(".md") }.sorted()
        lines.append(mem.isEmpty ? "Memory: none yet." : "Memory: \(mem.joined(separator: ", "))")
        for line in lines { logStore.append(.generateKnowledge, line) }
        taskErrors.removeValue(forKey: key)
    }

    /// Drives RegressionRunner once against the active repo. Failure
    /// modes — no API client wired, no local repo, runner throws —
    /// surface in taskErrors so the AutoCodeView card flips the
    /// regression row to ⚠. The runner itself publishes per-fault
    /// progress to its own @Published state; this entry point waits
    /// for the run to finish then records a summary line.
    func runRegressionSweep(projectRoot: String, gitRoot: String) async {
        guard let api else {
            taskErrors[AutoTask.regression.rawValue] = "Regression skipped — no API client wired."
            return
        }
        guard !projectRoot.isEmpty else {
            taskErrors[AutoTask.regression.rawValue] = "Regression skipped — no project root resolved."
            return
        }
        let faultsRoot = URL(fileURLWithPath: projectRoot, isDirectory: true)
        // gitRoot is the cloned working tree where verify commands + git ops
        // run; empty only in degenerate config, in which case command faults
        // are skipped by the runner.
        let gitRootURL = gitRoot.isEmpty ? nil : URL(fileURLWithPath: gitRoot, isDirectory: true)
        let prompter = CodeAssistPrompter(api: api, agent: config.activeCLI)
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api)
        let runner = RegressionRunner(prompter: prompter, judge: judge,
                                      verifier: ShellFaultVerifier(), repairer: repairer,
                                      verifyTimeout: autoTaskSettings.regressionVerifyTimeout, config: config)
        runner.activity = activity
        await runner.run(faultsRoot: faultsRoot, gitRoot: gitRootURL,
                         autoReopen: autoTaskSettings.regressionAutoReopen,
                         attemptRepair: autoTaskSettings.regressionAttemptRepair)
        // RegressionRunner's published `results` lives on its own
        // lifetime — we read once after the await for the summary. The
        // verdict→summary accounting is fail-closed (any non-passing
        // verdict signals an error, not just `.regressed`) and lives in the
        // pure `regressionSweepSummary` helper so it's unit-testable.
        let summary = Self.regressionSweepSummary(
            verdicts: runner.results.map(\.verdict),
            autoReopen: autoTaskSettings.regressionAutoReopen)
        let key = AutoTask.regression.rawValue
        if summary.shouldSignalError {
            taskErrors[key] = summary.logLine
            logStore.append(.regression, summary.logLine, level: .error)
        } else {
            taskErrors.removeValue(forKey: key)
            logStore.append(.regression, summary.logLine)
        }
    }

    /// Loop Engineering sweep: chains Regression -> Test -> any further
    /// configured stages into one multi-iteration loop with auto-fix retry.
    /// Additive to `runRegressionSweep` — does not change its behavior.
    ///
    /// - Parameter projectId: The stable llm-ide `Project.id`, resolved by
    ///   the CALLER at the same time as `resolved` (see `run()`'s
    ///   `projectIdAtResolveTime` and `runOne(_:)`). Deliberately NOT
    ///   re-derived here from `projectStore?.activeProject?.bundle.id` —
    ///   `run()` resolves `resolved` once up front then runs several task
    ///   bodies in sequence with awaits between them, so reading the active
    ///   project fresh at sweep time could pair a DIFFERENT project's
    ///   `LoopEngineConfig` with this call's `gitRoot` if the user switched
    ///   projects mid-batch.
    /// - Parameter defaults: The `UserDefaults` `LoopEngineConfig` is loaded
    ///   from / saved to. Defaults to `.standard` for production; tests pass
    ///   an isolated suite so the persistence branch (auto-detect + save) is
    ///   exercisable without touching the developer's real UserDefaults.
    /// - Parameter onlyStageId: When set, run just this one stage — the
    ///   phone's `loop_start_stage` counterpart to the desktop's "Run this
    ///   stage only". Applied AFTER the config is loaded and
    ///   `ensureDefaultStages` runs, via the same `LoopStage.soloing` mapping
    ///   the desktop uses: the target is force-enabled, every other stage is
    ///   disabled for this run only, and the saved config is untouched. An id
    ///   that matches no stage refuses the run — falling back to the full
    ///   pipeline would silently do far more than the user asked for.
    func runLoopEngineeringSweep(
        projectRoot: String, gitRoot: String, projectId: String?, defaults: UserDefaults = .standard, onlyStageId: String? = nil
    ) async {
        guard let api else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop skipped — no API client wired."
            return
        }
        guard !projectRoot.isEmpty else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop skipped — no project root resolved."
            return
        }
        guard !gitRoot.isEmpty else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop skipped — no git working tree resolved."
            return
        }
        // LoopEngineConfig is keyed by the stable llm-ide Project.id (see the
        // contract documented on LoopEngineConfig.load/save in Task 1) — NOT
        // `projectRoot` (a filesystem path) and NOT `resolved.projectId`
        // (that field is actually the REMOTE repo id — a GitLab numeric id,
        // "owner/name" for GitHub, or `linked.remoteId`; see
        // `attemptResolveBackendAndProject()` in
        // AutoCodeUpdateService+BackendResolution.swift). Using the wrong
        // key here would silently split one project's config in two.
        guard let projectId else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop skipped — no active project."
            return
        }
        let faultsRoot = URL(fileURLWithPath: projectRoot, isDirectory: true)
        let gitRootURL = URL(fileURLWithPath: gitRoot, isDirectory: true)

        // Auto-detection only ever PERSISTS when it found real tooling (any
        // stage beyond the bare Regression sweep every detection includes).
        // `detectDefaultStages` always returns at least Regression, so an
        // all-Regression detection is indistinguishable from "the tree
        // doesn't have test tooling YET" (clone still populating, or a
        // genuinely toolless repo) — saving that as the permanent config
        // would silently and irreversibly turn off the Test stage for every
        // future run. Using it for just THIS run without saving lets a
        // later run (once tooling appears, or once the Task 11 settings UI
        // runs its own one-time auto-detect per `LoopStageDetector`'s doc
        // comment) get a fresh detection attempt instead of being stuck on
        // a stale one-stage config. `LoopEngineConfig.shouldPersist` is the
        // single shared policy for this — `LoopEngineView` and the chat
        // panel's auto-detect path use the exact same helper so all three
        // call sites agree on when it's safe to persist.
        let raw: LoopEngineConfig
        if let saved = LoopEngineConfigStore.load(projectRoot: faultsRoot, projectId: projectId,
                                                  defaults: defaults) {
            raw = saved
        } else {
            let detectedStages = LoopStageDetector.detectDefaultStages(gitRoot: gitRootURL)
            // Same app-wide defaults as the other two entry points — see
            // LoopEngineDefaults.newConfig.
            let detected = LoopEngineDefaults.newConfig(stages: detectedStages)
            if LoopEngineConfig.shouldPersist(detectedStages) {
                LoopEngineConfigStore.save(detected, projectRoot: faultsRoot, projectId: projectId,
                                           defaults: defaults)
            }
            raw = detected
        }
        var projectConfig = LoopStageDetector.ensureDefaultStages(in: raw, gitRoot: gitRootURL)
        if let onlyStageId {
            guard let soloed = LoopStage.soloing(projectConfig.stages, id: onlyStageId) else {
                taskErrors[AutoTask.loopEngineering.rawValue] =
                    "Loop skipped — the requested stage no longer exists."
                logStore.append(.loopEngineering,
                                "Loop skipped — single-stage run asked for a stage that no longer exists.",
                                level: .error)
                return
            }
            projectConfig.stages = soloed
        }

        // A project with every stage disabled is PARKED, not broken — the user
        // switched the stages off deliberately. Skipping quietly here (info
        // log, no taskError) beats letting the runner refuse on every cron
        // tick, which would keep the task banner red and fill the journal
        // with error records for a state the user considers "off".
        let enabledStageCount = projectConfig.stages.filter(\.enabled).count
        guard enabledStageCount > 0 else {
            taskErrors.removeValue(forKey: AutoTask.loopEngineering.rawValue)
            logStore.append(.loopEngineering, "Loop skipped — every stage is disabled for this project.")
            return
        }

        let prompter = CodeAssistPrompter(api: api, agent: config.activeCLI)
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api)
        let regressionRunner = RegressionRunner(prompter: prompter, judge: judge,
                                                verifier: ShellFaultVerifier(), repairer: repairer,
                                                verifyTimeout: autoTaskSettings.regressionVerifyTimeout, config: config)
        // Mirrors runRegressionSweep: without this, the inner Regression
        // stage's per-fault activity reporting is silently dropped.
        regressionRunner.activity = activity
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            skillExecutor: AgentLoopSkillExecutor(api: api),
            // `.autoTask` is the unattended trigger — the journal must be able to
            // tell these runs apart from ones a human watched.
            trigger: .autoTask
        )
        // Mirror every line into the shared per-task log as it happens. Before
        // this the buffer only ever received the TERMINAL line below, so the
        // Auto Tasks page — and the iPhone, which reads the same buffer —
        // showed a loop as "running" with nothing to show for it.
        runner.onLog = { [weak logStore] line in
            logStore?.append(AutoTask.loopEngineering.rawValue, line.text,
                             level: line.level == .error ? .error : .info)
        }
        // run() returns LoopEngineStatus? — nil means this call was rejected
        // (a run is already in progress for this repo, instance- or
        // process-wide). Use the RETURN VALUE, not runner.status, which per
        // its doc comment is only meaningful when run() returns non-nil.
        let result = await runner.run(config: projectConfig, faultsRoot: faultsRoot,
                                      gitRoot: gitRootURL, projectId: projectId)

        switch result {
        case .success:
            taskErrors.removeValue(forKey: AutoTask.loopEngineering.rawValue)
            // Enabled count only — the runner skips disabled stages, and "all
            // N passed" quoting the full list would claim coverage from
            // stages the user switched off.
            let skippedNote = enabledStageCount < projectConfig.stages.count
                ? " (\(projectConfig.stages.count - enabledStageCount) disabled stage(s) skipped)" : ""
            logStore.append(.loopEngineering, "Loop finished — all \(enabledStageCount) enabled stage(s) passed after \(runner.iteration) iteration(s)\(skippedNote).")
        case .givenUp:
            // `.summary` (not raw `GivenUpReason` interpolation, which
            // renders as e.g. "maxIterations") so this message and the
            // activity-feed title below never drift apart for the same run.
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop \(result?.summary ?? "gave up")."
            logStore.append(.loopEngineering, "Stopped after \(runner.iteration) iteration(s) — \(result?.summary ?? "gave up").", level: .error)
        case .blocked:
            // A repair edited a protected path (a test, a build file, the
            // project's system/ state). Distinct from `.givenUp`: the agent did
            // not fail to fix this, it tried something it is not allowed to do —
            // so this surfaces as an error a human should read, never as a
            // near-miss the next cron tick might get past.
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop \(result?.summary ?? "blocked")."
            logStore.append(.loopEngineering,
                            "Stopped after \(runner.iteration) iteration(s) — \(result?.summary ?? "blocked").",
                            level: .error)
        case .needsApproval(let stageName):
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop needs approval for stage \"\(stageName)\"."
            logStore.append(.loopEngineering, "Stopped — stage \"\(stageName)\" needs approval on the Loop page.", level: .error)
        case .error(let message):
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop error: \(message)"
            logStore.append(.loopEngineering, "Error: \(message)", level: .error)
        case .aborted:
            // `TaskLogStore.Level` has no `.warn` case (only `.info`/`.error`);
            // `.error` matches how `LoopEngineRunner.logLevel(for:)` itself
            // treats every non-`.success` terminal status, aborted included.
            logStore.append(.loopEngineering, "Run aborted.", level: .error)
        case nil:
            // Rejected — a run is already in progress for this repo elsewhere
            // (e.g. the user started one from the chat panel or the Loop
            // Engineering page). Leave any existing taskErrors entry as-is.
            logStore.append(.loopEngineering, "Skipped — a Loop run is already in progress for this repo.")
            return
        }
        activity?.report(
            kind: .loopEngineeringDone,
            title: "Loop complete — \(result.map(\.summary) ?? "unknown")",
            detail: ["iterations": runner.iteration],
            link: ShellState.Section.loopEngine.rawValue
        )
    }

    /// Refreshes plan task statuses from external outcome trackers (GitHub/GitLab/Linear/Backlog).
    /// Calls the /kb/outcomes/refresh endpoint which polls all configured providers and
    /// persists updated statuses. Success/failure is surfaced via taskErrors.
    func refreshPlanStatuses(projectRoot: String) async {
        let key = AutoTask.updatePlanStatus.rawValue
        guard let api else {
            taskErrors[key] = "Plan status refresh skipped — no API client wired."
            return
        }
        guard !projectRoot.isEmpty else {
            taskErrors[key] = "Plan status refresh skipped — no project root resolved."
            return
        }

        do {
            // The refresh endpoint polls all providers and persists results server-side.
            // We only get a summary back, not per-task details.
            let summary = try await api.refreshOutcomes(taskIds: [])

            let total = summary.pollCount
            let changed = summary.changedCount
            let errored = summary.pollErroredCount

            if total == 0 {
                logStore.append(.updatePlanStatus, "No dispatched plan tasks found — nothing to refresh.")
            } else if changed > 0 {
                logStore.append(.updatePlanStatus, "Refreshed \(total) plan tasks — \(changed) statuses updated.")
            } else {
                logStore.append(.updatePlanStatus, "Refreshed \(total) plan tasks — no changes.")
            }

            if errored > 0 {
                taskErrors[key] = "Plan status refresh completed with \(errored) poll errors (check provider credentials)."
            } else {
                taskErrors.removeValue(forKey: key)
            }
        } catch {
            taskErrors[key] = "Plan status refresh failed: \(error.localizedDescription)"
        }
    }
}
