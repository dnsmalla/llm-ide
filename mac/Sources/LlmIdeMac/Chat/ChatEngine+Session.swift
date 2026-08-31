import Foundation

/// Session management half of `ChatEngine` — create/switch/delete/persist,
/// the relaunch pointer, and the history-change persist+announce. Split out
/// of ChatEngine.swift in Task 17 as a pure mechanical move (same bodies,
/// same doc comments); the type doc comment in ChatEngine.swift still
/// explains the design.
///
/// Stored state lives in the main declaration (extensions can't add it), so
/// the state properties this file mutates were relaxed from `private(set)`
/// to internal when the split happened — mutation is still engine-only by
/// convention: nothing outside ChatEngine's own files writes them.
extension ChatEngine {
    // MARK: - Session management
    //
    // Moved 1:1 from `CodeAssistantPanel+Session.swift` (the panel keeps its
    // own copies until Task 7 rewires it). Three mechanical changes, all
    // forced by the move out of the view:
    //
    //  1. `persistCurrentChat(history:)` loses its parameter — the engine owns
    //     `messages`, so it applies the same 50-turn cap its callers used to
    //     pass in.
    //  2. `rebuildSentPrompts(from:)` (composer state, still panel-owned)
    //     becomes the `onHistoryReplaced` hook; `expandedTurns.removeAll()`
    //     (view expand state) and the composer/attachment resets become the
    //     `onResetActiveTurnExtra` / `onResetTransientStateExtra` hooks.
    //  3. `deleteSession`'s `Task.detached { api.forgetSessionMemory(…) }`
    //     becomes the injected `forgetSessionMemory` closure (see below for
    //     why it moved to the tail of the method).

    /// UserDefaults key holding the last-active chat id for this scope.
    private var pointerKey: String { "chat.current.\(scope.rawValue)" }

    /// Persist `messages` into the current UUID session file, deriving a
    /// title from the first user turn if it's still "New chat".
    ///
    /// Does NOT call `refreshSessions()` — this runs on every history change
    /// (i.e. every turn), and the sidebar/dropdown session list only needs
    /// to reflect the latest title/timestamp when it's actually shown or
    /// when sessions are created/switched/deleted. Reloading the list from
    /// disk on every message was wasted work on the hot path.
    ///
    /// Only the last `persistedMessageCap` turns are written. The cap bounds
    /// the per-turn JSON rewrite on pathological sessions; it is NOT a
    /// context-window control (wiring decides what the model sees). It was
    /// 50 for years, which silently discarded older turns of any long chat
    /// on the next switch/relaunch while the in-memory array looked intact —
    /// data loss the user only discovered later. 500 keeps the write bounded
    /// (a few MB worst case, debounced during streaming) without dropping
    /// any realistic conversation.
    static let persistedMessageCap = 500

