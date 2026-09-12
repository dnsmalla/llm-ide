import SwiftUI

extension CodeAssistantPanel {

    /// `planContent` is the SAME resolved body the execute prompt was built
    /// from (`planContentForExecute`), not `payload.planContent` — re-deriving
    /// it here would let the tracker's step list disagree with the step list
    /// the agent was actually told to execute whenever the card carries no
    /// plan text and the body came off the attached file.
    @MainActor
    func beginPlanExecution(messageId: UUID, payload: ChatMessage.ToolResultPayload, planContent content: String) {
        let steps = Self.parsePlanSteps(from: content)
        let title = payload.planTitle ?? Self.planTitle(from: content)
        engine.agent.planExecution = CodeAssistantAgentState.PlanExecutionTracker(
            planTitle: title,
            steps: steps,
            planCardMessageId: messageId
        )
    }

    @MainActor
    func dismissPlanExecution() {
        engine.agent.planExecution = nil
        // Covers the paths `landPlanReview` doesn't: dismissing mid-review,
        // or after one that failed. The patch must not outlive the card.
        attachmentState.attachments.removeAll { $0.path == Self.reviewDiffLabel }
        // The run is over, however it ended — hand the picker back so the
        // next message is classified on its own merits instead of staying an
        // Execute turn forever. See `releaseStickyMode`. `.review` is in the
        // set because the finish card's Review button puts the picker there.
        releaseStickyMode(from: [.execute, .plan, .assistPlan, .review])
    }

    // MARK: - Review

    /// The finish card's "Review" action.
    ///
    /// It used to just open the Source Control section — which shows the
    /// user a file list and leaves the actual question ("is this change
    /// right?") entirely to them. This runs the review instead: resolve the
    /// diff this execution produced, attach it, and fire a Code Review turn
    /// carrying the central `code-review` skill. The verdict lands back on
    /// the tracker (`autoChainPendingAction`) and unlocks Push.
    @MainActor
    func reviewPlanExecutionChanges() async {
        guard let existing = engine.agent.planExecution, existing.reviewPhase != .running else { return }
        // A parked proposal is a write the agent is waiting on — firing a new
        // turn now would abandon it unanswered (same rule as Execute).
        guard engine.agent.pendingTool == nil else {
            attachNotice = "Resolve the pending action card first, then review."
            return
        }
        guard let root = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(root) else {
            engine.error = "Open a git repository to review plan changes."
            return
        }
        // Claim the slot SYNCHRONOUSLY, before the first await: resolving the
        // diff takes several git invocations, and the guard above plus the
        // button's own `disabled` both read this flag — a second click landing
        // in that window would otherwise fire a second review turn.
        engine.agent.planExecution?.reviewPhase = .running

        let diff = await Self.executionDiff(at: root)

        // The card can be dismissed (or the chat switched) while the diff
        // resolves. Re-read rather than writing back the copy captured above,
        // which would resurrect a closed run.
        guard var tracker = engine.agent.planExecution, tracker.reviewPhase == .running else { return }
        guard !diff.patch.isEmpty else {
            tracker.reviewPhase = .none
            engine.agent.planExecution = tracker
            attachNotice = "Nothing to review — no changes against \(diff.baseBranch ?? "HEAD"). "
                + "If the agent committed on a different branch, switch to it first."
            return
        }
        tracker.reviewSummary = ""
        tracker.reviewVerdict = nil
        tracker.reviewBaseBranch = diff.baseBranch
        engine.agent.planExecution = tracker

        // Code Review mode is tool-restricted (no edits, no commands), which
        // is exactly right for a review — and exactly why the diff is
        // ATTACHED rather than left for the agent to fetch: in this mode it
        // could not run `git diff` itself.
        modelState.selectedMode = .review
        var attachments = attachmentState.attachments
        if let idx = attachments.firstIndex(where: { $0.path == Self.reviewDiffLabel }) {
            attachments[idx] = LlmIdeAPIClient.CodeAttachment(
                path: Self.reviewDiffLabel, content: diff.patch)
        } else {
            attachments.append(LlmIdeAPIClient.CodeAttachment(
                path: Self.reviewDiffLabel, content: diff.patch))
        }
        attachmentState.attachments = attachments

        let outgoing = PlanReviewPolicy.reviewMessage(
            planTitle: tracker.planTitle, baseBranch: diff.baseBranch)
        let meta = ChatMessage.Metadata(
            planReviewDisplay: "Review changes: \(tracker.planTitle)")
        // An unknown skill id is ignored server-side (the library reader
        // returns nil for it), so this degrades to the instruction above on
        // an install whose skills kit isn't present.
        if engine.busy {
            engine.enqueue(outgoing, skillIds: [Self.codeReviewSkillId],
                           userMetadata: meta, attachments: attachments)
        } else {
            engine.startTurn(outgoing, skillIds: [Self.codeReviewSkillId],
                             userMetadata: meta, attachments: attachments)
        }
    }

