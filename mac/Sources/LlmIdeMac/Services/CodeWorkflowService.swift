import Foundation
import os.log

/// Orchestrates the full GitLab code-change workflow:
/// create issue → create branch → AI-generate changes → commit → push → create MR → post comment.
@MainActor
final class CodeWorkflowService: ObservableObject {

    // MARK: - Step model

    enum Step: Int, CaseIterable, Identifiable {
        case issue = 0, branch, generate, review, push, done
        var id: Int { rawValue }

        var title: String {
            switch self {
            case .issue:    return "Create Issue"
            case .branch:   return "Create Branch"
            case .generate: return "Generate Changes"
            case .review:   return "Review & Commit"
            case .push:     return "Push & MR"
            case .done:     return "Done"
            }
        }
        var icon: String {
            switch self {
            case .issue:    return "tag"
            case .branch:   return "arrow.triangle.branch"
            case .generate: return "wand.and.stars"
            case .review:   return "doc.text.magnifyingglass"
            case .push:     return "icloud.and.arrow.up"
            case .done:     return "checkmark.circle.fill"
            }
        }
    }

    // MARK: - Published state

    @Published var currentStep: Step = .issue
    @Published var busy = false
    @Published var stepError: String?
    /// Non-error informational message for the current step (e.g. CLI
    /// determined no changes were needed). Rendered as a neutral banner,
    /// not the red error one.
    @Published var stepInfo: String?

    // Issue step
    @Published var issueTitle = ""
    @Published var issueDescription = ""
    @Published var createdIssue: RepoIssue?

    // Branch step
    @Published var branchName = ""

    // Generate step
    @Published var aiPrompt = ""
    @Published var generatedDiff = ""
    @Published var diffFiles: [DiffFile] = []

    // Review step — user edits commit message + optional refinement prompt
    @Published var commitMessage = ""
    /// User-supplied refinement instructions used by `regenerateWithRefinement`
    /// to ask the CLI for additional / corrected edits without leaving the
    /// Review step.
    @Published var refinementPrompt = ""

    // Push step
    @Published var createdMR: RepoMergeRequest?
    @Published var mrTitle = ""
    @Published var mrDescription = ""

    // Live CLI progress (used by Generate step + Quick Fix sheet)
    @Published var cliElapsedSeconds: Int = 0
    @Published var cliLogTail: String = ""
    @Published private(set) var currentCliProcess: Process? = nil
    /// Tracks the current poll Task so re-runs can cancel the old one
    /// instead of letting two tasks race for the same @Published state.
    private var pollTask: Task<Void, Never>? = nil
    /// Tracks the final-tail clear Task so a fresh run can supersede it.
    private var clearTask: Task<Void, Never>? = nil

    // Final state reported on the Done step
    @Published var issueClosedSuccessfully: Bool = false
    private var doneCloseFired = false

    // MARK: - Dependencies

    /// Backend-neutral dependencies. `backend` routes issue/branch/MR calls to
    /// GitLab or GitHub; the local-clone fields (`localURL`, `defaultBranch`)
    /// are the git state the workflow needs and that `RepoProject` doesn't
    /// carry, so they're passed explicitly by the construction site.
    let backend: RepoBackend
    /// Backend project id — numeric string for GitLab, "owner/name" for GitHub.
    let projectId: String
    let localURL: URL
    let defaultBranch: String
    let projectDisplayName: String
    /// Push-auth token provider (GitLab PAT / GitHub PAT), resolved lazily by
    /// the construction site so a token change is picked up at push time.
    private let gitPushToken: () -> String
    private let repo: RepoManager
    private let api: LlmIdeAPIClient
    private let log = Logger(subsystem: "com.llmide.macapp", category: "CodeWorkflowService")

    /// Activity feed store. Set by the presenting view after init
    /// (mirrors the `weak var config` pattern on `RegressionRunner`).
    weak var activity: ActivityStore?

    // MARK: - Init

    init(backend: RepoBackend,
         projectId: String,
         localURL: URL,
         defaultBranch: String,
         displayName: String,
         gitPushToken: @escaping () -> String,
         api: LlmIdeAPIClient) {
        self.backend = backend
        self.projectId = projectId
        self.localURL = localURL
        self.defaultBranch = defaultBranch
        self.projectDisplayName = displayName
        self.gitPushToken = gitPushToken
        self.repo = RepoManager()
        self.api = api
    }

