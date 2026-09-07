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
    ///
    /// The `.quick` scope keys per PROJECT: that chat follows the active
    /// project, so one global pointer would reload the previous project's
    /// conversation after a switch — the cross-project bleed `projectId`
    /// exists to stop, and filtering the session LIST alone does not stop it,
    /// because the engine loads by pointer, not by list.
    ///
    /// The panel scopes keep the unsuffixed key so their existing pointers
    /// keep resolving; changing them would silently orphan every user's
    /// current chat on upgrade.
    private var pointerKey: String {
        guard scope == .quick, let project = quickChatProjectId else {
            // A `.quick` engine reading its pointer before `quickChatProjectId`
            // is set is wired out of order: whoever resolved this engine
            // skipped `QuickChatContext.resolve(...)?.projectId` (or set it
            // too late), and the failure is otherwise silent — no error, no
            // log, just the previous project's conversation reloading after a
            // switch. Debug-only, matching `FeatureCatalog`'s precedent for
            // this class of bug.
            if scope == .quick {
                assertionFailure("quickChatProjectId is nil when the .quick pointer is read — set it before the engine's first session load")
            }
            return "chat.current.\(scope.rawValue)"
        }
        return "chat.current.\(scope.rawValue).\(project)"
    }

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
        // The fallback (file missing — deleted under us, or a pointer that
        // outlived its file) stamps `projectId` the same way
        // `mintFreshSession()` does, and for the same reason: a `.quick`
        // session written with `projectId == nil` is invisible to
        // `ChatSessionStore.list(for:projectId:)`, which reads a nil id as
        // belonging to NO project rather than to this one.
        var session = ChatSessionStore.load(id: id)
            ?? ChatSession(id: id, scope: scope, projectId: scope == .quick ? quickChatProjectId : nil)
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

    /// What to load when the current session is gone — never picked yet (on
    /// appear), or just deleted. ONE decision point for both callers below.
    ///
    /// This used to be hand-rolled separately in `handleOnAppearSessions()`
    /// and `deleteSession`, and when the `.quick` cross-project-bleed fix
    /// landed (this task's review, round 1) it was patched into ONLY the
    /// first copy — `deleteSession` kept the plain `sessions.first` fallback,
    /// so a user with quick chats in two projects who hit Clear in Project A
    /// could have `deleteSession` pick Project B's most-recent quick session,
    /// and the caller's `rememberCurrentPointer()` would then write PROJECT
    /// B's session id into PROJECT A's own pointer key — reopening the exact
    /// bleed the round-1 fix closed, through the second call site it missed.
    /// Two hand-narrowed copies of one fallback is how that happened; this
    /// helper exists so there is exactly one copy to narrow.
    ///
    /// Precondition: `sessions` (via `refreshSessions()`) reflects the
    /// current on-disk state — both callers refresh immediately before
    /// calling this.
    enum SessionFallback {
        /// Adopt this already-safe-to-adopt session (same scope, and — for
        /// `.quick` — implicitly the right project, because it never comes
        /// from the unfiltered `sessions` list for `.quick` at all).
        case adopt(ChatSession)
        /// No safe candidate: the caller should `mintFreshSession()`.
        case mintFresh
    }

    private func fallbackSessionAfterLoss() -> SessionFallback {
        // `.quick` must never adopt `sessions.first`: `sessions` comes from
        // `ChatSessionStore.list(for: scope)`, which is EVERY project's quick
        // sessions, unfiltered (see that method's doc comment) — adopting one
        // here, and the caller then calling `rememberCurrentPointer()` on it,
        // is exactly the cross-project bleed `quickChatProjectId`/the
        // per-project pointer key exist to stop. Always mint fresh instead;
        // the per-project pointer read (in `handleOnAppearSessions`) is the
        // ONLY legitimate way a `.quick` engine resumes a session.
        guard scope != .quick, let newest = sessions.first else {
            return .mintFresh
        }
        return .adopt(newest)
    }

    /// Resolve which chat this scope should show on appear: migrate any legacy
    /// per-scope file, load the session list, then restore the remembered
    /// pointer → fall back to the newest session (via `fallbackSessionAfterLoss()`,
    /// which mints fresh instead for `.quick`) → mint a fresh one. Sets
    /// `messages` itself (like every other session-swap method here) and
    /// returns it for the caller's convenience.
    ///
    /// Like `switchSession`/`deleteSession`, resets transient session state
    /// (`resetTransientSessionState()`) for whatever chat it lands on — on
    /// the pointer-found branch AND the `.adopt` fallback branch (the
    /// `.mintFresh` branch already gets it for free from `mintFreshSession()`
    /// itself). This was MISSING on both of those branches until code review
    /// caught it (Task 6 round 1): this method is the "load the incoming
    /// session" half for a plain first appearance (harmless — a freshly
    /// resolved engine has nothing stale to reset) AND, since
    /// `switchQuickChatProject(to:)` below reuses it, for a genuine
    /// session SWAP while the engine already has live turn/approval state
    /// from a DIFFERENT chat. Without the reset, that state — an outgoing
    /// chat's `agent.pendingTool`/`error`/`agent.nudgePrompt`, and critically
    /// `agentV2Transport`'s recorded `sdkSessionId` — carried into the
    /// newly-loaded chat, which for the SDK session id specifically means the
    /// new chat's next turn could RESUME the outgoing chat's server-side
    /// conversation instead of starting its own.
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
        // For `.quick`, the pointer must also resolve to a session belonging
        // to THIS project. The pointer key is already per-project, so this
        // only ever fires on a MIS-KEYED pointer — e.g. one written under the
        // unsuffixed `chat.current.quick` key by a release build that
        // stripped `pointerKey`'s assertion. Cheap defence in depth: a
        // mismatch takes the same path as a missing session (mint fresh for
        // `.quick`) instead of loading another project's conversation.
        if let cur = UUID(uuidString: currentSessionIDString),
           let session = ChatSessionStore.load(id: cur),
           session.scope == scope,
           scope != .quick || session.projectId == quickChatProjectId {
            resetTransientSessionState()
            messages = session.messages
            onHistoryReplaced(session.messages)
        } else {
            switch fallbackSessionAfterLoss() {
            case .adopt(let newest):
                currentSessionIDString = newest.id.uuidString
                resetTransientSessionState()
                messages = newest.messages
                onHistoryReplaced(newest.messages)
                rememberCurrentPointer()
            case .mintFresh:
                // No usable pointer and no safe saved chat to fall back to —
                // start one. (mintFreshSession clears `messages` itself, and
                // calls resetTransientSessionState() internally — do not call
                // it again here.)
                mintFreshSession()
            }
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
        // v2 iff the beta toggle is on at this moment AND the provider the
        // chat is born under can run the Agent engine — and never changes
        // after. Per-turn selection (`AgentV2EngineTransport.selectsV2`)
        // then requires the marker, so later toggle flips never migrate an
        // existing chat between engines.
        //
        // `.quick` also stamps `projectId` here: without it every minted
        // quick-chat session has `projectId == nil` on disk, invisible to
        // `ChatSessionStore.list(for:projectId:)` (which treats a nil id as
        // belonging to no project) — the exact overload the sheet's session
        // list needs. Scoped to `.quick` only; every other scope's minted
        // session is unaffected.
        let fresh = ChatSession(scope: scope, engine: AgentV2Selection.engineForNewChat(
            resolvedProvider: resolveNewChatProvider(),
            capableProviders: AgentV2Selection.liveAgentCapableProviders()),
            projectId: scope == .quick ? quickChatProjectId : nil)
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

    /// Finalize the in-flight turn and persist the outgoing chat — the shared
    /// prologue for every path that swaps `currentSessionIDString` away from
    /// whatever is currently loaded. Finalizes any in-flight stream BEFORE
    /// persisting — otherwise an unfinished placeholder turn could be written
    /// to disk (see `resetActiveTurnState`'s doc comment).
    ///
    /// Factored out (code review, Task 6 round 1) after this exact two-line
    /// sequence was hand-duplicated at `createNewSession`, `switchSession`,
    /// and — before this fix — a THIRD, ad hoc copy in `LlmChatSheet`'s
    /// project-switch handler that duplicated these two lines but had no way
    /// to know it also needed to route through the transient-state reset
    /// `handleOnAppearSessions()`'s loading branches perform (see that
    /// method's doc comment for the actual bug this closes). One private
    /// helper means a fourth swap path calls a named operation instead of
    /// re-deriving "which two engine calls does a session swap start with"
    /// from scratch.
    private func stopOutgoingTurnBeforeSwap() {
        resetActiveTurnState()
        persistCurrentChat()
    }

    /// Start a new empty chat for this scope. No-op if the current chat is
    /// already an untouched "New chat" (avoids duplicate empty rows from
    /// repeated taps on "+ New chat").
    func createNewSession() {
        if messages.isEmpty {
            let title = sessions.first(where: { $0.id.uuidString == currentSessionIDString })?.title ?? "New chat"
            if title == "New chat" || title.isEmpty { return }
        }
        stopOutgoingTurnBeforeSwap()
        mintFreshSession()
    }

    /// Switch the active chat to `id`, persisting the outgoing chat first.
    func switchSession(to id: UUID) {
        guard id.uuidString != currentSessionIDString else { return }
        guard let session = ChatSessionStore.load(id: id), session.scope == scope else { return }
        stopOutgoingTurnBeforeSwap()
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

    /// Swap `.quick` onto a different project's session — the engine-owned
    /// counterpart of `switchSession(to:)` for when the identity of the
    /// INCOMING session isn't a known id but "whatever `newProjectId`'s
    /// pointer resolves to." Called by `LlmChatSheet`'s
    /// `.onChange(of: projectStore.activeProject)` — the main window makes a
    /// project switch mid-conversation plausible, unlike the menu-bar
    /// popover.
    ///
    /// Runs the SAME `stopOutgoingTurnBeforeSwap()` prologue `switchSession`/
    /// `createNewSession` use — while `quickChatProjectId` STILL names the
    /// OUTGOING project, so `persistCurrentChat()` writes to the right file —
    /// then re-points `quickChatProjectId` and clears `currentSessionIDString`
    /// so `handleOnAppearSessions()` re-resolves the NEW project's pointer
    /// from scratch rather than reloading the outgoing project's id.
    /// `handleOnAppearSessions()` resets transient session state for whatever
    /// it lands on (see its doc comment) — the same guarantee `switchSession`/
    /// `deleteSession` give their callers — so the caller doesn't need to
    /// (and must not — see `resetTransientSessionState`'s own doc comment on
    /// ordering against `onHistoryReplaced`).
    ///
    /// `newProjectId == nil` (the project was CLOSED, not switched) is handled
    /// separately and does NOT fall through to `handleOnAppearSessions()`:
    /// that method's first act is reading `pointerKey`, and `pointerKey`'s
    /// `.quick` branch treats a nil `quickChatProjectId` as a WIRING bug
    /// (`assertionFailure` — correctly, since a `.quick` engine reading its
    /// pointer before anyone has resolved a project is a real defect
    /// elsewhere). "No project is open right now" is a different, entirely
    /// legitimate runtime state — conflating the two would either crash every
    /// debug build the instant a user closes their project with this chat
    /// open, or (release, where the assertion is stripped) silently reload/
    /// mint a session under the unsuffixed `chat.current.quick` key — the
    /// exact un-scoped global conversation Task 3's per-project pointer
    /// exists to forbid. So: finalize the outgoing chat, clear to the
    /// "nothing loaded" state a fresh engine starts in (`messages = []`,
    /// `currentSessionIDString = ""`), reset transient state for the same
    /// reason every other swap does, and STOP — there is no session to look
    /// up with no project, so nothing calls into `pointerKey` at all. The
    /// sheet's own no-project gate (`QuickChatContext.resolve(...) == nil`)
    /// already hides the composer for this state; this just makes sure the
    /// engine's OWN state matches "nothing is loaded" rather than leaking
    /// the outgoing project's transcript into a screen with no composer.
    func switchQuickChatProject(to newProjectId: String?) {
        assert(scope == .quick, "switchQuickChatProject called on a non-.quick engine")
        stopOutgoingTurnBeforeSwap()
        guard let newProjectId else {
            quickChatProjectId = nil
            currentSessionIDString = ""
            messages = []
            resetTransientSessionState()
            return
        }
        quickChatProjectId = newProjectId
        currentSessionIDString = ""
        handleOnAppearSessions()
    }

    /// Run `handleOnAppearSessions()` only when it's actually safe to read
    /// the pointer — i.e. not `.quick` with no project resolved yet. Guards
    /// the exact contract `pointerKey`'s `assertionFailure` protects (see
    /// `switchQuickChatProject(to:)`'s doc comment for the full reasoning):
    /// for `.quick`, "no session loaded yet" (`currentSessionIDString.isEmpty`)
    /// and "safe to resolve the pointer" are NOT the same condition — the
    /// FIRST appearance of either `MenuBarChatView` or `LlmChatSheet` can
    /// happen with no active project (the popover is always reachable; the
    /// sheet's own `.sheet` presentation isn't gated on a project either), and
    /// both used to call `handleOnAppearSessions()` unconditionally once
    /// `currentSessionIDString` was empty — hitting the SAME wiring-bug
    /// assertion `switchQuickChatProject(to: nil)` was fixed to avoid, just
    /// from the other direction (first appearance vs. project closed
    /// mid-session). One guard, used by both `.onAppear`s, so a third surface
    /// can't reintroduce this by hand-copying the unguarded call again.
    ///
    /// Every non-`.quick` scope is unaffected: `quickChatProjectId` is never
    /// set for them, so `scope != .quick` short-circuits this guard to always
    /// pass, and behavior is identical to calling `handleOnAppearSessions()`
    /// directly.
    @discardableResult
    func handleOnAppearSessionsIfReady() -> [ChatMessage]? {
        guard scope != .quick || quickChatProjectId != nil else { return nil }
        return handleOnAppearSessions()
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
    /// recent session (via `fallbackSessionAfterLoss()`, which mints fresh
    /// instead for `.quick` rather than risking a different project's
    /// session), or mint a fresh empty one if none remain.
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
            switch fallbackSessionAfterLoss() {
            case .adopt(let next):
                currentSessionIDString = next.id.uuidString
                rememberCurrentPointer()
                resetTransientSessionState()
                suppressHistoryAnnounce = true
                messages = next.messages
                onHistoryReplaced(next.messages)
                DispatchQueue.main.async { [self] in suppressHistoryAnnounce = false }
            case .mintFresh:
                // No safe session to fall back to for this scope — mint a
                // blank one and point everything (pointer, defaults, sessions
                // list) at it.
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