    /// Library id of the central kit's code-review skill (`<family>/<dir>`,
    /// the id shape `listSkillLibrary` mints).
    static let codeReviewSkillId = "skills/code-review"

    /// Attachment label for the resolved diff. A label, not a real path —
    /// nothing on disk holds this text.
    static let reviewDiffLabel = "execution-diff.patch"

    /// Land a finished review turn on the tracker. Called from
    /// `autoChainPendingAction` for the turn `reviewPlanExecutionChanges`
    /// started; a turn that failed or was stopped releases the phase instead
    /// of leaving the button spinning forever.
    @MainActor
    func landPlanReview(reply: ChatMessage) {
        // Unconditional, and BEFORE the guard: `ChatEngine`'s stop/failure
        // path releases `reviewPhase` on its own, so a review that ended that
        // way reaches here already `.none` — and the guard below would return
        // leaving 120k characters of patch attached to the composer, re-sent
        // with every later message in this chat.
        attachmentState.attachments.removeAll { $0.path == Self.reviewDiffLabel }
        guard var tracker = engine.agent.planExecution,
              tracker.reviewPhase == .running else { return }
        guard reply.status == .done, !reply.content.isEmpty else {
            tracker.reviewPhase = .none
            engine.agent.planExecution = tracker
            return
        }
        tracker.reviewPhase = .done
        tracker.reviewSummary = reply.content
        tracker.reviewVerdict = PlanReviewPolicy.verdict(from: reply.content)
        engine.agent.planExecution = tracker
        // The review is over; the picker goes back to Auto so the next thing
        // typed isn't silently a Code Review turn.
        releaseStickyMode(from: [.review])
    }