    /// Map the issue/MR backend onto the git push-auth backend so the HTTPS
    /// push uses the right credential header (GitLab PRIVATE-TOKEN vs GitHub
    /// Basic x-access-token).
    private var pushBackend: RepoManager.Backend {
        switch backend.kind {
        case .gitlab: return .gitlab
        case .github: return .github
        }
    }

    // MARK: - Bootstrap from existing issue

    /// Pre-load state from an existing issue (skipping the Create-Issue step).
    /// Used when the chat agent emits `trigger-review-code` for an already-filed issue.
    func bootstrapFromExistingIssue(number: Int, plan: String) async {
        busy = true; stepError = nil
        defer { busy = false }
        do {
            let issue = try await backend.getIssue(projectId: projectId, number: number)
            createdIssue = issue
            issueTitle = issue.title
            issueDescription = issue.body ?? ""
            let slug = RepoManager.branchName(issueIid: issue.number, title: issue.title)
            branchName = slug
            commitMessage = "fix: \(issue.title) (closes #\(issue.number))"
            mrTitle = issue.title
            mrDescription = "Closes #\(issue.number)\n\n\(plan)"
            aiPrompt = plan
            log.info("bootstrap_from_issue number=\(issue.number, privacy: .public)")
            currentStep = .branch
        } catch {
            stepError = "Failed to load issue #\(number): \(error.localizedDescription)"
        }
    }

    // MARK: - Step 1: Create Issue

    func createIssue() async {
        busy = true; stepError = nil
        defer { busy = false }
        do {
            let payload = RepoIssuePayload(
                title: issueTitle.trimmingCharacters(in: .whitespacesAndNewlines),
                body: issueDescription.isEmpty ? nil : issueDescription
            )
            let issue = try await backend.createIssue(projectId: projectId, payload: payload)
            createdIssue = issue
            // Pre-fill derived fields for subsequent steps
            let slug = RepoManager.branchName(issueIid: issue.number, title: issue.title)
            branchName = slug
            commitMessage = "fix: \(issue.title) (closes #\(issue.number))"
            mrTitle = issue.title
            mrDescription = "Closes #\(issue.number)\n\n\(issueDescription)"
            aiPrompt = "Implement the following in the linked repo:\n\n\(issue.title)\n\n\(issueDescription)"
            log.info("issue_created number=\(issue.number, privacy: .public)")
            activity?.report(
                kind: .issueCreated,
                title: "Issue created — \(issue.title)",
                detail: ["title": issue.title, "number": issue.number, "url": issue.webUrl],
                link: issue.webUrl
            )
            advance()
        } catch {
            stepError = error.localizedDescription
        }
    }

    // MARK: - Step 2: Create Branch

    func createBranch() async {
        guard let issue = createdIssue else {
            stepError = "Missing issue context."
            return
        }
        let base = defaultBranch
        busy = true; stepError = nil
        defer { busy = false }
        do {
            // Remote branch via the backend API. createBranch is idempotent:
            // it returns false when the branch already existed (re-running the
            // workflow on the same issue) so we reuse it instead of failing.
            let created = try await backend.createBranch(projectId: projectId, name: branchName, ref: base)
            // Local checkout
            if created {
                try await repo.createAndCheckout(branch: branchName, at: localURL, from: base)
            } else {
                log.info("branch_reused_remote name=\(self.branchName, privacy: .public)")
                try await repo.checkoutExisting(branch: branchName, at: localURL)
            }
            log.info("branch_ready name=\(self.branchName, privacy: .public) issue=\(issue.number, privacy: .public) reused=\(!created, privacy: .public)")
            advance()
        } catch {
            stepError = error.localizedDescription
        }
    }

    // MARK: - Step 3: Generate Changes
    //
    // Spawns the configured AI CLI (claude / gh copilot / ...) in the
    // repo's cwd so it can use its native Read/Write/Edit tools to
    // modify files in place. We then read `git diff` to surface the
    // changes for the Review step. This is the SAME pattern as
    // AutoCodeUpdateService.runCLI — the chat-agent /code-assist path
    // is intentionally Q&A-only and has no file-edit tools.

