import SwiftUI
import AppKit

/// What's left of the panel's session file after the turn/session lifecycle
/// moved into `ChatEngine` (Tasks 4-7): the Q&A nudge banner, the confirmers
/// that execute a pending tool and hand the result back to the agent, and the
/// auto-chain executor. Everything here still belongs to the VIEW — it reads
/// panel state (attachments, edit mode, the per-turn auto-op budget) or drives
/// panel-owned services — and reaches the chat through the engine.
extension CodeAssistantPanel {

    /// One-tap escape from "I asked for a plan and got an Execute turn".
    ///
    /// Offered, not applied: `releaseStickyMode` refuses to take back a mode
    /// the user picked, and that rule is what stops a planning chat from
    /// hijacking every later message. This surfaces the mismatch instead of
    /// silently resolving it — the switch is one click, and so is keeping the
    /// mode you chose.
    @ViewBuilder
    func planSwitchBanner() -> some View {
        let t = theme.current
        HStack(spacing: Spacing.sm) {
            Image(systemName: "list.bullet.clipboard")
                .foregroundStyle(t.accent)
            Text("This reads as a planning request, but the mode is \(modelState.selectedMode.label) — it will start working instead of planning.")
                .font(Typography.caption).foregroundStyle(t.text)
                .lineLimit(2).truncationMode(.tail)
            Spacer(minLength: 8)
            Button("Switch to Plan") {
                modelState.selectedMode = .plan
                planSwitchDismissed = true
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            Button("Keep \(modelState.selectedMode.label)") {
                planSwitchDismissed = true
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, 6)
        .background(t.accent.opacity(0.08))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .top)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .bottom)
    }

