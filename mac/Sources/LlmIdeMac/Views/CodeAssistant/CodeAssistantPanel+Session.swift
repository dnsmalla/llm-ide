import SwiftUI
import AppKit

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
            if let err = agent.qaSaveError {
                Text(err).font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(1).truncationMode(.tail)
            }
            Button(agent.savingQA ? "Saving…" : "Save") {
                Task { await saveLatestAnswer(forPrompt: prompt) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(agent.savingQA)
            Button("Dismiss") {
                session.dismiss(hash: session.hashForPrompt(prompt))
                agent.nudgePrompt = nil
                agent.qaSaveError = nil
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(agent.savingQA)
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
            agent.qaSaveError = "No active repo."
            return
        }
        agent.savingQA = true
        agent.qaSaveError = nil
        defer { agent.savingQA = false }
        let answer = mostRecentAnswer(forPrompt: prompt) ?? ""
        guard !answer.isEmpty else {
            agent.qaSaveError = "No agent answer found yet."
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
            agent.nudgePrompt = nil
        } catch {
            agent.qaSaveError = "Couldn't save: \(error.localizedDescription)"
        }
    }

    /// Walk the history in reverse, find the most recent assistant
    /// turn that follows a user turn whose content matches `prompt`.
    /// Falls back to the latest assistant turn if no exact match.
    func mostRecentAnswer(forPrompt prompt: String) -> String? {
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

    /// Launch a turn as an unstructured Task whose handle Stop can cancel.
    func startTurn(_ message: String, skillIds: [String] = []) {
        runTask = Task { await runTurn(message, skillIds: skillIds) }
    }

    /// Cancel the in-flight turn. URLSession.data(for:) throws on cancellation,
    /// so the network request is actually aborted; runTurn treats that as a
    /// clean stop (no error bubble) and then drains any queued message.
    func stop() {
        runTask?.cancel()
    }

    /// Run one user turn end-to-end. On completion it drains `queued` (if any)
    /// as a FRESH task — an unstructured `Task {}` does NOT inherit the current
    /// task's cancellation, so a stopped turn still lets the queued message run.
    func runTurn(_ message: String, skillIds: [String] = []) async {
        _ = session.record(prompt: message)
        if session.shouldNudge(for: message) {
            agent.nudgePrompt = message
        }
        // Append the user turn FIRST so the message appears immediately
        // even if the network call is slow.
        history.append(.init(role: .user, content: message))
        busy = true
        statusText = ""
        error = nil
        // Clear any stale pending-tool card from a prior turn the user ignored —
        // otherwise it stays interactive against the old args while a new turn runs.
        agent.pendingTool = nil
        // Same reasoning for a finished plan's checklist: without this, a prior
        // turn's completed/failed task list stays in agentPendingTasks and
        // (since PlanTimelineCard pins to the latest assistant turn) would
        // visibly attach to this NEW, unrelated turn if its response happens
        // not to include a fresh `tasks` field.
        agent.agentPendingTasks = []
        // Fresh budget of auto-run git ops for this user turn (commit→push→… ).
        autoGitOpsThisTurn = 0
        // Captured once, fixed for this whole invocation, and declared
        // OUTSIDE the do block below so every catch clause can compare
        // against it directly — re-reading the global `revealingTurnID`
        // inside a catch would pick up whatever turn is CURRENTLY
        // streaming, not the one this call started, if a stale/delayed
        // catch fires after a session switch started a newer turn.
        let streamingID = beginStreamingTurn()
        do {
            // Replay as much of the conversation as fits (see
            // historyForRequest); the server applies its own prompt-aware
            // budget on top.
            let recent = historyForRequest(history)
            // Stream so the user sees live progress ("Searching the web…",
            // "Writing the answer…") instead of a frozen spinner for the
            // 60–90s an agent turn can take. Falls back to buffered on a
            // stream failure (see codeAssistRoundTrip).
            let resp = try await codeAssistRoundTrip(
                message: message,
                history: Array(recent.dropLast()),  // exclude the just-pushed user turn — server appends it
                attachments: attachmentState.attachments,
                skills: skillIds,
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) },
            )
            // If Stop fired during the await, don't append the (now-unwanted) reply.
            try Task.checkCancellation()
            // If the buffered fallback path fired (no chunk events ever
            // arrived), the placeholder turn is still empty — fill it from
            // the complete reply now. If chunks DID arrive, history[idx]
            // already holds the complete text and this is a no-op overwrite
            // with the same value.
            if let idx = history.firstIndex(where: { $0.id == streamingID }) {
                history[idx].content = resp.reply
            }
            finishStreamingTurn(
                streamingID,
                pendingTool: resp.pendingTool,
                tasks: resp.tasks,
                continueNeeded: resp.continueNeeded,
                usage: resp.usage,
                mode: resp.mode,
                stopped: false,
            )
            // Only the primary turn's chain check runs here — the follow-up
            // turn's own chain check (inside sendFollowup) covers every step
            // after this one, so an agent that keeps proposing edits can't loop.
            await autoChainPendingAction(resp.pendingTool, usage: resp.usage)
        } catch {
            // Stopped-by-user (CancellationError, or URLError.cancelled from
            // URLSession) leaves the partial streamed text (if any) in place,
            // tagged as stopped, with no error banner. A real failure (network
            // drop, decode error, etc.) gets the same "(stopped)" cleanup —
            // an orphaned empty/partial placeholder turn must not linger in
            // `history` forever either way — plus the `self.error` banner
            // explaining what went wrong.
            let isCancellation = error is CancellationError || (error as? URLError)?.code == .cancelled
            if revealingTurnID == streamingID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
            }
            if !isCancellation {
                self.error = error.localizedDescription
            }
        }
        // Drain the next queued message (FIFO) as a fresh, un-cancelled turn.
        if !queued.isEmpty {
            let next = queued.removeFirst()
            startTurn(next.text, skillIds: next.skillIds)
        } else {
            busy = false
            runTask = nil
        }
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
            self.agent.pendingTool = nil
            // Synthetic acknowledgement turn — agent sees the result in history.
            // RepoIssue.webUrl is backend-correct for both providers.
            history.append(.init(
                role: .user,
                content: "(executed create-issue → #\(issue.number) \(issue.webUrl))"
            ))
            // Refresh recentIssues so the newly created issue's title
            // resolves in follow-up comment/update sheets instead of
            // showing blank until the next unrelated refresh.
            await refreshRecentIssuesOnce()
            // Re-invoke the agent so it can acknowledge in natural language.
            await sendFollowup()
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
        self.agent.pendingTool = nil

        // Synthetic acknowledgement turn so the agent can react.
        let basename = (absolute as NSString).lastPathComponent
        let oldLineCount = edit.original.components(separatedBy: "\n").count
        let newLineCount = finalContent.components(separatedBy: "\n").count
        let delta = newLineCount - oldLineCount
        let deltaStr = delta == 0
            ? "no net line change"
            : (delta > 0 ? "+\(delta) lines" : "\(delta) lines")
        history.append(.init(
            role: .user,
            content: "(applied update to \(basename): \(deltaStr))"
        ))
        await unblockAndFollowUp()
        return .success
    }

    /// Posts a comment on the given issue via the resolved backend (GitLab or
    /// One code-assist round-trip that streams live status, with a safety net:
    /// if the SSE transport fails for any reason other than a user cancellation,
    /// fall back to the buffered endpoint once. So a streaming/parse bug can
    /// never break the feature — the worst case is losing the live status line.
    func codeAssistRoundTrip(
        message: String,
        history: [LlmIdeAPIClient.CodeAssistTurn],
        attachments: [LlmIdeAPIClient.CodeAttachment],
        skills: [String] = [],
        onChunk: @escaping @MainActor (String) -> Void,
    ) async throws -> LlmIdeAPIClient.CodeAssistResponse {
        // Determine provider string: custom:uuid for custom providers, or built-in tool provider
        let provider: String
        if modelState.selectedProvider.starts(with: "custom:") {
            // For custom providers, send the full custom:uuid identifier
            provider = modelState.selectedProvider
        } else {
            // For built-in providers, use the provider string from the AICliTool
            provider = (AICliTool(rawValue: modelState.selectedProvider) ?? .claudeCode).provider
        }
        let model = modelState.selectedModel.isEmpty ? nil : modelState.selectedModel
        let ctx = await buildAgentContext()
        do {
            return try await api.codeAssistStream(
                message: message, language: prefLanguage, model: model, provider: provider,
                history: history, attachments: attachments, skills: skills, agentContext: ctx,
                mode: modelState.selectedMode.rawValue,
                onProgress: { progress in
                    statusText = progress.label
                    // Keep a durable row for each TOOL step (not for
                    // thinking/writing, which are momentary): this is the
                    // record that replaces the raw fence JSON the user used to
                    // watch stream into the reply.
                    guard progress.isTool, let turnID = revealingTurnID else { return }
                    var steps = turnActivity[turnID] ?? []
                    // The loop re-emits on every iteration; a repeat of the same
                    // action back-to-back is noise, not a second step.
                    if steps.last?.label == progress.label { return }
                    steps.append(.init(label: progress.label, tool: progress.tool))
                    turnActivity[turnID] = steps
                },
                onChunk: onChunk)
        } catch let e as APIError {
            // APIError == a server/stream/format failure (cancellations surface
            // as CancellationError / URLError.cancelled, which propagate). Retry
            // once on the buffered path so streaming issues degrade gracefully.
            if case .http = e {
                return try await api.codeAssist(
                    message: message, language: prefLanguage, model: model, provider: provider,
                    history: history, attachments: attachments, skills: skills, agentContext: ctx,
                    mode: modelState.selectedMode.rawValue)
            }
            throw e
        }
    }

    /// `sendFollowup` guards on `!busy` so a rapid double-confirm or manual
    /// ⌘↵ mid-stream can't stack overlapping round-trips. But 3 call sites
    /// (`confirmUpdateFile`'s auto-edit path, and `runGitOpFlow`'s two early
    /// returns) run their action from INSIDE a turn that already set
    /// `busy = true` and need their own synthetic-ack `sendFollowup` to
    /// actually fire, not be silently skipped by that guard. This is the
    /// one place that unblocks it — `busy = false` here is always safe to
    /// call from those three sites specifically: `runTurn`/`sendFollowup`
    /// re-set `busy = false` at their own tail regardless (a benign no-op
    /// once already false), and each of the three callers is on the
    /// success path of an action that just appended the synthetic-ack turn
    /// the follow-up needs to see.
    func unblockAndFollowUp() async {
        busy = false
        await sendFollowup()
    }

    func sendFollowup() async {
        // Don't fire a second round-trip if one is already in flight.
        // Without this guard, rapid confirms or a manual ⌘↵ during
        // model streaming would stack overlapping /code-assist requests.
        guard !busy else { return }
        busy = true
        statusText = ""
        defer { busy = false }
        // Captured once, fixed for this whole invocation, and declared
        // OUTSIDE the do block below — see runTurn's matching comment for
        // why the catch clause must compare against this exact id instead
        // of re-reading the (possibly now-different) global `revealingTurnID`.
        let streamingID = beginStreamingTurn()
        do {
            let recent = historyForRequest(history)
            // The synthetic "(executed create-gitlab-issue …)" turn we
            // pushed before this call IS the signal the agent needs to
            // see. Keep it in `history`; pass "(continue)" as the user
            // message purely to pass the server's empty-message guard.
            let resp = try await codeAssistRoundTrip(
                message: "(continue)",
                history: recent,
                attachments: [],
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) },
            )
            if let idx = history.firstIndex(where: { $0.id == streamingID }) {
                history[idx].content = resp.reply
            }
            finishStreamingTurn(
                streamingID,
                pendingTool: resp.pendingTool,
                tasks: resp.tasks,
                continueNeeded: resp.continueNeeded,
                usage: resp.usage,
                mode: resp.mode,
                stopped: false,
            )
            // Chain the NEXT step hands-free when allowed — this is what lets a
            // multi-step plan (e.g. "update A, then update B" or "commit and
            // push") finish without a card for every step. Mirrors runTurn's
            // own call; without this, only the FIRST step (checked in runTurn)
            // would auto-run and every step after it would stall on a
            // pending-action card even in Auto edit mode. Reading `resp`
            // directly (rather than `agent.pendingTool`/no usage at all, as
            // before) gives this call site the same truncated-path data-loss
            // guard runTurn's copy already had.
            await autoChainPendingAction(resp.pendingTool, usage: resp.usage)
        } catch {
            // Same cleanup as runTurn's generic catch — beginStreamingTurn()
            // already inserted an empty placeholder turn before this
            // round-trip started, and a non-cancellation failure must not
            // leave it orphaned in `history` forever.
            if revealingTurnID == streamingID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
            }
            self.error = error.localizedDescription
        }
    }

    /// Total characters of chat history sent per request. The server applies
    /// its own (smaller, prompt-aware) budget — see `config.history` and
    /// `selectHistoryTurns` in `llm_agent/runtime/loop.mjs` — so this only has
    /// to keep the POST body clear of the server's 8 MB request-body limit.
    static let maxHistoryChars = 400_000
    /// Per-turn clip. One runaway turn (a big command output, a whole file)
    /// must not be able to consume the entire budget by itself.
    static let maxHistoryTurnChars = 24_000

    /// The history to replay on the wire: as much as fits `maxHistoryChars`,
    /// newest-first, ALWAYS including the first user turn.
    ///
    /// Replaces a flat `history.suffix(8)`. Eight turns sounds generous until
    /// you count tool calls: every client-executed tool (bash / update-file /
    /// git-op) appends a synthetic result turn plus the agent's reply, so a
    /// four-step task pushed the user's original request out of the window and
    /// the agent carried on with no idea what it had been asked to do.
    func historyForRequest(_ turns: [LlmIdeAPIClient.CodeAssistTurn])
        -> [LlmIdeAPIClient.CodeAssistTurn]
    {
        let clipped = turns.map { turn -> LlmIdeAPIClient.CodeAssistTurn in
            guard turn.content.count > Self.maxHistoryTurnChars else { return turn }
            return .init(role: turn.role,
                         content: String(turn.content.prefix(Self.maxHistoryTurnChars))
                             + "\n…(turn clipped)")
        }
        let total = clipped.reduce(0) { $0 + $1.content.count }
        if total <= Self.maxHistoryChars { return clipped }

        // Reserve the anchor (first user turn) before packing the tail.
        let anchorIdx = clipped.firstIndex { $0.role == .user }
        var budget = Self.maxHistoryChars
        var anchor: LlmIdeAPIClient.CodeAssistTurn?
        if let idx = anchorIdx, clipped[idx].content.count <= budget {
            anchor = clipped[idx]
            budget -= clipped[idx].content.count
        }
        var tail: [LlmIdeAPIClient.CodeAssistTurn] = []
        let stopAt = anchor == nil ? -1 : (anchorIdx ?? -1)
        var i = clipped.count - 1
        while i > stopAt {
            let cost = clipped[i].content.count
            if cost > budget { break }
            budget -= cost
            tail.append(clipped[i])
            i -= 1
        }
        return (anchor.map { [$0] } ?? []) + tail.reversed()
    }

    /// Auto-chain the next pending action (file edit or git op) when the
    /// budget allows. Shared by `runTurn` and `sendFollowup` so both see the
    /// same truncated-path data-loss guard — previously `sendFollowup` had
    /// its own copy that read `agent.pendingTool` with no `usage`, silently
    /// missing the guard for every step after the first in a chained plan.
    /// DO NOT re-inline this at either call site.
    @MainActor
    func autoChainPendingAction(
        _ pendingTool: PendingTool?,
        usage: LlmIdeAPIClient.CodeAssistResponse.Usage?
    ) async {
        // Fast path: in Auto mode, apply a proposed file edit immediately
        // instead of surfacing the card + popup. Scoped to `update-file`
        // (confirmUpdateFile resolves and guards the target, and leaves the
        // card up if it can't); GitLab actions keep their confirmation.
        if editMode == .auto, autoGitOpsThisTurn < Self.maxAutoGitOpsPerTurn,
           let pt = pendingTool, let args = pt.updateFileArgs {
            // Data-loss guard: if the server CUT this file to fit the prompt,
            // the agent only saw its head — auto-overwriting with the "full"
            // rewrite would silently drop the tail. Fall back to the manual
            // confirmation card (its diff makes the loss visible) instead of
            // applying. matchingAttachment uses the same exact-path rule
            // confirmUpdateFile enforces in auto mode.
            //
            // ONLY whole-file (`content`) proposals are at risk: an anchored
            // old_text/new_text edit rewrites just the matched region, so a
            // truncated view of the file can't cost the tail — and refusing
            // those would block auto-edit for exactly the files it is most
            // useful on (the large ones the agent read in slices).
            let truncated = Set(usage?.truncatedPaths ?? [])
            let isWholeFileRewrite = args.content != nil
            if isWholeFileRewrite,
               let match = matchingAttachment(for: args.path, allowBasenameFallback: false),
               truncated.contains(match.path) {
                let basename = (match.path as NSString).lastPathComponent
                self.error = "“\(basename)” was too large to send in full, so auto-edit is disabled for it — review the proposed change before applying."
                // Leave pendingTool in place (already stored via finishStreamingTurn) so the card shows.
            } else {
                switch resolveEdit(args) {
                case .success(let edit):
                    autoGitOpsThisTurn += 1
                    _ = await confirmUpdateFile(args, finalContent: edit.proposed)
                case .failure(let err):
                    // Unresolvable (anchor missed, path outside the project, …).
                    // Surface it and leave the card so the user can review,
                    // rather than silently dropping the agent's edit.
                    self.error = err.message
                }
            }
        }
        // Auto-run the proposed git op when allowed (see shouldAutoRunGitOp);
        // otherwise it stays as a pending card for the user to confirm.
        // `autoGitOpsThisTurn`/`maxAutoGitOpsPerTurn` are shared as a general
        // "auto-chained actions this turn" budget across BOTH update-file and
        // git-op auto-chaining — without a shared cap, a large batch of
        // attached files (e.g. 30+ dragged in for a bulk edit) could
        // auto-chain through all of them with no ceiling.
        if let pt = pendingTool, let g = pt.gitOpArgs, shouldAutoRunGitOp(g) {
            autoGitOpsThisTurn += 1
            await runGitOpFlow(g)
        }
        // Auto-run a proposed shell command in Bypass mode. Without this, EVERY
        // "run the tests / check the version" request stalled on a card no
        // matter which mode was selected — the agent's prompt steers it to the
        // client-executed `bash` tool, which ends the request, so an untapped
        // card meant the turn simply ended with no answer. Shares the same
        // per-turn budget as the two branches above, and runBashCommand still
        // applies BashService.validateCommand plus its own timeout/output caps.
        if editMode == .auto, autoGitOpsThisTurn < Self.maxAutoGitOpsPerTurn,
           let pt = pendingTool, let args = pt.bashArgs {
            autoGitOpsThisTurn += 1
            await runBashCommand(args)
        }
    }

    // MARK: - Session management

    /// Persist `history` into the current UUID session file, deriving a
    /// title from the first user turn if it's still "New chat".
    ///
    /// Does NOT call `refreshSessions()` — this runs on every history change
    /// (i.e. every turn), and the sidebar/dropdown session list only needs
    /// to reflect the latest title/timestamp when it's actually shown or
    /// when sessions are created/switched/deleted. Reloading the list from
    /// disk on every message was wasted work on the hot path.
    func persistCurrentChat(history: [LlmIdeAPIClient.CodeAssistTurn]) {
        guard let id = UUID(uuidString: currentSessionIDString) else { return }
        var session = ChatSessionStore.load(id: id) ?? ChatSession(id: id, scope: scope)
        session.scope = scope
        session.history = history
        if session.title == "New chat" || session.title.isEmpty {
            if let firstUser = history.first(where: { $0.role == .user }) {
                let raw = firstUser.content
                    .replacingOccurrences(of: "\n", with: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !raw.isEmpty {
                    session.title = String(raw.prefix(40))
                }
            }
        }
        ChatSessionStore.save(session)
    }

    /// Reload `sessions` for this scope from disk, newest first.
    func refreshSessions() {
        sessions = ChatSessionStore.list(for: scope)
    }

    /// Renames a saved chat. Safe from being clobbered later:
    /// persistCurrentChat's auto-title-from-first-message logic only fires
    /// when the title is still "New chat"/empty, so any other title —
    /// including a manual rename — is left alone on every later save.
    func renameSession(_ id: UUID, to newTitle: String) {
        let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var session = ChatSessionStore.load(id: id) else { return }
        session.title = String(trimmed.prefix(60))
        ChatSessionStore.save(session)
        refreshSessions()
    }

    /// Mirror `currentSessionIDString` to UserDefaults so the current chat
    /// survives relaunch.
    func rememberCurrentPointer() {
        UserDefaults.standard.set(currentSessionIDString, forKey: "chat.current.\(scope.rawValue)")
    }

    /// Cancel any in-flight turn and clear per-conversation transient
    /// state (`busy`, `queued`, `expandedTurns`). Called whenever the
    /// active chat is swapped out (create/switch/delete) so a running
    /// reply can't land its result in — or leave `busy` stuck locking —
    /// the newly active chat, and queued messages / expanded-turn ids
    /// don't survive the swap.
    func resetActiveTurnState() {
        runTask?.cancel()
        runTask = nil
        busy = false
        queued.removeAll()
        expandedTurns.removeAll()
        // runTask?.cancel() above is fire-and-forget — the actual
        // CancellationError cleanup inside runTurn's/sendFollowup's catch
        // block runs asynchronously and is NOT guaranteed to complete before
        // callers of this function persist or swap `history` right after it
        // returns (session switch/create/delete). Finalize any in-flight
        // streaming turn synchronously here instead, so the outgoing
        // session's placeholder is never left unfinished when persisted.
        if let streamingID = revealingTurnID {
            finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
        } else {
            revealedCount = 0
        }
    }

    /// Begin a new streaming assistant turn: appends a placeholder turn to
    /// `history` and marks it as the one `appendStreamedChunk` will mutate.
    /// The append happens with `suppressHistoryAnnounce` set so the
    /// length-triggered VoiceOver announcement in `handleHistoryChange`
    /// doesn't fire on an empty placeholder — `finishStreamingTurn` fires the
    /// real announcement itself, once, with the complete text.
    @MainActor
    func beginStreamingTurn() -> UUID {
        let turn = LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: "")
        suppressHistoryAnnounce = true
        history.append(turn)
        DispatchQueue.main.async { suppressHistoryAnnounce = false }
        revealingTurnID = turn.id
        revealedCount = 0
        return turn.id
    }

    /// Append `text` to the streaming turn identified by `id`. `revealedCount`
    /// tracks the turn's current length so `ChatMessageList.displayedContent`
    /// (which truncates to `revealedCount` characters for whichever turn
    /// matches `revealingTurnID`) shows the growing content as it arrives —
    /// the same read path the old fixed-schedule reveal used, now driven by
    /// real chunk arrival instead of an artificial timer.
    @MainActor
    func appendStreamedChunk(_ id: UUID, _ text: String) {
        guard let idx = history.firstIndex(where: { $0.id == id }) else { return }
        history[idx].content += text
        revealedCount = history[idx].content.count
    }

    /// Finalize a streaming turn: fires the VoiceOver announcement exactly
    /// once (with the complete final text), applies `pendingTool`/
    /// `agentPendingTasks`/auto-continue exactly as `runTurn` did before this
    /// refactor, and — when `stopped` — leaves whatever partial text already
    /// streamed in place, tagged as stopped, instead of discarding it.
    @MainActor
    func finishStreamingTurn(
        _ id: UUID,
        pendingTool: PendingTool?,
        tasks: [AgentTask]?,
        continueNeeded: Bool?,
        usage: LlmIdeAPIClient.CodeAssistResponse.Usage?,
        mode: String?,
        stopped: Bool,
    ) {
        revealingTurnID = nil
        revealedCount = 0
        // Only store non-default modes — ModeBadge never renders for
        // .execute/.auto, and most turns use one of those, so skipping them
        // here keeps this dictionary from growing with entries nothing ever
        // reads back.
        if let mode, let resolved = CodeAssistMode(rawValue: mode), resolved != .execute, resolved != .auto {
            turnModes[id] = resolved
        }
        if let idx = history.firstIndex(where: { $0.id == id }) {
            if stopped {
                if !history[idx].content.isEmpty {
                    history[idx].content += "\n\n_(stopped)_"
                }
            }
            let text = String(history[idx].content.prefix(200))
            if !text.isEmpty {
                NSAccessibility.post(
                    element: NSApp as Any,
                    notification: .announcementRequested,
                    userInfo: [
                        .announcement: text,
                        .priority: NSAccessibilityPriorityLevel.high.rawValue,
                    ]
                )
            }
        }
        guard !stopped else {
            // A stopped turn (Stop/Esc mid-send, cancellation, or certain
            // error paths that pass `stopped: true`) must always end any
            // in-flight autonomous chain, regardless of why it stopped —
            // this early return happens BEFORE the `else` branch below that
            // normally resets `agentIsAutonomous`, so without this line the
            // flag stayed stuck `true` forever after a stop even though
            // `busy`/`runTask` correctly cleared via the caller's own tail.
            agent.agentIsAutonomous = false
            return
        }
        self.agent.pendingTool = pendingTool
        if let newTasks = tasks {
            agent.agentPendingTasks = newTasks
        }
        if continueNeeded == true && !agent.agentStopRequested {
            agent.agentIsAutonomous = true
            let scheduledEpoch = sessionEpoch
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                guard self.sessionEpoch == scheduledEpoch else { return }
                guard !self.agent.agentStopRequested else {
                    self.agent.agentIsAutonomous = false
                    return
                }
                // A round-trip (including a synchronous auto-chain — e.g.
                // Task 11's update-file/git-op chaining, which can take far
                // longer than this 0.8s delay) may already be in flight by
                // the time this fires. That in-flight call will itself
                // re-evaluate continueNeeded via its own finishStreamingTurn
                // call when it completes, so firing a second, redundant
                // "Continue working" turn here would only race its writes to
                // agent.pendingTool/agent.agentPendingTasks and orphan Stop's
                // ability to cancel the REAL chain (this closure would
                // reassign runTask out from under it via startTurn).
                guard !self.busy else { return }
                self.startTurn("Continue working on your pending tasks.")
            }
        } else {
            agent.agentIsAutonomous = false
            agent.agentStopRequested = false
        }
        if let u = usage {
            agent.lastMemoryTokens = u.memoryApproxTokens
            agent.lastMemoryHasChat = u.memoryHasChatMemory ?? false
        }
    }

    /// Reset all composer + agent transient state for a freshly created,
    /// switched-to, or fallback chat. Does NOT touch `history` — callers are
    /// responsible for that. If the caller also calls `rebuildSentPrompts`
    /// (i.e. it's loading a non-empty history rather than starting a blank
    /// chat), call it AFTER this so its seeded `sentPrompts`/`historyIndex`/
    /// `draftStash` aren't clobbered by the blanket reset below.
    ///
    /// Bumps `sessionEpoch` and mints a fresh `agentSessionId`, so anything
    /// tied to the outgoing session — in particular the auto-continue
    /// `asyncAfter` closure scheduled from `startTurn` — can detect the
    /// switch and no-op instead of acting on the new session's history.
    func resetTransientSessionState() {
        sentPrompts = []; historyIndex = nil; draftStash = ""
        draft = ""
        attachmentState.attachments.removeAll()
        attachmentState.selectedSkills.removeAll()
        autoAttachedPath = nil
        attachNotice = nil
        agent.pendingTool = nil
        // Tool-step rows belong to the outgoing chat's turns; a reloaded
        // session mints fresh turn ids, so keeping them would only leak.
        turnActivity.removeAll()
        error = nil
        agent.nudgePrompt = nil
        agent.agentSessionId = UUID().uuidString
        agent.agentPendingTasks = []
        agent.agentIsAutonomous = false
        agent.agentStopRequested = false
        sessionEpoch += 1
    }

    /// Save `fresh` as the new current session, point all the bookkeeping
    /// (pointer, defaults, sessions list) at it, and reset transient state
    /// for a blank chat. Shared tail of `createNewSession` and the
    /// no-sessions-left branch of `deleteSession`.
    func mintFreshSession() {
        let fresh = ChatSession(scope: scope)
        ChatSessionStore.save(fresh)
        currentSessionIDString = fresh.id.uuidString
        rememberCurrentPointer()
        refreshSessions()
        history = []
        resetTransientSessionState()
    }

    /// Start a new empty chat for this scope. No-op if the current chat is
    /// already an untouched "New chat" (avoids duplicate empty rows from
    /// repeated taps on "+ New chat").
    func createNewSession() {
        if history.isEmpty {
            let title = sessions.first(where: { $0.id.uuidString == currentSessionIDString })?.title ?? "New chat"
            if title == "New chat" || title.isEmpty { return }
        }
        // Finalize any in-flight stream BEFORE persisting — otherwise an
        // unfinished placeholder turn could be written to disk (see
        // resetActiveTurnState's doc comment).
        resetActiveTurnState()
        persistCurrentChat(history: Array(history.suffix(50)))
        mintFreshSession()
    }

    /// Switch the active chat to `id`, persisting the outgoing chat first.
    func switchSession(to id: UUID) {
        guard id.uuidString != currentSessionIDString else { return }
        guard let session = ChatSessionStore.load(id: id), session.scope == scope else { return }
        // Finalize any in-flight stream BEFORE persisting — otherwise an
        // unfinished placeholder turn could be written to disk (see
        // resetActiveTurnState's doc comment).
        resetActiveTurnState()
        persistCurrentChat(history: Array(history.suffix(50)))
        currentSessionIDString = id.uuidString
        rememberCurrentPointer()
        resetTransientSessionState()
        suppressHistoryAnnounce = true
        history = session.history
        rebuildSentPrompts(from: session.history)
        DispatchQueue.main.async { suppressHistoryAnnounce = false }
        ChatSessionStore.save(session)
        refreshSessions()
    }

    /// Delete chat `id`. If it was the active chat, switch to the next most
    /// recent session, or mint a fresh empty one if none remain.
    func deleteSession(_ id: UUID) {
        if id.uuidString == currentSessionIDString { resetActiveTurnState() }
        ChatSessionStore.delete(id: id)
        // Forget what this chat taught the agent, so deleting the conversation
        // deletes its memory too — otherwise facts captured from a chat the user
        // has thrown away keep coming back in every later prompt. Fire-and-
        // forget: the chat file is already gone either way, and the server
        // prunes its own origins index, so a failure here is recoverable by a
        // later delete rather than something to block the UI on.
        //
        // Repos/workspace are captured on the main actor BEFORE detaching:
        // they read library/config state that isn't Sendable.
        //
        // These describe the CURRENTLY open project, which is not necessarily
        // the one the deleted chat talked to. That can under-clean (a chat's
        // facts survive in a project the user has since switched away from) but
        // never mis-cleans: the server filters by session id, so a request
        // aimed at the wrong repo removes nothing.
        let repos = activeMemoryRepos
        let workspaceRoot = activeMemoryWorkspaceRoot
        let api = self.api
        Task.detached {
            _ = try? await api.forgetSessionMemory(sessionId: id.uuidString,
                                                  repos: repos,
                                                  workspaceRoot: workspaceRoot)
        }
        refreshSessions()
        if id.uuidString == currentSessionIDString {
            if let next = sessions.first {
                currentSessionIDString = next.id.uuidString
                rememberCurrentPointer()
                resetTransientSessionState()
                suppressHistoryAnnounce = true
                history = next.history
                rebuildSentPrompts(from: next.history)
                DispatchQueue.main.async { suppressHistoryAnnounce = false }
            } else {
                // No sessions left for this scope — mint a blank one and
                // point everything (pointer, defaults, sessions list) at it.
                mintFreshSession()
            }
        }
    }

    /// Header trash: delete the current chat (mints a fresh empty one if it
    /// was the last remaining session for this scope).
    func clearCurrentChat() {
        guard let id = UUID(uuidString: currentSessionIDString) else {
            createNewSession()
            return
        }
        deleteSession(id)
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
