import SwiftUI
import AppKit

/// What's left of the panel's session file after the turn/session lifecycle
/// moved into `ChatEngine` (Tasks 4-7): the Q&A nudge banner, the confirmers
/// that execute a pending tool and hand the result back to the agent, and the
/// auto-chain executor. Everything here still belongs to the VIEW — it reads
/// panel state (attachments, edit mode, the per-turn auto-op budget) or drives
/// panel-owned services — and reaches the chat through the engine.
extension CodeAssistantPanel {

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

    /// Walk the history in reverse, find the most recent assistant
    /// turn that follows a user turn whose content matches `prompt`.
    /// Falls back to the latest assistant turn if no exact match.
    func mostRecentAnswer(forPrompt prompt: String) -> String? {
        let history = engine.messages
        for i in stride(from: history.count - 1, through: 0, by: -1) {
            let t = history[i]
            if t.role == .assistant {
                if i > 0 && history[i - 1].role == .user && history[i - 1].content == prompt {
                    return t.content
                }
            }
        }
        return history.last(where: { $0.role == .assistant })?.content
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
        return attachmentState.attachments.first { $0.path == known.path }
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
    @MainActor
    func confirmSavePlan(_ args: PendingTool.SavePlanArgs,
                                 finalContent: String)
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

        let payload = ChatMessage.ToolResultPayload(
            kind: .edit, summary: "(saved plan to \(plan.displayPath))",
            exitCode: nil, command: nil, output: nil, url: nil, isFailure: false)
        await engine.acknowledge(payload, followUp: .forceUnblock)
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
            shouldAutoRunGitOp: shouldAutoRunGitOp
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