    func persistCurrentChat() {
        // An immediate write subsumes any pending debounced one — dropping
        // the timer here is what keeps every existing (non-streaming) call
        // site behaving exactly as it did, and stops a stale timer from
        // firing a redundant write after the turn has already landed.
        persistDebounceTask?.cancel()
        persistDebounceTask = nil
        guard let id = UUID(uuidString: currentSessionIDString) else { return }
        let capped = Array(messages.suffix(Self.persistedMessageCap))
        var session = ChatSessionStore.load(id: id) ?? ChatSession(id: id, scope: scope)
        session.scope = scope
        // A straight assignment as of Task 9 — `messages` IS the persisted
        // shape now, so ids/`createdAt`/status/tool steps carry through
        // untouched. (Task 8 needed a position-by-position reconciliation
        // against the file on disk here, because the engine's own array was
        // still `[CodeAssistTurn]` and every persist had to re-synthesize
        // `ChatMessage`s — handing all 50 retained messages a brand-new id
        // and a `createdAt` of "now" on every single turn unless carefully
        // matched up. Owning `[ChatMessage]` end-to-end removes the problem
        // rather than compensating for it; the identity guarantee is the
        // same, and `ChatEngineSessionTests.persistPreservesIdentity` still
        // pins it.)
        session.messages = capped
        if session.title == "New chat" || session.title.isEmpty {
            if let firstUser = capped.first(where: { $0.role == .user }) {
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

    /// Schedule a session write for `persistDebounceNanos` from now, unless
    /// one is already pending. Used by the ONE caller on the streaming hot
    /// path (`announceAndPersist`, driven by `.onChange(of: messages)`); every
    /// other call site still uses `persistCurrentChat()` and writes at once.
    ///
    /// Trailing-edge with a leading schedule: the first mutation starts the
    /// timer and later mutations ride it, so a burst of streamed text costs
    /// exactly one write per window rather than one per mutation. Whatever is
    /// in `messages` when the timer fires is what lands — the debounce holds
    /// no snapshot, so it can never persist stale content.
    func schedulePersist() {
        guard persistDebounceTask == nil else { return }
        persistDebounceTask = Task { [persistDebounceNanos] in
            try? await Task.sleep(nanoseconds: persistDebounceNanos)
            guard !Task.isCancelled else { return }
            self.persistDebounceTask = nil
            self.persistCurrentChat()
        }
    }

    /// Land a pending debounced write now. Called at every turn boundary so a
    /// finished conversation is on disk immediately rather than up to
    /// `persistDebounceNanos` later — the window in which a crash or a quit
    /// would lose the tail of the reply.
    func flushPendingPersist() {
        guard persistDebounceTask != nil else { return }
        persistCurrentChat()
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
        UserDefaults.standard.set(currentSessionIDString, forKey: pointerKey)
    }

    /// Resolve which chat this scope should show on appear: migrate any legacy
    /// per-scope file, load the session list, then restore the remembered
    /// pointer → fall back to the newest session → mint a fresh one. Sets
    /// `messages` itself (like every other session-swap method here) and
    /// returns it for the caller's convenience.
    ///
    /// Extracted from `CodeAssistantPanel.handleOnAppear`, which also does
    /// model-picker and initial-attachment setup — that half stays in the view.
    @discardableResult
    func handleOnAppearSessions() -> [ChatMessage] {
        _ = ChatSessionStore.migrateScopeFileIfNeeded(for: scope)
        refreshSessions()
        if currentSessionIDString.isEmpty {
            currentSessionIDString = UserDefaults.standard.string(forKey: pointerKey) ?? ""
        }
        suppressHistoryAnnounce = true
        if let cur = UUID(uuidString: currentSessionIDString),
           let session = ChatSessionStore.load(id: cur),
           session.scope == scope {
            messages = session.messages
            onHistoryReplaced(session.messages)
        } else if let newest = sessions.first {
            currentSessionIDString = newest.id.uuidString
            messages = newest.messages
            onHistoryReplaced(newest.messages)
            rememberCurrentPointer()
        } else {
            // No usable pointer and no saved chats for this scope — start one.
            // (mintFreshSession clears `messages` itself.)
            mintFreshSession()
        }
        DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
        return messages
    }

    /// Cancel any in-flight turn and clear per-conversation transient
    /// state (`busy`, `queued`, plus whatever `onResetActiveTurnExtra` owns —
    /// the panel's `expandedTurns`). Called whenever the active chat is
    /// swapped out (create/switch/delete) so a running reply can't land its
    /// result in — or leave `busy` stuck locking — the newly active chat, and
    /// queued messages / expanded-message ids don't survive the swap.
    func resetActiveTurnState() {
        runTask?.cancel()
        runTask = nil
        externalRunTask?.cancel()
        externalRunTask = nil
        busy = false
        queued.removeAll()
        onResetActiveTurnExtra()
        // runTask?.cancel() above is fire-and-forget — the actual
        // CancellationError cleanup inside runTurn's/sendFollowup's catch
        // block runs asynchronously and is NOT guaranteed to complete before
        // callers of this function persist or swap `messages` right after it
        // returns (session switch/create/delete). Finalize any in-flight
        // streaming turn synchronously here instead, so the outgoing
        // session's placeholder is never left unfinished when persisted.
        if let streamingID = revealingTurnID {
            finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
        } else {
            // No streaming turn to finalize, so nothing will flush for us —
            // make sure a stray buffer can't land on the INCOMING session's
            // history after the swap.
            discardPendingChunks()
            revealedCount = 0
        }
    }

    /// Reset all agent + transient state for a freshly created, switched-to,
    /// or fallback chat. Does NOT touch `messages` — callers are responsible
    /// for that. If the caller also fires `onHistoryReplaced` (i.e. it's
    /// loading a non-empty history rather than starting a blank chat), fire it
    /// AFTER this so its seeded composer recall state isn't clobbered by
    /// `onResetTransientStateExtra`'s blanket reset.
    ///
    /// Bumps `sessionEpoch` and mints a fresh `agentSessionId`, so anything
    /// tied to the outgoing session — in particular the auto-continue
    /// `asyncAfter` closure scheduled from `finishStreamingTurn` — can detect
    /// the switch and no-op instead of acting on the new session's history.
    func resetTransientSessionState() {
        agent.pendingTool = nil
        // A parked v2 approval belongs to the OUTGOING chat: left in place,
        // its card renders under the new chat's last assistant message and
        // Submit posts the old requestId with a still-valid sdkSessionId —
        // same user, so the server's tenancy check passes and the decision
        // genuinely lands in the wrong chat. Same staleness class as
        // `agent.pendingTool` above: drop the card, and the transport's
        // recorded SDK session id with it, so the next chat's submits can't
        // post against the old chat's SDK session either (its own `init`
        // event re-records the new id on the next turn).
        pendingApproval = nil
        agentV2Transport?.resetSdkSessionId()
        error = nil
        agent.nudgePrompt = nil
        agent.agentSessionId = UUID().uuidString
        agent.agentPendingTasks = []
        agent.planExecution = nil
        agent.agentIsAutonomous = false
        agent.agentStopRequested = false
        sessionEpoch += 1
        // Composer/attachment state the panel still owns (Task 14 moves it).
        // Order against the engine-owned resets above is immaterial — the two
        // sets of fields are disjoint.
        onResetTransientStateExtra()
    }

    /// Save a fresh session as the new current one, point all the bookkeeping
    /// (pointer, defaults, sessions list) at it, and reset transient state
    /// for a blank chat. Shared tail of `createNewSession` and the
    /// no-sessions-left branch of `deleteSession`.
    func mintFreshSession() {
        // D3 clean cut: the chat's engine is chosen HERE, once, at creation —
        // v2 iff the beta toggle is on at this moment — and never changes
        // after. Per-turn selection (`AgentV2EngineTransport.selectsV2`)
        // then requires the marker, so later toggle flips never migrate an
        // existing chat between engines.
        let fresh = ChatSession(scope: scope, engine: AgentV2Selection.engineForNewChat())
        ChatSessionStore.save(fresh)
        currentSessionIDString = fresh.id.uuidString
        rememberCurrentPointer()
        refreshSessions()
        messages = []
        resetTransientSessionState()
    }

    /// The loaded chat's engine marker (`ChatSession.engine`; nil = legacy,
    /// or no session loaded). Read at TURN time by the engine-selection
    /// transport and by view-level v2 affordances (`usesAgentV2Engine`).
    ///
    /// Memoized per session id (`engineMarkerMemo`): the marker is written
    /// once at mint and never changes, but this accessor sits on the
    /// streaming hot path, and decoding the whole session file per call
    /// stopped being cheap when the persist cap rose to 500 messages.
    func currentSessionEngineMarker() -> String? {
        guard let id = UUID(uuidString: currentSessionIDString) else { return nil }
        if let memo = engineMarkerMemo, memo.sessionID == currentSessionIDString {
            return memo.marker
        }
        let marker = ChatSessionStore.load(id: id)?.engine
        engineMarkerMemo = (sessionID: currentSessionIDString, marker: marker)
        return marker
    }

    /// Start a new empty chat for this scope. No-op if the current chat is
    /// already an untouched "New chat" (avoids duplicate empty rows from
    /// repeated taps on "+ New chat").
    func createNewSession() {
        if messages.isEmpty {
            let title = sessions.first(where: { $0.id.uuidString == currentSessionIDString })?.title ?? "New chat"
            if title == "New chat" || title.isEmpty { return }
        }
        // Finalize any in-flight stream BEFORE persisting — otherwise an
        // unfinished placeholder turn could be written to disk (see
        // resetActiveTurnState's doc comment).
        resetActiveTurnState()
        persistCurrentChat()
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
        persistCurrentChat()
        currentSessionIDString = id.uuidString
        rememberCurrentPointer()
        resetTransientSessionState()
        suppressHistoryAnnounce = true
        messages = session.messages
        onHistoryReplaced(session.messages)
        DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
        ChatSessionStore.save(session)
        refreshSessions()
    }

    /// Load `id` into a BRAND-NEW, otherwise-untouched engine — for a caller
    /// that needs to drive a turn against a session without going through
    /// `switchSession`'s side effects, which assume the engine already has
    /// something loaded that is visibly rendered somewhere: `resetActiveTurnState()`
    /// (finalizes/cancels a prior in-flight turn), `rememberCurrentPointer()`
    /// (overwrites the SCOPE's shared "last active chat" UserDefaults pointer
    /// — wrong for an engine nothing is displaying), and `resetTransientSessionState()`
    /// (bumps `sessionEpoch`, resets agent state).
    ///
    /// Added for Task 12's mobile-bridge fix (`ExplorerMobileEngineResolver`):
    /// a phone-driven turn for an `.explorer` session the Mac ISN'T currently
    /// showing must not alias — or mutate any bookkeeping belonging to — the
    /// shared, visibly-rendered engine. Instead the caller constructs a fresh
    /// `ChatEngine` and loads it via this method, which does only the two
    /// things a never-before-used engine actually needs: point it at the
    /// right session, and populate `messages` from disk.
    ///
    /// Returns `false` (no-op) if `id` doesn't exist or belongs to a
    /// different scope — same existence/scope contract as `switchSession`.
    @discardableResult
    func loadSessionForBackgroundUse(id: UUID) -> Bool {
        guard let session = ChatSessionStore.load(id: id), session.scope == scope else { return false }
        currentSessionIDString = id.uuidString
        messages = session.messages
        return true
    }

    /// Delete chat `id`. If it was the active chat, switch to the next most
    /// recent session, or mint a fresh empty one if none remain.
    ///
    /// `async` only because of the session-memory forget at the tail. Every
    /// state change below still happens before the first suspension point, so
    /// a caller's `Task { await engine.deleteSession(id) }` updates the UI in
    /// the same turn the panel's old synchronous call did.
    func deleteSession(_ id: UUID) async {
        // Captured once: the panel's version read `currentSessionIDString`
        // twice inside one synchronous body, so both reads saw the same value.
        let wasActive = id.uuidString == currentSessionIDString
        if wasActive { resetActiveTurnState() }
        ChatSessionStore.delete(id: id)
        refreshSessions()
        if wasActive {
            if let next = sessions.first {
                currentSessionIDString = next.id.uuidString
                rememberCurrentPointer()
                resetTransientSessionState()
                suppressHistoryAnnounce = true
                messages = next.messages
                onHistoryReplaced(next.messages)
                DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
            } else {
                // No sessions left for this scope — mint a blank one and
                // point everything (pointer, defaults, sessions list) at it.
                mintFreshSession()
            }
        }
        // Delete this chat's session memory (kb/session-memory.mjs — a real DB
        // table, distinct from project memory, which is durable and untouched
        // by this), so facts captured from a chat the user has thrown away
        // don't keep coming back in every later prompt. Last, and awaited
        // rather than detached: the chat file and the UI are already updated,
        // so a slow/failed forget delays nothing the user can see (and a
        // failure is recoverable by a later delete).
        await forgetSessionMemory(id.uuidString)
        // Also drop the chat's SERVER-SIDE v2 session mapping. Same
        // best-effort reasoning as the forget above — and same ordering: the
        // local delete already succeeded, so a slow or failed server call
        // can't block or roll it back (the wired client swallows failures
        // itself; a failure just leaves a stale mapping the server's
        // SESSION_UNRESUMABLE recovery cleans up on the next v2 turn).
        await deleteAgentV2Session(id.uuidString)
    }

    /// Header trash: delete the current chat (mints a fresh empty one if it
    /// was the last remaining session for this scope).
    func clearCurrentChat() async {
        guard let id = UUID(uuidString: currentSessionIDString) else {
            createNewSession()
            return
        }
        await deleteSession(id)
    }

    // MARK: - History change

    /// Persist the chat and announce a newly-arrived assistant turn — the
    /// panel's `handleHistoryChange`, driven by `.onChange(of: engine.messages)`.
    ///
    /// Only a GROWING history announces, and only when the new last turn is
    /// the assistant's: an in-place edit (streamed chunks land as content
    /// mutations on an existing turn) must not re-read the whole reply on
    /// every chunk. `suppressHistoryAnnounce` covers the two cases where the
    /// array does grow but nothing should be read aloud — a bulk session load
    /// and the empty streaming placeholder (`finishStreamingTurn` announces
    /// that one itself, once, with the complete text).
    ///
    /// The announcement goes through `sendAnnouncement` rather than
    /// `NSAccessibility.post` directly, so the engine stays AppKit-free and
    /// silent under test — same as `finishStreamingTurn`.
    func announceAndPersist(oldValue: [ChatMessage],
                            newValue: [ChatMessage]) {
        // Streamed text mutates `messages` in place many times per turn, and
        // each of those used to cost a synchronous session-file read + atomic
        // write on the MainActor. Debounce ONLY that case: every structural
        // change (a turn appended, a status finalized, a history replaced)
        // still writes immediately, exactly as before, so the only behavior
        // that changes is how often a half-streamed reply hits the disk.
        if revealingTurnID != nil {
            schedulePersist()
        } else {
            persistCurrentChat()
        }
        guard !suppressHistoryAnnounce else { return }
        if newValue.count > oldValue.count,
           let last = newValue.last,
           last.role == .assistant {
            let text = String(last.content.prefix(200))
            if !text.isEmpty {
                sendAnnouncement(text)
            }
        }
    }

}