    @ViewBuilder
    func nudgeBanner(prompt: String) -> some View {
        let t = theme.current
        let count = session.count(for: session.hashForPrompt(prompt))
        HStack(spacing: Spacing.sm) {
            Image(systemName: "sparkles")
                .foregroundStyle(t.accent2)
            Text("You've asked this \(count) times — save the answer to memory?")
                .font(Typography.caption).foregroundStyle(t.text)
                .lineLimit(2).truncationMode(.tail)
            Spacer(minLength: 8)
            if let err = engine.agent.qaSaveError {
                Text(err).font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(1).truncationMode(.tail)
            }
            Button(engine.agent.savingQA ? "Saving…" : "Save") {
                Task { await saveLatestAnswer(forPrompt: prompt) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(engine.agent.savingQA)
            Button("Dismiss") {
                session.dismiss(hash: session.hashForPrompt(prompt))
                engine.agent.nudgePrompt = nil
                engine.agent.qaSaveError = nil
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(engine.agent.savingQA)
        }
        .padding(.horizontal, Spacing.md).padding(.vertical, 6)
        .background(t.accent2.opacity(0.08))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .top)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(t.border), alignment: .bottom)
    }

    /// Find the most recent assistant turn that followed `prompt` and
    /// write it as a QAEntry. Falls back to the last assistant turn
    /// in history when no exact prompt match is found.
    func saveLatestAnswer(forPrompt prompt: String) async {
        guard let repoRoot = activeRepoRoot else {
            engine.agent.qaSaveError = "No active repo."
            return
        }
        engine.agent.savingQA = true
        engine.agent.qaSaveError = nil
        defer { engine.agent.savingQA = false }
        let answer = mostRecentAnswer(forPrompt: prompt) ?? ""
        guard !answer.isEmpty else {
            engine.agent.qaSaveError = "No agent answer found yet."
            return
        }
        let entry = QAEntry(
            question: prompt,
            answer: answer,
            savedAt: Date(),
            askCount: session.count(for: session.hashForPrompt(prompt)),
            agent: config.activeCLI
        )
        let store = config.memoryStore
        do {
            _ = try store.writeQA(at: repoRoot, entry)
            session.dismiss(hash: session.hashForPrompt(prompt))
            engine.agent.nudgePrompt = nil
        } catch {
            engine.agent.qaSaveError = "Couldn't save: \(error.localizedDescription)"
        }
    }

    /// Walk the history in reverse, find the most recent assistant turn that
    /// follows a user turn asking the same question as `prompt`.
    ///
    /// "The same question" is the nudge's OWN definition — `hashForPrompt`,
    /// which lowercases, collapses whitespace and trims trailing punctuation.
    /// Matching on exact string equality here while the counter matched on
    /// the normalised hash meant the two could disagree about the very
    /// question being saved: "How does auth work?" and "how does auth work"
    /// count as one question (so the nudge fires) but only one of them is the
    /// literal `prompt` handed to this method.
    ///
    /// And a miss returns nil rather than "the last assistant turn in the
    /// chat". That fallback wrote whatever the agent happened to say last
    /// into project memory as the answer to this question — a durable,
    /// silent, wrong pairing. `saveLatestAnswer` already reports an empty
    /// answer as "No agent answer found yet", which is the honest outcome.
    func mostRecentAnswer(forPrompt prompt: String) -> String? {
        let history = engine.messages
        let wanted = session.hashForPrompt(prompt)
        guard !wanted.isEmpty else { return nil }
        for i in stride(from: history.count - 1, through: 1, by: -1) {
            let turn = history[i]
            guard turn.role == .assistant, !turn.content.isEmpty else { continue }
            let asked = history[i - 1]
            guard asked.role == .user, session.hashForPrompt(asked.content) == wanted else { continue }
            return turn.content
        }
        return nil
    }

    /// Creates the issue via the resolved backend (GitLab or GitHub) with
    /// the user's edited args. On success, appends a synthetic user turn so
    /// the agent can acknowledge in the next round, and re-POSTs /code-assist.
    @MainActor
    func confirmCreateIssue(_ args: CreateIssueSheet.Args,
                                    target: IssueTarget) async -> CreateIssueSheet.ConfirmResult {
        let client = RepoBackendFactory.backend(for: target.kind, config: config)
        do {
            let payload = RepoIssuePayload(
                title: args.title,
                body: args.description.isEmpty ? nil : args.description,
                labels: args.labels.isEmpty ? nil : args.labels
            )
            let issue = try await client.createIssue(projectId: target.projectId, payload: payload)
            // Clear the pending tool so the card disappears.
            engine.agent.pendingTool = nil
            // Synthetic acknowledgement — agent sees the result in history.
            // RepoIssue.webUrl is backend-correct for both providers.
            let ackPayload = ChatMessage.ToolResultPayload(
                kind: .issue, summary: "(executed create-issue → #\(issue.number) \(issue.webUrl))",
                exitCode: nil, command: nil, output: nil, url: issue.webUrl, isFailure: false)
            // Append the ack BEFORE the refresh below, matching the original
            // ordering (appendTurn was synchronous): the transcript shows the
            // acknowledgement immediately rather than only after
            // recentIssues finishes reloading.
            await engine.acknowledge(ackPayload, followUp: .none)
            // Refresh recentIssues so the newly created issue's title
            // resolves in follow-up comment/update sheets instead of
            // showing blank until the next unrelated refresh.
            await refreshRecentIssuesOnce()
            // Sheet-driven, not the auto-chain path — sendFollowup no-ops if
            // an autonomous turn is still streaming, same as every other
            // sheet confirmer's .ifIdle.
            await engine.sendFollowup()
            return .success(issue.number)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    /// Resolve an agent-supplied path to one of the chat's attachments.
    /// The agent emits absolute paths but the chip stores ~/-prefixed
    /// display paths, so we normalise both sides before comparing.
    /// Returns nil if no match — the caller refuses to write in that
    /// case (defence in depth against the agent emitting a path the
    /// user never attached).
    func matchingAttachment(for proposedPath: String,
                                    allowBasenameFallback: Bool = true)
        -> LlmIdeAPIClient.CodeAttachment?
    {
        // The matching RULES live in ProposedEditResolver so that the resolver
        // (and its tests) are the single definition of "which file did the
        // agent mean"; this wrapper only maps the result back onto the
        // attachment objects the rest of the panel works with.
        guard let known = ProposedEditResolver.matchingAttachment(
            for: proposedPath,
            in: editableAttachments,
            allowBasenameFallback: allowBasenameFallback
        ) else { return nil }
        // Same order as `editableAttachments`, and for the same reason: the
        // match came out of that list, so looking it back up in the composer's
        // chips alone would return nil for every file already sent (they are
        // cleared on send). A nil here reads to callers as "the agent named a
        // file the user never attached" — which would, among other things,
        // drop the truncated-file guard that keeps a whole-file rewrite from
        // auto-applying over content the agent only saw the head of.
        return engine.currentTurnAttachments.first { $0.path == known.path }
            ?? attachmentState.attachments.first { $0.path == known.path }
    }

    /// Writes the user-approved content to disk, then refreshes the
    /// in-memory attachment so subsequent chat turns see the new file.
    /// Append a synthetic ack turn and re-invoke the agent so it can
    /// acknowledge in natural language (matches createIssue flow).
    ///
    /// The target is resolved through `resolveEdit` — an attached file, or any
    /// file inside the open project — so the write lands on the same file the
    /// card and the review sheet described. `finalContent` is what the user
    /// approved (the sheet lets them edit it), NOT `args`, which is why this
    /// re-resolves rather than trusting the caller's path.
    @MainActor
    func confirmUpdateFile(_ args: PendingTool.UpdateFileArgs,
                                   finalContent: String)
        async -> UpdateFileSheet.ConfirmResult
    {
        let edit: ProposedEdit
        switch resolveEdit(args) {
        case .failure(let err): return .failure(err.message)
        case .success(let e): edit = e
        }
        // Write to the resolved path, never the LLM-emitted one: a
        // basename-fallback match or a relative path makes args.path diverge
        // from the real target, and writing the former overwrites the wrong file.
        let absolute = edit.absolutePath
        let url = URL(fileURLWithPath: absolute)
        do {
            try finalContent.write(to: url, atomically: true, encoding: .utf8)
            // Track this file for File → PR automation
            attachmentState.modifiedFiles.insert(edit.displayPath)
        } catch {
            return .failure("Couldn't write \(absolute): \(error.localizedDescription)")
        }
        // Deselect the file now that the update is applied. The user attached it
        // to edit it — that's done — and leaving the (now-written) chip in place
        // just re-sends the whole file on every later turn. Remove only THIS
        // file's chip (other attachments stay), and clear the auto-attach
        // bookkeeping if it was the auto-attached file. Only for an attached
        // target: a workspace file has no chip to retire. `edit` holds a copy of
        // the pre-write content, so the line-delta math below is unaffected.
        if edit.source == .attachment {
            attachmentState.attachments.removeAll { PathUtils.canonicalise($0.path) == absolute }
            // And from the in-flight turn's copy, or the auto-continue turns
            // of this same chain would keep re-sending the PRE-write content
            // of the file that was just written.
            engine.currentTurnAttachments.removeAll { PathUtils.canonicalise($0.path) == absolute }
            if let auto = autoAttachedPath, PathUtils.canonicalise(auto) == absolute {
                autoAttachedPath = nil
            }
        }
        engine.agent.pendingTool = nil

        // Synthetic acknowledgement turn so the agent can react.
        let basename = (absolute as NSString).lastPathComponent
        let oldLineCount = edit.original.components(separatedBy: "\n").count
        let newLineCount = finalContent.components(separatedBy: "\n").count
        let delta = newLineCount - oldLineCount
        let deltaStr = delta == 0
            ? "no net line change"
            : (delta > 0 ? "+\(delta) lines" : "\(delta) lines")
        let payload = ChatMessage.ToolResultPayload(
            kind: .edit, summary: "(applied update to \(basename): \(deltaStr))",
            exitCode: nil, command: nil, output: nil, url: nil, isFailure: false)
        // Can run from INSIDE the auto-chain path (busy still true) — force
        // the follow-up through, as the old unblockAndFollowUp() call here
        // always did.
        await engine.acknowledge(payload, followUp: .forceUnblock)
        return .success
    }

    /// Writes a `save-plan` proposal to `<projectRoot>/llm-doc/plans/`, then
    /// acknowledges so the agent can react. Mirrors `confirmUpdateFile`, with
    /// two differences: there's no sheet-edited content to prefer over the
    /// agent's own (this always saves automatically, so `finalContent` is
    /// just `args.content`), and `llm-doc/plans/` may not exist yet (unlike
    /// an edit target, which is always an existing file) — so the directory
    /// is created first.
    ///
    /// `followUp` defaults to `.forceUnblock` — the legacy loop's caller
    /// (`autoSavePendingPlan`) runs from inside a turn that is actively
    /// waiting on the ack. The v2 message-action path
    /// (`savePlanFromMessage`) passes `.none`: nothing is waiting (the v2
    /// engine's history is server-side and never sees the ack), so a
    /// follow-up round-trip would only produce a confused reply.
    @MainActor
    func confirmSavePlan(_ args: PendingTool.SavePlanArgs,
                                 finalContent: String,
                                 followUp: ChatEngine.FollowUp = .forceUnblock)
        async -> SavePlanResult
    {
        let plan: ProposedPlan
        switch resolvePlan(args) {
        case .failure(let err): return .failure(err.message)
        case .success(let p): plan = p
        }
        let url = URL(fileURLWithPath: plan.absolutePath)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try finalContent.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            return .failure("Couldn't write \(plan.displayPath): \(error.localizedDescription)")
        }
        engine.agent.pendingTool = nil

        // kind .plan (not .edit) so the chat renders the PlanSavedCard —
        // title + markdown preview + Execute/Edit actions. The plan body and
        // title ride on the payload for display only; `legacyContent()` still
        // sends the server just the one-line summary (see ToolResultPayload).
        let payload = ChatMessage.ToolResultPayload(
            kind: .plan, summary: "(saved plan to \(plan.displayPath))",
            exitCode: nil, command: nil, output: nil, url: plan.absolutePath,
            isFailure: false, planTitle: plan.title, planContent: finalContent)
        await engine.acknowledge(payload, followUp: followUp)
        // A plan is on disk, so the planning stage is over. Hand the picker
        // back to Auto (see `releaseStickyMode`) — placed here, the single
        // write every save path funnels through, so the v2 "Save Plan"
        // action, the edit sheet's Save and the legacy `save-plan` proposal
        // all release by the same rule instead of three of them drifting.
        releaseStickyMode()
        return .success
    }

    /// Auto-chain the next pending action (file edit or git op) when the
    /// budget allows. Shared by `runTurn` and `sendFollowup` — both reach it
    /// through the engine's `autoChain` hook — so both see the same
    /// truncated-path data-loss guard. DO NOT re-inline this at either call
    /// site.
    @MainActor
    func autoChainPendingAction(
        _ pendingTool: PendingTool?,
        usage: LlmIdeAPIClient.CodeAssistResponse.Usage?
    ) async {
        // A NEW plan reaches disk only when the user presses Save. The
        // write-phase auto-save that used to sit here belonged to the "Write
        // full plan" button, which no longer exists — the plan is written in
        // the same turn as the design now. The one exception is below: an
        // EXISTING plan file, already saved and already executed, being
        // brought level with code that review changed.
        //
        // Landing: the reply to the update turn IS the rewritten document, so
        // it goes straight back into the same file. Gated on shape, so a turn
        // that answered with a question instead leaves the old plan alone.
        if pendingTool == nil,
           let lastUser = engine.messages.last(where: { $0.role == .user }),
           lastUser.metadata?.planUpdateDisplay != nil,
           let reply = engine.messages.last(where: { $0.role == .assistant }),
           reply.status == .done,
           reply.metadata?.planSaved != true,
           PlanEditPolicy.looksLikePlan(content: reply.content) {
            await savePlanFromMessage(reply)
        }
        // Firing: review asked for changes, and this turn edited a file. The
        // saved plan now describes work that no longer matches the code, so
        // rewrite it. `planUpdateDisplay` on the turn above is what keeps the
        // rewrite from qualifying as its own trigger.
        if pendingTool == nil,
           let reply = engine.messages.last(where: { $0.role == .assistant }),
           reply.status == .done,
           PlanReviewPolicy.updatesPlanAfterFix(
               verdict: engine.agent.planExecution?.reviewVerdict,
               turnChangedCode: reply.toolSteps.contains {
                   PlanReviewPolicy.isCodeChangingTool($0.tool ?? "")
               },
               isPlanUpdateTurn: engine.messages.last(where: { $0.role == .user })?
                   .metadata?.planUpdateDisplay != nil,
               hasPlanFile: sessionPlanPath != nil) {
            updatePlanAfterReviewFix()
        }
        // Review-phase landing. The finish card's Review button fires a Code
        // Review turn stamped `planReviewDisplay`; its reply is the verdict
        // the card shows and the thing that unlocks Push. Same gating shape
        // as the write branch above — only the turn that button started
        // qualifies, and a message typed afterwards resets `lastUser`.
        if pendingTool == nil,
           let lastUser = engine.messages.last(where: { $0.role == .user }),
           lastUser.metadata?.planReviewDisplay != nil,
           let reply = engine.messages.last(where: { $0.role == .assistant }) {
            landPlanReview(reply: reply)
        }
        // Data-loss guard input: if the server CUT this file to fit the
        // prompt, the agent only saw its head — auto-overwriting with the
        // "full" rewrite would silently drop the tail. matchingAttachment
        // uses the same exact-path rule confirmUpdateFile enforces in auto
        // mode. ONLY whole-file (`content`) proposals are at risk: an
        // anchored old_text/new_text edit rewrites just the matched region,
        // so a truncated view of the file can't cost the tail — and
        // refusing those would block auto-edit for exactly the files it is
        // most useful on (the large ones the agent read in slices).
        let updateArgs = pendingTool?.updateFileArgs
        let matchPath = updateArgs.flatMap {
            matchingAttachment(for: $0.path, allowBasenameFallback: false)?.path
        }

        // `autoGitOpsThisTurn`/`maxAutoGitOpsPerTurn` are shared as a general
        // "auto-chained actions this turn" budget across update-file, git-op,
        // and bash auto-chaining — without a shared cap, a large batch of
        // attached files (e.g. 30+ dragged in for a bulk edit) could
        // auto-chain through all of them with no ceiling.
        let decisions = ChatAutoChainPolicy.decide(
            pendingTool: pendingTool,
            editMode: editMode,
            autoOpsUsed: autoGitOpsThisTurn,
            maxAutoOpsPerTurn: Self.maxAutoGitOpsPerTurn,
            truncatedPaths: Set(usage?.truncatedPaths ?? []),
            isWholeFileRewrite: updateArgs?.content != nil,
            matchPath: matchPath,
            shouldAutoRunGitOp: shouldAutoRunGitOp,
            // The same shape test the v2 Save affordance applies — one rule
            // for "is this a plan", whichever engine proposed it.
            savePlanLooksLikePlan: PlanEditPolicy.looksLikePlan(
                content: pendingTool?.savePlanArgs?.content ?? "")
        )

        for decision in decisions {
            switch decision {
            case .autoApplyEdit:
                // Scoped to `update-file` (confirmUpdateFile resolves and
                // guards the target, and leaves the card up if it can't);
                // GitLab actions keep their confirmation.
                guard let args = updateArgs else { continue }
                switch resolveEdit(args) {
                case .success(let edit):
                    autoGitOpsThisTurn += 1
                    _ = await confirmUpdateFile(args, finalContent: edit.proposed)
                case .failure(let err):
                    // Unresolvable (anchor missed, path outside the project, …).
                    // Surface it and leave the card so the user can review,
                    // rather than silently dropping the agent's edit.
                    engine.error = err.message
                }
            case .requireManualReview:
                guard let args = updateArgs,
                      let match = matchingAttachment(for: args.path, allowBasenameFallback: false)
                else { continue }
                let basename = (match.path as NSString).lastPathComponent
                engine.error = "“\(basename)” was too large to send in full, so auto-edit is disabled for it — review the proposed change before applying."
                // Leave pendingTool in place (already stored via finishStreamingTurn) so the card shows.
            case .autoRunGitOp:
                // Otherwise it stays as a pending card for the user to confirm.
                guard let gitOpArgs = pendingTool?.gitOpArgs else { continue }
                autoGitOpsThisTurn += 1
                await runGitOpFlow(gitOpArgs)
            case .autoRunBash:
                // Auto-run a proposed shell command in Bypass mode. Without this,
                // EVERY "run the tests / check the version" request stalled on a
                // card no matter which mode was selected — the agent's prompt
                // steers it to the client-executed `bash` tool, which ends the
                // request, so an untapped card meant the turn simply ended with
                // no answer. runBashCommand still applies
                // BashService.validateCommand plus its own timeout/output caps.
                guard let bashArgs = pendingTool?.bashArgs else { continue }
                autoGitOpsThisTurn += 1
                await runBashCommand(bashArgs)
            case .autoSavePlan:
                // Not counted against autoGitOpsThisTurn: that budget exists to
                // cap actions which could each touch a different file; save-plan
                // always writes the same one, so it isn't the risk that budget
                // guards against.
                await autoSavePendingPlan()
            case .none:
                break
            }
        }
    }

    func loadLanguage() async {
        do {
            let p = try await api.getUserPrefs()
            prefLanguage = p.language ?? "en"
        } catch {
            prefLanguage = "en"
        }
    }

}
