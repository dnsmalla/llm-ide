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
            if let err = qaSaveError {
                Text(err).font(Typography.caption).foregroundStyle(t.danger)
                    .lineLimit(1).truncationMode(.tail)
            }
            Button(savingQA ? "Saving…" : "Save") {
                Task { await saveLatestAnswer(forPrompt: prompt) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(savingQA)
            Button("Dismiss") {
                session.dismiss(hash: session.hashForPrompt(prompt))
                nudgePrompt = nil
                qaSaveError = nil
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(savingQA)
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
            qaSaveError = "No active repo."
            return
        }
        savingQA = true
        qaSaveError = nil
        defer { savingQA = false }
        let answer = mostRecentAnswer(forPrompt: prompt) ?? ""
        guard !answer.isEmpty else {
            qaSaveError = "No agent answer found yet."
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
            nudgePrompt = nil
        } catch {
            qaSaveError = "Couldn't save: \(error.localizedDescription)"
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
            nudgePrompt = message
        }
        // Append the user turn FIRST so the message appears immediately
        // even if the network call is slow.
        history.append(.init(role: .user, content: message))
        busy = true
        statusText = ""
        error = nil
        // Clear any stale pending-tool card from a prior turn the user ignored —
        // otherwise it stays interactive against the old args while a new turn runs.
        pendingTool = nil
        // Fresh budget of auto-run git ops for this user turn (commit→push→… ).
        autoGitOpsThisTurn = 0
        do {
            // Send the most recent ~8 turns as history — server caps too
            // but we'd rather not push a huge payload over the wire.
            let recent = history.count > 8 ? Array(history.suffix(8)) : history
            // Stream so the user sees live progress ("Searching the web…",
            // "Writing the answer…") instead of a frozen spinner for the
            // 60–90s an agent turn can take. Falls back to buffered on a
            // stream failure (see codeAssistRoundTrip).
            let resp = try await codeAssistRoundTrip(
                message: message,
                history: Array(recent.dropLast()),  // exclude the just-pushed user turn — server appends it
                attachments: attachments,
                skills: skillIds,
            )
            // If Stop fired during the await, don't append the (now-unwanted) reply.
            try Task.checkCancellation()
            let assistantTurn = LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: resp.reply)
            history.append(assistantTurn)
            revealAssistantReply(assistantTurn)
            self.pendingTool = resp.pendingTool
            // Update task list display
            if let newTasks = resp.tasks {
                agentPendingTasks = newTasks
            }
            // Auto-continue if the agent has pending work and the user hasn't stopped
            if resp.continueNeeded == true && !agentStopRequested {
                agentIsAutonomous = true
                let scheduledEpoch = sessionEpoch
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    // The active chat may have changed (switch/new/delete)
                    // during this delay — don't let a stale continuation
                    // fire a turn against a different session's history.
                    guard self.sessionEpoch == scheduledEpoch else { return }
                    guard !self.agentStopRequested else {
                        self.agentIsAutonomous = false
                        return
                    }
                    self.startTurn("Continue working on your pending tasks.")
                }
            } else {
                agentIsAutonomous = false
                agentStopRequested = false
            }
            if let u = resp.usage {
                lastMemoryTokens = u.memoryApproxTokens
                lastMemoryHasChat = u.memoryHasChatMemory ?? false
            }
            // Fast path: in Auto mode, apply a proposed file edit immediately
            // instead of surfacing the card + popup. Scoped to `update-file`
            // (confirmUpdateFile enforces the attached-files-only guard, and
            // leaves the card up if the file isn't attached); GitLab actions
            // keep their confirmation. Only the primary turn auto-applies —
            // the follow-up turn falls back to the card, so an agent that
            // keeps proposing edits can't loop.
            if editMode == .auto, let pt = resp.pendingTool, let args = pt.updateFileArgs {
                // Data-loss guard: if the server CUT this file to fit the prompt,
                // the agent only saw its head — auto-overwriting with the "full"
                // rewrite would silently drop the tail. Fall back to the manual
                // confirmation card (its diff makes the loss visible) instead of
                // applying. matchingAttachment uses the same exact-path rule
                // confirmUpdateFile enforces in auto mode.
                let truncated = Set(resp.usage?.truncatedPaths ?? [])
                if let match = matchingAttachment(for: args.path, allowBasenameFallback: false),
                   truncated.contains(match.path) {
                    let basename = (match.path as NSString).lastPathComponent
                    self.error = "“\(basename)” was too large to send in full, so auto-edit is disabled for it — review the proposed change before applying."
                    // Leave resp.pendingTool in place (set above) so the card shows.
                } else {
                    _ = await confirmUpdateFile(args, finalContent: args.content)
                }
            }
            // Auto-run the proposed git op when allowed (see shouldAutoRunGitOp);
            // otherwise it stays as a pending card for the user to confirm.
            if let pt = resp.pendingTool, let g = pt.gitOpArgs, shouldAutoRunGitOp(g) {
                autoGitOpsThisTurn += 1
                await runGitOpFlow(g)
            }
        } catch is CancellationError {
            // Stopped by the user — leave the user turn, no error bubble.
        } catch let urlError as URLError where urlError.code == .cancelled {
            // Stopped: Task cancellation surfaced as a cancelled URLSession request.
        } catch {
            self.error = error.localizedDescription
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
        let client: RepoBackend = target.kind == .gitlab
            ? RepoBackendFactory.guarded(GitLabClient(config: config), config: config)
            : RepoBackendFactory.guarded(GitHubClient(config: config), config: config)
        do {
            let payload = RepoIssuePayload(
                title: args.title,
                body: args.description.isEmpty ? nil : args.description,
                labels: args.labels.isEmpty ? nil : args.labels
            )
            let issue = try await client.createIssue(projectId: target.projectId, payload: payload)
            // Clear the pending tool so the card disappears.
            self.pendingTool = nil
            // Synthetic acknowledgement turn — agent sees the result in history.
            // RepoIssue.webUrl is backend-correct for both providers.
            history.append(.init(
                role: .user,
                content: "(executed create-issue → #\(issue.number) \(issue.webUrl))"
            ))
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
        let canonProposed = PathUtils.canonicalise(proposedPath)
        let canonBasename = (canonProposed as NSString).lastPathComponent
        // 1. Exact canonicalised match (handles ~, file://, symlinks, ./).
        if let exact = attachments.first(where: {
            PathUtils.canonicalise($0.path) == canonProposed
        }) {
            return exact
        }
        // 2. Basename match as a fallback when the agent emitted a
        //    different parent path (e.g. it guessed /Users/.../README.md
        //    while the user attached ~/Developer/.../README.md). The
        //    agent is supposed to use the exact attachment path, but
        //    LLMs slip — better to update the obviously-intended file
        //    than refuse on a parent-dir difference.
        //    DISABLED in auto-edit mode (allowBasenameFallback=false): with no
        //    confirmation sheet, a poisoned/hallucinated path that merely
        //    shares a basename with an attachment would silently overwrite that
        //    file. Auto mode requires an exact path the agent explicitly chose.
        if allowBasenameFallback && !canonBasename.isEmpty {
            let matches = attachments.filter {
                ($0.path as NSString).lastPathComponent == canonBasename
            }
            // Only fall back when there's exactly one candidate — if
            // multiple attachments share the basename, the agent's
            // ambiguous path means we can't pick safely.
            if matches.count == 1 { return matches.first }
        }
        return nil
    }

    // Path canonicalisation lives in `Utilities/PathUtils.swift` so the
    // attachment match here uses the same rules as every other tilde-
    // expansion / symlink-resolution site in the app.

    /// Writes the user-approved content to disk, then refreshes the
    /// in-memory attachment so subsequent chat turns see the new file.
    /// Append a synthetic ack turn and re-invoke the agent so it can
    /// acknowledge in natural language (matches createIssue flow).
    @MainActor
    func confirmUpdateFile(_ args: PendingTool.UpdateFileArgs,
                                   finalContent: String)
        async -> UpdateFileSheet.ConfirmResult
    {
        // In auto-edit mode the write happens with no confirmation sheet, so
        // require an EXACT attached-path match — don't let the lenient basename
        // fallback silently redirect a write onto a different attached file.
        guard let match = matchingAttachment(for: args.path,
                                             allowBasenameFallback: editMode != .auto) else {
            return .failure(editMode == .auto
                ? "Auto-edit can only write a file whose exact path is attached — refusing to write '\(args.path)'."
                : "That file isn't attached to this chat — refusing to write.")
        }
        // Write to the authoritative attached path, not the LLM-emitted path.
        // A basename-fallback match can make args.path diverge from match.path,
        // which would overwrite the wrong file.
        let absolute = PathUtils.canonicalise(match.path)
        let url = URL(fileURLWithPath: absolute)
        do {
            try finalContent.write(to: url, atomically: true, encoding: .utf8)
            // Track this file for File → PR automation
            modifiedFiles.insert(match.path)
        } catch {
            return .failure("Couldn't write \(absolute): \(error.localizedDescription)")
        }
        // Deselect the file now that the update is applied. The user attached it
        // to edit it — that's done — and leaving the (now-written) chip in place
        // just re-sends the whole file on every later turn. Remove only THIS
        // file's chip (other attachments stay), and clear the auto-attach
        // bookkeeping if it was the auto-attached file. `match` is a value copy,
        // so the line-delta math below still sees the pre-write content.
        attachments.removeAll { $0.path == match.path }
        if autoAttachedPath == match.path { autoAttachedPath = nil }
        self.pendingTool = nil

        // Synthetic acknowledgement turn so the agent can react.
        let basename = (absolute as NSString).lastPathComponent
        let oldLineCount = match.content.components(separatedBy: "\n").count
        let newLineCount = finalContent.components(separatedBy: "\n").count
        let delta = newLineCount - oldLineCount
        let deltaStr = delta == 0
            ? "no net line change"
            : (delta > 0 ? "+\(delta) lines" : "\(delta) lines")
        history.append(.init(
            role: .user,
            content: "(applied update to \(basename): \(deltaStr))"
        ))
        // In auto-edit mode confirmUpdateFile is called from inside runTurn,
        // which has already set busy = true. sendFollowup() guards on !busy
        // and would silently skip. Clear busy here so the follow-up fires;
        // runTurn sets busy = false at its tail afterwards (a benign no-op,
        // unless a queued message is waiting — which it then drains). In
        // manual mode the sheet calls us directly with busy already false,
        // so this is also safe.
        busy = false
        await sendFollowup()
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
    ) async throws -> LlmIdeAPIClient.CodeAssistResponse {
        // Determine provider string: custom:uuid for custom providers, or built-in tool provider
        let provider: String
        if selectedProvider.starts(with: "custom:") {
            // For custom providers, send the full custom:uuid identifier
            provider = selectedProvider
        } else {
            // For built-in providers, use the provider string from the AICliTool
            provider = (AICliTool(rawValue: selectedProvider) ?? .claudeCode).provider
        }
        let model = selectedModel.isEmpty ? nil : selectedModel
        let ctx = await buildAgentContext()
        do {
            return try await api.codeAssistStream(
                message: message, language: prefLanguage, model: model, provider: provider,
                history: history, attachments: attachments, skills: skills, agentContext: ctx,
                onProgress: { statusText = $0 })
        } catch let e as APIError {
            // APIError == a server/stream/format failure (cancellations surface
            // as CancellationError / URLError.cancelled, which propagate). Retry
            // once on the buffered path so streaming issues degrade gracefully.
            if case .http = e {
                return try await api.codeAssist(
                    message: message, language: prefLanguage, model: model, provider: provider,
                    history: history, attachments: attachments, skills: skills, agentContext: ctx)
            }
            throw e
        }
    }

    func sendFollowup() async {
        // Don't fire a second round-trip if one is already in flight.
        // Without this guard, rapid confirms or a manual ⌘↵ during
        // model streaming would stack overlapping /code-assist requests.
        guard !busy else { return }
        busy = true
        statusText = ""
        defer { busy = false }
        do {
            let recent = history.count > 8 ? Array(history.suffix(8)) : history
            // The synthetic "(executed create-gitlab-issue …)" turn we
            // pushed before this call IS the signal the agent needs to
            // see. Keep it in `history`; pass "(continue)" as the user
            // message purely to pass the server's empty-message guard.
            let resp = try await codeAssistRoundTrip(
                message: "(continue)",
                history: recent,
                attachments: [],
            )
            let assistantTurn = LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: resp.reply)
            history.append(assistantTurn)
            revealAssistantReply(assistantTurn)
            self.pendingTool = resp.pendingTool
        } catch {
            self.error = error.localizedDescription
        }
        // Chain the NEXT git op hands-free when allowed — this is what lets
        // "commit and push" finish without a card: commit auto-runs on the
        // primary turn, the agent then proposes push on this follow-up, and we
        // auto-run it too. runGitOpFlow resets `busy = false` itself before its
        // own sendFollowup, so the re-entry isn't blocked by the `guard !busy`
        // even though our `busy` is still true here. The recursion (and so any
        // looping agent) is bounded by autoGitOpsThisTurn.
        if let g = pendingTool?.gitOpArgs, shouldAutoRunGitOp(g) {
            autoGitOpsThisTurn += 1
            await runGitOpFlow(g)
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
        revealTask?.cancel()
        revealTask = nil
        revealingTurnID = nil
        revealedCount = 0
    }

    /// Typewriter-reveals `turn`'s content instead of popping it in all at
    /// once. The server already returns the complete reply in a single
    /// `done` event (see codeAssistRoundTrip) — this is purely a client-side
    /// presentation touch, not real token streaming, so `history` always
    /// holds the true, complete text throughout (nothing here ever risks
    /// persisting a half-revealed reply).
    ///
    /// Step count is fixed (not duration) so the reveal self-scales: short
    /// replies finish quickly (they run out of content before using all the
    /// steps), long replies are capped at a bounded number of steps so they
    /// neither drag out nor multiply SelfSizingMarkdownView's per-change
    /// WKWebView reload any more than necessary.
    func revealAssistantReply(_ turn: LlmIdeAPIClient.CodeAssistTurn) {
        revealTask?.cancel()
        let total = turn.content.count
        guard total > 0 else { revealingTurnID = nil; revealedCount = 0; return }
        revealingTurnID = turn.id
        revealedCount = 0
        let steps = min(total, 28)
        let charsPerStep = max(1, Int((Double(total) / Double(steps)).rounded(.up)))
        // `self` here is the CodeAssistantPanel struct, not a class — captured
        // as a value copy, no retain cycle possible, so no [weak self]. Its
        // @State properties still write through to the real shared storage.
        revealTask = Task { @MainActor in
            var shown = 0
            while shown < total {
                try? await Task.sleep(nanoseconds: 20_000_000) // ~20ms/step
                if Task.isCancelled { return }
                shown = min(shown + charsPerStep, total)
                self.revealedCount = shown
            }
            guard !Task.isCancelled else { return }
            self.revealingTurnID = nil
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
        attachments.removeAll()
        selectedSkills.removeAll()
        autoAttachedPath = nil
        attachNotice = nil
        pendingTool = nil
        error = nil
        nudgePrompt = nil
        agentSessionId = UUID().uuidString
        agentPendingTasks = []
        agentIsAutonomous = false
        agentStopRequested = false
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
        persistCurrentChat(history: Array(history.suffix(50)))
        resetActiveTurnState()
        mintFreshSession()
    }

    /// Switch the active chat to `id`, persisting the outgoing chat first.
    func switchSession(to id: UUID) {
        guard id.uuidString != currentSessionIDString else { return }
        guard let session = ChatSessionStore.load(id: id), session.scope == scope else { return }
        persistCurrentChat(history: Array(history.suffix(50)))
        resetActiveTurnState()
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