    func generateChanges(activeCLI: String) async {
        let repoURL = localURL
        busy = true; stepError = nil; stepInfo = nil
        defer { busy = false }

        // 1. Resolve CLI
        let cliTool = AICliTool(rawValue: activeCLI) ?? .claudeCode
        let cliCommand = cliTool.cliExecutable
        let components = cliCommand.split(separator: " ").map(String.init)
        guard let executable = components.first else {
            stepError = "No AI CLI configured. Set one in Settings → AI."
            return
        }

        // 2. Set up log file under Application Support
        let logDir: URL
        do {
            let base = try FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true)
            logDir = base
                .appendingPathComponent("LLM IDE", isDirectory: true)
                .appendingPathComponent("code-workflow-logs", isDirectory: true)
            try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        } catch {
            stepError = "Failed to create log dir: \(error.localizedDescription)"
            return
        }
        let issueNum = createdIssue?.number ?? 0
        let logURL = logDir.appendingPathComponent(
            "code-workflow-\(issueNum)-\(Int(Date().timeIntervalSince1970)).log")
        let created = FileManager.default.createFile(atPath: logURL.path, contents: nil)
        log.info("workflow_generate_start issue=\(issueNum, privacy: .public) cli=\(cliTool.rawValue, privacy: .public) log_path=\(logURL.path, privacy: .public) log_created=\(created, privacy: .public)")

        // 3. Build process
        let process = Process()
        if executable.hasPrefix("/") {
            process.executableURL = URL(fileURLWithPath: executable)
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        }
        var args: [String] = []
        if process.executableURL?.path == "/usr/bin/env" {
            args.append(executable)
        }
        args += components.dropFirst()
        // --permission-mode acceptEdits: never block on interactive
        // permission prompts (the CLI would otherwise wait forever on
        // stdin we never feed). Pair with /dev/null stdin so even an
        // unexpected prompt can't hang the workflow.
        if cliTool == .claudeCode {
            args += ["--permission-mode", "acceptEdits"]
        }
        // Wrap the user's plan with an imperative preamble so the CLI
        // doesn't slip into chat / planning mode (asking what to do,
        // offering /loop or brainstorming workflows). The CLI sees a
        // plain plan and would otherwise hedge: "I see the plan but no
        // explicit ask attached — what would you like me to do?"
        let wrapped = """
        EXECUTE the plan below against the repository in your current working directory.

        Hard rules:
        - You are NOT in conversation mode. Do NOT ask clarifying questions.
        - Do NOT respond with a meta-plan or workflow suggestions (no /loop, no brainstorming).
        - Use your Read/Write/Edit/Bash tools to make the file changes directly NOW.
        - If something is ambiguous, make a reasonable choice and proceed.
        - Do NOT run `git commit` or `git push` — the caller handles those after reviewing your diff.
        - When you are done editing, stop. Do not write a closing summary.

        --- PLAN ---
        \(aiPrompt)
        """
        args += ["-p", wrapped]
        process.arguments = args
        process.currentDirectoryURL = repoURL

        let logFileHandle: FileHandle?
        do {
            logFileHandle = try FileHandle(forWritingTo: logURL)
            log.info("workflow_log_handle_opened")
        } catch {
            logFileHandle = nil
            log.error("workflow_log_handle_failed err=\(error.localizedDescription, privacy: .public) — output will be lost but CLI continues")
        }
        defer { logFileHandle?.closeFile() }
        if let fh = logFileHandle {
            process.standardOutput = fh
            process.standardError = fh
        } else {
            // Without a log handle we'd inherit the parent's stdout, which
            // can pollute the launchd-managed stream. Redirect to /dev/null
            // so the CLI output silently drops instead of leaking.
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
        }
        process.standardInput = FileHandle.nullDevice