    /// The change this execution produced, as one patch.
    ///
    /// NOT just `git diff HEAD`: a plan execution usually ends with the agent
    /// having committed its own work, so the working tree is clean and a
    /// working-tree diff would review nothing. The reviewable change is
    /// everything this branch carries that the default branch doesn't
    /// (`<base>...HEAD`) PLUS whatever is still uncommitted PLUS the content
    /// of files that are new — a plan execution's most important output is
    /// usually a file that did not exist before, and listing its name without
    /// its content is reviewing it blind.
    @MainActor
    static func executionDiff(at root: URL) async -> (patch: String, baseBranch: String?) {
        let repo = RepoManager()
        func git(_ args: [String]) async -> String {
            ((try? await repo.runGit(args, at: root)) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let branch = await git(["rev-parse", "--abbrev-ref", "HEAD"])
        // The default branch, by the same first-match-wins rule
        // `RepoManager.resolveDefaultBranch` uses — NOT "whichever of main/
        // master isn't the current branch", which on `main` in a repo with a
        // stale local `master` would diff against unrelated history.
        // Standing ON the default branch there is no `<base>...HEAD` to take.
        var base = await defaultBranch(at: root)
        if base == branch { base = nil }

        // Budgeted per section rather than by truncating the joined string:
        // the committed diff is usually the biggest by far, and a single
        // trailing cut would drop the uncommitted and new-file sections
        // entirely — the parts most likely to be unreviewed work.
        var sections: [String] = []
        if let base {
            let stat = await git(["diff", "--stat", "\(base)...HEAD"])
            let patch = await git(["diff", "\(base)...HEAD"])
            if !patch.isEmpty {
                sections.append("# Committed on `\(branch)` since `\(base)`\n\n\(stat)\n\n"
                                + clamp(patch, to: committedDiffBudget))
            }
        }
        let workingStat = await git(["diff", "--stat", "HEAD"])
        let working = await git(["diff", "HEAD"])
        if !working.isEmpty {
            sections.append("# Uncommitted working-tree changes\n\n\(workingStat)\n\n"
                            + clamp(working, to: workingDiffBudget))
        }
        let untracked = await git(["ls-files", "--others", "--exclude-standard"])
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if !untracked.isEmpty {
            sections.append(newFileSection(untracked, root: root))
        }
        // On the default branch with a clean tree the working diff is the
        // whole story — and if that is empty too, say so with the recent
        // commits rather than sending an empty review.
        if sections.isEmpty, base == nil {
            let log = await git(["log", "--oneline", "-20"])
            if !log.isEmpty {
                sections.append("# Recent commits on `\(branch)` (working tree clean)\n\n\(log)")
            }
        }
        return (sections.joined(separator: "\n\n"), base)
    }

    /// New files, with their content — a file git has never seen produces no
    /// diff, so without this the review sees only a filename.
    @MainActor
    private static func newFileSection(_ paths: [String], root: URL) -> String {
        var body = "# New (untracked) files\n"
        var budget = untrackedBudget
        var omitted: [String] = []
        for path in paths.prefix(maxUntrackedFiles) {
            guard budget > 0,
                  let text = try? String(contentsOf: root.appendingPathComponent(path),
                                         encoding: .utf8)
            else {
                omitted.append(path)
                continue
            }
            let shown = clamp(text, to: budget)
            budget -= shown.count
            body += "\n## \(path)\n\n```\n\(shown)\n```\n"
        }
        if paths.count > maxUntrackedFiles {
            omitted += paths.dropFirst(maxUntrackedFiles)
        }
        if !omitted.isEmpty {
            body += "\n(content not shown — binary, unreadable, or over budget): "
                + omitted.joined(separator: ", ") + "\n"
        }
        return body
    }

    /// Truncate on a line boundary so a patch never ends mid-hunk, and say so.
    private static func clamp(_ text: String, to budget: Int) -> String {
        guard text.count > budget, budget > 0 else { return text }
        let cut = String(text.prefix(budget))
        let onLine = cut.lastIndex(of: "\n").map { String(cut[..<$0]) } ?? cut
        return onLine + "\n\n[truncated — read the rest in Source Control]"
    }

    /// Per-section ceilings. The server caps a prompt at 500k characters and
    /// the diff is only part of one; these leave room for the plan, the skill
    /// and the history, and reserve space for the sections that would
    /// otherwise be crowded out.
    static let committedDiffBudget = 80_000
    static let workingDiffBudget = 30_000
    static let untrackedBudget = 20_000
    static let maxUntrackedFiles = 40

    // MARK: - Push

    /// The finish card's "Push" action: commit anything outstanding,
    /// fast-forward the default branch onto this one, and push it.
    ///
    /// Destructive tier — this is the one action in the chat that reaches
    /// `origin/<default>`. The card's confirmation dialog is the consent;
    /// do not call this without one.
    ///
    /// Deliberately NOT `RepoManager.runGitOp(.merge_to_main)`: `runGitOp`
    /// has no backend parameter and defaults its credential header to GitLab,
    /// so its push fails authentication on every GitHub repo — after the
    /// local merge has already moved the default branch. `SourceControlService`
    /// resolves the backend with the token (`resolveCredentials`), and
    /// respects the repo's operation allow-list.
    @MainActor
    func pushPlanExecutionChanges() async {
        guard let root = config.activeRepoLocalURL, WorkspaceRoot.isGitRepo(root) else {
            engine.error = "Open a git repository to push plan changes."
            return
        }
        let title = engine.agent.planExecution?.planTitle ?? "Plan execution"
        let svc = SourceControlService()
        svc.config = config
        svc.resolveCredentials = { repo in Self.credentials(for: repo, config: config) }
        await svc.refresh(root: root)

        // Commit whatever the agent left behind, so the merge carries it.
        if !svc.state.files.isEmpty {
            guard await svc.commit(root: root, message: "feat: \(title)") else {
                engine.error = svc.state.opError ?? svc.state.error ?? "Commit failed."
                return
            }
        }

        guard let source = svc.state.branch, !source.isEmpty, source != "HEAD" else {
            engine.error = "Not on a branch (detached HEAD) — check out a branch before pushing."
            return
        }

        // Already on the default branch: nothing to merge, so this is a push.
        guard !RepoManager.defaultBranchNames.contains(source) else {
            await svc.push(root: root)
            if let err = svc.state.opError { engine.error = err; return }
            attachNotice = "Pushed \(source)."
            dismissPlanExecution()
            return
        }

        let repo = RepoManager()
        let target = await Self.defaultBranch(at: root) ?? "main"
        do {
            _ = try await repo.runGit(["checkout", target], at: root)
        } catch {
            engine.error = "Couldn't switch to \(target): \(error.localizedDescription)"
            return
        }
        do {
            // Fast-forward ONLY. A default branch that has moved on since
            // this work started needs a human decision (rebase, or a real
            // merge commit), not a silent merge from a finish card.
            _ = try await repo.runGit(["merge", "--ff-only", source], at: root)
        } catch {
            _ = try? await repo.runGit(["checkout", source], at: root)
            await svc.refresh(root: root)
            engine.error = "\(target) has moved on, so \(source) can't fast-forward into it. "
                + "Pull \(target) and rebase \(source) onto it, then push again. "
                + "(Still on \(source); nothing was pushed.)"
            return
        }
        await svc.refresh(root: root)
        await svc.push(root: root)
        let pushError = svc.state.opError
        // Put the checkout back where the user left it either way — a
        // finish-card click must not silently strand them on the default
        // branch, where the next commit would land in the wrong place.
        _ = try? await repo.runGit(["checkout", source], at: root)
        if let pushError {
            engine.error = "Merged \(source) into \(target) locally, but the push failed: "
                + "\(pushError). \(target) is ahead of origin — push it from Source Control. "
                + "(Back on \(source).)"
            return
        }
        attachNotice = "Merged \(source) into \(target) and pushed it. Back on \(source)."
        dismissPlanExecution()
    }

    /// First of `main`/`master` that exists locally — the same rule
    /// `RepoManager.resolveDefaultBranch` applies (which is private).
    @MainActor
    static func defaultBranch(at root: URL) async -> String? {
        let repo = RepoManager()
        for candidate in ["main", "master"] {
            if let out = try? await repo.runGit(["rev-parse", "--verify", "--quiet", candidate], at: root),
               !out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return candidate
            }
        }
        return nil
    }

    /// Token + backend for a repo, by the same rule `runGitOpFlow` and the
    /// Source Control view use (GitLab first, then GitHub).
    static func credentials(for repo: URL, config: AppConfig)
        -> (token: String, backend: RepoManager.Backend)?
    {
        if config.gitLabSavedProjects.contains(where: { $0.localPath == repo.path }),
           !config.gitLabToken.isEmpty {
            return (config.gitLabToken, .gitlab)
        }
        if config.gitHubSavedRepos.contains(where: { $0.localPath == repo.path }),
           !config.gitHubToken.isEmpty {
            return (config.gitHubToken, .github)
        }
        return nil
    }

}