        // 4. Await with 10-minute timeout
        let timeout: TimeInterval = 600
        let runLog = self.log
        // Reset progress state for this run
        self.cliElapsedSeconds = 0
        self.cliLogTail = ""
        let startedAt = Date()
        let progressLogURL = logURL
        let exitOk: Bool = await withCheckedContinuation { continuation in
            let resumed = OSAllocatedUnfairLock(initialState: false)

            process.terminationHandler = { p in
                let already = resumed.withLock { state -> Bool in
                    if state { return true }
                    state = true
                    return false
                }
                guard !already else {
                    runLog.warning("workflow_cli_term_handler_after_resume pid=\(p.processIdentifier, privacy: .public)")
                    return
                }
                runLog.info("workflow_cli_exited pid=\(p.processIdentifier, privacy: .public) status=\(p.terminationStatus, privacy: .public) reason=\(p.terminationReason.rawValue, privacy: .public)")
                continuation.resume(returning: p.terminationStatus == 0)
            }

            do {
                try process.run()
                runLog.info("workflow_cli_spawned pid=\(process.processIdentifier, privacy: .public)")
                Task { @MainActor [weak self] in
                    self?.currentCliProcess = process
                }
                // Cancel any stale poll task from a previous run so the
                // OLD one can't keep writing to @Published state after
                // we reset it for this run.
                self.pollTask?.cancel()
                self.clearTask?.cancel()
                // Live progress poll: every 1s update elapsed + log tail
                // until the process exits (or task is cancelled).
                self.pollTask = Task { @MainActor [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                        if Task.isCancelled { return }
                        guard let self else { return }
                        if !process.isRunning { return }
                        self.cliElapsedSeconds = Int(Date().timeIntervalSince(startedAt))
                        if let body = try? String(contentsOf: progressLogURL, encoding: .utf8) {
                            self.cliLogTail = String(body.suffix(1500))
                        }
                    }
                }
            } catch {
                runLog.error("workflow_cli_spawn_failed err=\(error.localizedDescription, privacy: .public)")
                let already = resumed.withLock { state -> Bool in
                    if state { return true }
                    state = true
                    return false
                }
                if !already {
                    continuation.resume(returning: false)
                }
                return
            }

            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak process] in
                let already = resumed.withLock { state -> Bool in
                    if state { return true }
                    state = true
                    return false
                }
                guard !already else { return }
                runLog.warning("workflow_cli_watchdog_fired pid=\(process?.processIdentifier ?? -1, privacy: .public)")
                process?.terminate()
                continuation.resume(returning: false)
            }
        }
        log.info("workflow_cli_await_returned exit_ok=\(exitOk, privacy: .public)")
        // Final tail update so users see the last lines before we clear.
        if let body = try? String(contentsOf: progressLogURL, encoding: .utf8) {
            self.cliLogTail = String(body.suffix(1500))
            self.cliElapsedSeconds = Int(Date().timeIntervalSince(startedAt))
        }
        self.currentCliProcess = nil
        self.pollTask?.cancel()
        self.pollTask = nil
        // Keep final tail/elapsed visible for ~2s, then clear so the
        // sheet's spinner+progress block tears down cleanly. Tracked so
        // a fresh run can cancel this before it wipes new state.
        self.clearTask?.cancel()
        self.clearTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
            guard let self else { return }
            if self.currentCliProcess == nil {
                self.cliElapsedSeconds = 0
                self.cliLogTail = ""
            }
        }

        // 5. Read post-CLI diff regardless of exit code (some CLIs report
        //    non-zero when there's nothing to do; we let the diff be the
        //    ground truth)
        let diff = (try? await repo.diff(at: repoURL)) ?? ""
        generatedDiff = diff
        diffFiles = Self.parseDiffFiles(diff)
        log.info("changes_generated files=\(self.diffFiles.count, privacy: .public) cli_exit_ok=\(exitOk, privacy: .public)")

        if diffFiles.isEmpty {
            let logBody = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
            let tail = String(logBody.suffix(800))
            // Three buckets for empty-diff outcomes:
            // 1. CLI asked a clarifying question → not actionable, user
            //    needs to rewrite the plan
            // 2. CLI explicitly said the work was already done / no
            //    changes needed → benign info, NOT an error
            // 3. Anything else with no diff → genuine failure (probably
            //    the CLI errored or crashed silently)
            let asksQuestion = tail.range(of: #"\?\s*$"#, options: .regularExpression) != nil
                || tail.range(of: "would you like", options: .caseInsensitive) != nil
                || tail.range(of: "which would you", options: .caseInsensitive) != nil
            let alreadyDone = tail.range(of: "no file edits to make", options: .caseInsensitive) != nil
                || tail.range(of: "no changes needed", options: .caseInsensitive) != nil
                || tail.range(of: "nothing to change", options: .caseInsensitive) != nil
                || tail.range(of: "already (done|implemented|applied|in place)", options: .regularExpression) != nil
            if alreadyDone {
                // Stay on the Generate step so the user can either
                // refine the plan and re-run, or accept and skip ahead.
                // The sheet renders a "Skip to Done" affordance whenever
                // stepInfo is set on the .generate step.
                stepInfo = "The AI CLI determined the changes are already in place — no new file edits to make. You can refine the plan above and click Generate again, or skip ahead and mark this workflow done.\n\nCLI conclusion:\n\(tail)"
                return
            }
            if asksQuestion {
                stepError = "The AI CLI asked a clarifying question instead of editing files. Make the plan more specific (concrete files, exact behaviour) and try again.\n\nCLI output:\n\(tail)"
            } else {
                stepError = "AI CLI produced no file changes. Last log output:\n\(tail)"
            }
            return
        }
        advance()
    }

    // MARK: - End-to-end runner (Quick Fix mode)

    /// Runs the full pipeline sequentially: createBranch → generateChanges
    /// → commitChanges → pushAndCreateMR. Each step bails on `stepError`.
    /// Caller must have already supplied an issue context — either by
    /// `bootstrapFromExistingIssue` or `createIssue`.
    func runEndToEnd(activeCLI: String) async {
        guard createdIssue != nil else {
            stepError = "Quick Fix needs an issue. Bootstrap from an existing issue or create one first."
            return
        }
        // Branch step (skip if already on the right branch — repo
        // operations are idempotent in this codepath via reuse logic).
        if currentStep.rawValue <= Step.branch.rawValue {
            currentStep = .branch
            await createBranch()
            if stepError != nil { return }
        }
        // Generate
        currentStep = .generate
        await generateChanges(activeCLI: activeCLI)
        if stepError != nil { return }
        if diffFiles.isEmpty {
            // Either "already done" (stepInfo set) or an empty result —
            // either way, jump to done so the caller surfaces the right
            // banner. No commit/push possible without a diff.
            currentStep = .done
            await closeIssueIfNeeded()
            return
        }
        // Commit
        currentStep = .review
        await commitChanges()
        if stepError != nil { return }
        // Push & MR
        currentStep = .push
        await pushAndCreateMR()
        if stepError != nil { return }
        currentStep = .done
        await closeIssueIfNeeded()
    }

    // MARK: - Cancel a running CLI invocation

    /// Sends SIGTERM to the running CLI, escalating to SIGKILL after 1s
    /// if the process hasn't exited. Safe to call when no process is
    /// running (no-op).
    func cancelCli() {
        guard let proc = currentCliProcess, proc.isRunning else { return }
        log.warning("workflow_cli_cancel_requested pid=\(proc.processIdentifier, privacy: .public)")
        proc.terminate()
        // After 1s, SIGKILL if still running. We don't resume the
        // continuation here — terminationHandler will fire when the
        // OS reaps the process (immediately on SIGKILL). This keeps a
        // single source of truth for resumption and avoids fighting
        // the resumed-lock dance.
        Task.detached { [weak proc] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if let p = proc, p.isRunning {
                kill(p.processIdentifier, SIGKILL)
            }
        }
        // Stop the elapsed/log poll right away so the UI snaps back to
        // a non-spinning state even before the kernel reaps the child.
        pollTask?.cancel()
        pollTask = nil
    }

    // MARK: - Skip to Done (used when the CLI says no changes are needed)
    //
    // Used from the Generate step when the CLI reports the work is
    // already in place. Closes the GitLab issue (if not closed already)
    // and jumps to the terminal Done step so the workflow is wrapped up
    // properly.

    func skipToDone() async {
        currentStep = .done
        await closeIssueIfNeeded()
    }

    // MARK: - Step 3b: Regenerate with refinement (from the Review step)
    //
    // Lets the user iterate on the CLI's output without leaving the
    // Review step: type additional instructions, click Regenerate, the
    // CLI runs again in the same branch with the original plan + the
    // refinement + a summary of what's already been changed so it can
    // build on (or correct) the existing diff. After it returns we
    // refresh `generatedDiff` / `diffFiles` from `git diff`.

    func regenerateWithRefinement(activeCLI: String) async {
        guard !refinementPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            stepError = "Type a refinement instruction first."
            return
        }
        // Compose the new plan: original plan + summary of current diff
        // (so the CLI knows what's already been done) + refinement.
        let existingDiffTail = String(generatedDiff.suffix(4000))
        let composed: String
        if existingDiffTail.isEmpty {
            composed = """
            \(aiPrompt)

            --- ADDITIONAL INSTRUCTIONS ---
            \(refinementPrompt)
            """
        } else {
            composed = """
            \(aiPrompt)

            --- WORK ALREADY DONE (current uncommitted diff) ---
            \(existingDiffTail)

            --- ADDITIONAL INSTRUCTIONS (apply on top of the above) ---
            \(refinementPrompt)
            """
        }
        // Snapshot step + prompt so generateChanges' advance() and
        // prompt-swap don't leak past this call.
        let savedPrompt = aiPrompt
        let savedStep = currentStep
        aiPrompt = composed
        // Temporarily roll the step back to .generate so when
        // generateChanges calls advance() at the end, currentStep
        // lands at .review (where we started).
        currentStep = .generate
        await generateChanges(activeCLI: activeCLI)
        aiPrompt = savedPrompt
        refinementPrompt = ""
        // If generateChanges advanced normally we're at .review; if it
        // bailed early with a stepError, we may still be at .generate.
        // Either way, keep the user at .review so they can see the new
        // diff + error banner together without losing their place.
        if currentStep != .review {
            currentStep = savedStep
        }
    }

    // MARK: - Step 4: Commit (after user reviews)

    func commitChanges() async {
        let repoURL = localURL
        busy = true; stepError = nil
        defer { busy = false }
        do {
            // Write AI-generated files to disk if parseable
            for file in diffFiles where file.isNew {
                try repo.write(content: file.newContent, to: file.path, in: repoURL)
            }
            try await repo.stageAll(at: repoURL)
            let msg = commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !msg.isEmpty else { stepError = "Commit message cannot be empty."; return }
            try await repo.commit(at: repoURL, message: msg)
            log.info("changes_committed")
            advance()
        } catch {
            stepError = error.localizedDescription
        }
    }

    // MARK: - Step 5b: Retry MR only (when push succeeded but MR creation failed)
    //
    // pushAndCreateMR is one big do-block, so a network blip on the
    // createMergeRequest call leaves the branch pushed and no MR. A
    // naive retry re-runs push (no-op, OK) but the user still has to
    // manually re-trigger. This method skips the push entirely and
    // only does MR creation + comment + issue close — safe to call
    // multiple times because listMergeRequests detects an existing MR.

    func retryMROnly() async {
        guard let issue = createdIssue else {
            stepError = "Missing context for retry."
            return
        }
        busy = true; stepError = nil
        defer { busy = false }
        do {
            // If an MR/PR already exists for this branch, adopt it instead
            // of trying to create a duplicate (both backends reject one).
            let openMRs = try await backend.listOpenMergeRequests(projectId: projectId)
            let existingForBranch = openMRs.first { $0.sourceBranch == branchName }
            let mr: RepoMergeRequest
            if let found = existingForBranch {
                mr = found
                log.info("mr_reused number=\(found.number, privacy: .public)")
            } else {
                let mrPayload = RepoMergeRequestPayload(
                    title: mrTitle.trimmingCharacters(in: .whitespacesAndNewlines),
                    description: mrDescription.isEmpty ? nil : mrDescription,
                    sourceBranch: branchName,
                    targetBranch: defaultBranch
                )
                mr = try await backend.createMergeRequest(projectId: projectId, payload: mrPayload)
                log.info("mr_created_on_retry number=\(mr.number, privacy: .public)")
            }
            createdMR = mr
            let comment = """
            Branch `\(branchName)` pushed. Merge request: \(mr.webUrl)

            Changes applied by LLM IDE AI assistant.
            """
            _ = try? await backend.createNote(projectId: projectId, number: issue.number, body: comment)
            advance()
        } catch {
            stepError = error.localizedDescription
        }
    }

    // MARK: - Step 5: Push & Create MR

    func pushAndCreateMR() async {
        guard let issue = createdIssue else {
            stepError = "Missing context for push."
            return
        }
        let token = gitPushToken()
        busy = true; stepError = nil
        defer { busy = false }
        do {
            try await repo.push(at: localURL, branch: branchName, token: token, backend: pushBackend)

            let mrPayload = RepoMergeRequestPayload(
                title: mrTitle.trimmingCharacters(in: .whitespacesAndNewlines),
                description: mrDescription.isEmpty ? nil : mrDescription,
                sourceBranch: branchName,
                targetBranch: defaultBranch
            )
            let mr = try await backend.createMergeRequest(projectId: projectId, payload: mrPayload)
            createdMR = mr

            // Post summary comment on the issue
            let comment = """
            Branch `\(branchName)` pushed. Merge request: \(mr.webUrl)

            Changes applied by LLM IDE AI assistant.
            """
            _ = try await backend.createNote(projectId: projectId, number: issue.number, body: comment)
            // Close the source issue now that work is committed and an
            // MR is in review. The MR's "Closes #N" line also auto-closes
            // on merge, but users want the issue out of the open queue
            // immediately so it isn't surfaced for re-execution. Failure
            // here is non-fatal — the workflow still advances.
            do {
                let closePayload = RepoIssuePayload(title: issue.title, stateChange: .close)
                _ = try await backend.updateIssue(projectId: projectId, number: issue.number, payload: closePayload)
                log.info("issue_closed number=\(issue.number, privacy: .public)")
            } catch {
                log.warning("issue_close_failed number=\(issue.number, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            }
            log.info("mr_created number=\(mr.number, privacy: .public)")
            advance()
        } catch {
            stepError = error.localizedDescription
        }
    }

    // MARK: - Helpers

    private func advance() {
        guard let next = Step(rawValue: currentStep.rawValue + 1) else { return }
        currentStep = next
        if next == .done {
            Task { await closeIssueIfNeeded() }
        }
    }

    /// Idempotent issue close. Fires at most once per service instance.
    /// Reads current state from GitLab; closes only if state == "opened".
    /// Non-fatal — logs warning on failure. Updates
    /// `issueClosedSuccessfully` for the Done card pill.
    func closeIssueIfNeeded() async {
        guard !doneCloseFired else { return }
        doneCloseFired = true
        guard let issue = createdIssue else { return }
        do {
            let current = try await backend.getIssue(projectId: projectId, number: issue.number)
            if current.state == "opened" {
                let payload = RepoIssuePayload(title: current.title, stateChange: .close)
                _ = try await backend.updateIssue(projectId: projectId, number: issue.number, payload: payload)
                log.info("issue_closed_on_done number=\(issue.number, privacy: .public)")
            } else {
                log.info("issue_already_closed_on_done number=\(issue.number, privacy: .public) state=\(current.state, privacy: .public)")
            }
            issueClosedSuccessfully = true
        } catch {
            log.warning("issue_close_on_done_failed number=\(issue.number, privacy: .public) err=\(error.localizedDescription, privacy: .public)")
            issueClosedSuccessfully = false
        }
    }

    // MARK: - Diff parsing

    struct DiffFile: Identifiable {
        let id = UUID()
        let path: String
        let isNew: Bool
        let newContent: String
        let rawDiff: String
    }

    private static func parseDiffFiles(_ diff: String) -> [DiffFile] {
        var files: [DiffFile] = []
        let chunks = diff.components(separatedBy: "\n--- ")
        for chunk in chunks.dropFirst() {
            let lines = chunk.components(separatedBy: "\n")
            guard lines.count > 1 else { continue }
            let aLine = lines[0]   // "a/<path>" or "/dev/null"
            let bLine = lines.first(where: { $0.hasPrefix("+++ b/") }) ?? ""
            let path = String(bLine.dropFirst(6))
            guard !path.isEmpty else { continue }
            let isNew = aLine.contains("/dev/null")

            // Reconstruct file content from + lines
            let contentLines = lines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }
                .map { String($0.dropFirst()) }
            let content = contentLines.joined(separator: "\n")

            files.append(DiffFile(path: path, isNew: isNew, newContent: content, rawDiff: "--- \(chunk)"))
        }
        return files
    }
}

// MARK: - Token accessor shim
extension GitLabClient {
    /// Expose the token for RepoManager push auth.
    static func currentToken() throws -> String {
        let t = AppConfig.shared.gitLabToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { throw GitLabError.notConfigured }
        return t
    }
}

extension GitHubClient {
    /// GitHub counterpart of the push-auth token accessor. The PAT doubles
    /// as the HTTPS push credential (https://x-access-token:<pat>@github.com).
    static func currentToken() throws -> String {
        let t = AppConfig.shared.gitHubToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { throw GitHubError.notConfigured }
        return t
    }
}
