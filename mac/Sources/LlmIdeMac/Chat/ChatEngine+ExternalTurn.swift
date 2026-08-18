import Foundation

/// The external (phone-driven) turn surface of `ChatEngine` —
/// `runExternalTurn` and its error type. Split out of ChatEngine.swift in
/// Task 17 as a pure mechanical move; the method's own doc comment carries
/// the full design rationale (session-identity guards, suppressed
/// auto-continue/auto-chain, the engine-owned task handle).
extension ChatEngine {
    // MARK: - External turn (mobile bridge)

    /// One turn driven by a non-view client (today: the iPhone's
    /// `explore_chat`, via `MobileControlManager.handleExploreChat` —
    /// Task 12). This is a 1:1 mirror of `runTurn`'s own body — append the
    /// user turn, stream, finalize, auto-chain, persist, drain the queue —
    /// NOT a parallel reimplementation, so the two can never quietly drift.
    ///
    /// It takes its transport input as explicit parameters instead of
    /// through `resolveTransportInput`/`attachmentsForTurn`: those hooks are
    /// wired to the PANEL's own environment state (model picker,
    /// `prefLanguage`, active-repo context) in `CodeAssistantPanel.wireEngine()`,
    /// and are still the no-op default pass-through if the panel has never
    /// appeared for this scope — a phone-driven turn must resolve its
    /// model/provider/context from the Mac's OWN settings
    /// (`MobileExploreBridge`) regardless of whether the Explorer tab is
    /// even open.
    ///
    /// Callers are responsible for making sure the engine is already ON the
    /// target session (`switchSession(to:)` first, if it isn't the active
    /// one already) — this operates on whatever session is CURRENTLY loaded,
    /// exactly like `runTurn`.
    ///
    /// `expectedSessionID` is the session the CALLER resolved this engine
    /// for — code review (post `45d36c6`/`85cc5a1`) found that resolving the
    /// engine, then `await`ing context-building work that can take hundreds
    /// of ms to seconds (`MobileExploreBridge.buildAgentContext`'s `git`
    /// subprocesses) BEFORE calling this method, reopens the exact hijack
    /// the resolver fix closed: the shared engine can be switched to a
    /// different session by the Mac user during that window, after the
    /// caller resolved it but before this method actually runs. Moving the
    /// resolve call later (right before this call, in
    /// `MobileControlManager.handleExploreChat`) narrows that window but
    /// cannot close it — this method itself has its own suspension points
    /// (`transport.roundTrip`). The guard right below is what actually
    /// closes it: checked synchronously, on the SAME actor, immediately
    /// before this method does anything observable, so no in-between
    /// `await` can invalidate it.
    ///
    /// Guards on `!busy` and throws `ExternalTurnError.busy` rather than
    /// silently queuing or racing: `runTurn`/`sendFollowup` mutate
    /// `messages`/`revealingTurnID`/`runTask` assuming only one turn is ever
    /// in flight at a time, and this engine is now SHARED (registry-cached)
    /// with the Mac panel — a concurrent Mac-driven turn on the same
    /// instance racing this one would corrupt that bookkeeping exactly as
    /// Task 10's review found for `sendFollowup`'s own `!busy` guard. The
    /// phone gets a clear, typed "try again" error instead of an unexplained
    /// hang or a corrupted transcript.
    ///
    /// Deliberately suppresses the `continueNeeded` auto-continue path (a
    /// phone-driven turn's `finishStreamingTurn` call always passes
    /// `continueNeeded: nil`, never `resp.continueNeeded`): the scheduled
    /// "Continue working on your pending tasks." follow-up re-enters through
    /// `startTurn`/`runTurn`, which uses the ENGINE's `resolveTransportInput`/
    /// `attachmentsForTurn` hooks (the panel's wiring if a panel has wired
    /// them, or the silent no-op default otherwise) — never the explicit
    /// model/provider/context this call was given. On the shared engine with
    /// a panel open, that means a phone turn could silently auto-execute a
    /// follow-up (file edits/bash/git ops, if `autoChain` proposes one) with
    /// no phone confirmation and no card; on an off-screen engine, the
    /// follow-up's `persistCurrentChat()` never runs through the resolver's
    /// cache-refresh path, so the work is silently discarded the next time
    /// that session is resolved. Neither surface is safe for autonomous
    /// follow-up work today — suppressing it is the tradeoff; making it
    /// safe (proper off-screen wiring, a phone-side confirmation channel) is
    /// future work, not this fix.
    ///
    /// The SAME suppression applies to `autoChain`: a phone-driven turn
    /// never auto-executes a proposed tool (bash/update-file/git-op), even
    /// on the shared engine where the panel's Bypass/Auto wiring would
    /// otherwise run it hands-free with no phone confirmation. The proposal
    /// still lands on `agent.pendingTool` (finishStreamingTurn below), so a
    /// Mac panel renders the confirmation card — today the one surface that
    /// can act on it. A phone-side confirmation channel is the future work
    /// that would lift this.
    func runExternalTurn(
        message: String,
        skillIds: [String],
        attachments: [LlmIdeAPIClient.CodeAttachment],
        agentContext: AgentContext?,
        model: String?,
        provider: String?,
        expectedSessionID: UUID,
        onProgress: @escaping (String) -> Void
    ) async throws -> String {
        guard !busy else { throw ExternalTurnError.busy }
        guard currentSessionIDString == expectedSessionID.uuidString else {
            throw ExternalTurnError.sessionMoved
        }
        // Claim the slot synchronously — the spawn below is a scheduling
        // boundary, and without this a Mac-driven turn could start between
        // the guard and the body's own `busy = true`.
        busy = true
        // The turn body runs as an unstructured task the ENGINE owns and
        // tracks in `externalRunTask`, so `stop()` (the Mac panel's Stop
        // button) and `resetActiveTurnState()` (session switch/create/delete)
        // can cancel a phone-driven turn exactly like a panel-driven one —
        // until this existed, `runTask` was never set for external turns and
        // the Mac's Stop button was inert while a phone turn streamed on the
        // shared engine. Cancellation reaches the inner task from BOTH
        // surfaces: Mac-side stop()/reset cancel `externalRunTask` directly;
        // phone-side explore_cancel cancels the task awaiting this method —
        // which does NOT propagate on its own (awaiting an unstructured
        // task's value is not cancellation-responsive) — so the
        // withTaskCancellationHandler below bridges it onto the inner task.
        //
        // The wrapper deliberately never clears `externalRunTask` itself:
        // the body releases `busy` (drainQueueOrRelease) before this await
        // resumes, and a SECOND external turn may have stored its own handle
        // in that window — an unconditional clear here would orphan it and
        // re-break Stop for the newer turn. The clear lives where completion
        // is actually known: drainQueueOrRelease's idle branch.
        let task = Task { [self] in
            try await performExternalTurn(
                message: message, skillIds: skillIds, attachments: attachments,
                agentContext: agentContext, model: model, provider: provider,
                expectedSessionID: expectedSessionID, onProgress: onProgress)
        }
        externalRunTask = task
        do {
            let reply = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                // The phone cancelled its awaiting task; propagate.
                task.cancel()
            }
            return reply
        } catch {
            task.cancel()
            // When this catch fired, the inner task had already completed —
            // task.value rethrows a stored error immediately — so this
            // re-await is instantaneous; it exists only to cover the outer-
            // cancellation path, where the cancel above is what makes the
            // inner finish (its catch finalizes the placeholder + persists
            // + releases the slot before this resolves).
            _ = try? await task.value
            throw error
        }
    }

    /// The body of one external turn — everything after `runExternalTurn`'s
    /// busy/session guards. Only that wrapper calls it; the split exists so
    /// the engine can hold a cancellable handle to the turn.
    private func performExternalTurn(
        message: String,
        skillIds: [String],
        attachments: [LlmIdeAPIClient.CodeAttachment],
        agentContext: AgentContext?,
        model: String?,
        provider: String?,
        expectedSessionID: UUID,
        onProgress: @escaping (String) -> Void
    ) async throws -> String {
        // Body-start re-checks. The entry guards ran in the wrapper one
        // main-actor hop ago and the spawn in between is a scheduling
        // boundary: switchSession/createNewSession/deleteSession have no
        // busy-check and can interleave in that hop, leaving this body to
        // start against a DIFFERENT session — and resetActiveTurnState's
        // cancel() is only a flag, it cannot stop the prologue below from
        // appending the phone's turn into (and persisting it to) the
        // newly-active chat. Re-assert both before any state mutation;
        // each early exit releases the slot the wrapper claimed, since the
        // do/catch tail below is never reached on these paths.
        if Task.isCancelled {
            drainQueueOrRelease()
            throw CancellationError()
        }
        guard currentSessionIDString == expectedSessionID.uuidString else {
            drainQueueOrRelease()
            throw ExternalTurnError.sessionMoved
        }
        onTurnStart()
        onRecordPrompt(message)
        onNudge(message)
        messages.append(ChatMessage(role: .user, content: message, status: .done, createdAt: Date()))
        busy = true
        statusText = ""
        error = nil
        agentV2Notice = nil
        agent.pendingTool = nil
        agent.agentPendingTasks = []
        // Stale v2 approval card — same turn-start rule as runTurn.
        pendingApproval = nil
        // Persist the user turn immediately, mirroring the old
        // MobileControlManager behavior of writing it before the round
        // trip starts — disk should not lag a full round-trip behind in
        // case the app quits mid-turn. A panel showing this SAME instance
        // already sees it live via `messages` regardless of this write.
        persistCurrentChat()
        let streamingID = beginStreamingTurn()
        do {
            let recent = packHistory(messages)
            let input = ChatTransportInput(
                message: message,
                history: Array(recent.dropLast()),  // exclude the just-pushed user turn — server appends it
                attachments: attachments,
                skills: skillIds,
                agentContext: agentContext,
                language: nil,
                model: model,
                provider: provider,
                mode: nil
            )
            let resp = try await transport.roundTrip(
                input,
                onProgress: { [self] progress in
                    recordProgress(progress)
                    onProgress(progress.label)
                },
                onChunk: { [self] text in appendStreamedChunk(streamingID, text) },
                onApproval: { [self] approval in
                    handleApprovalArrival(approval)
                    // handleApprovalArrival recorded the Mac-pending note
                    // into the turn's tool steps for the mirrored transcript;
                    // the phone's LIVE label channel doesn't observe
                    // engine-side recordProgress calls, so forward the note
                    // the same way every other progress label reaches it.
                    onProgress(Self.externalApprovalNote)
                }
            )
            try Task.checkCancellation()
            // Second race, found by code review after the entry guard above:
            // `transport.roundTrip` can take seconds, and NOTHING stops the
            // Mac user from clicking a different chat while it's in flight —
            // `ChatSessionHeader`'s switch action calls `switchSession(to:)`
            // directly, with no busy check, which finalizes/persists THIS
            // session and overwrites `messages`/`currentSessionIDString` with
            // the other one's. Without this re-check, everything below would
            // run against whatever is CURRENTLY loaded — appending the reply,
            // firing `autoChain` (auto-executing a file edit/bash/git op),
            // and persisting, all into a conversation this turn was never
            // about. Bail out instead: hand the phone its answer, but don't
            // touch `messages`/`agent` or persist into the wrong session.
            // Session A is left with whatever `resetActiveTurnState` already
            // finalized it to (the `.stopped` partial, no full reply) — a
            // best-effort tradeoff matching `sessionMoved`'s entry-race one,
            // not something this call can safely repair from here.
            guard currentSessionIDString == expectedSessionID.uuidString else {
                return resp.reply
            }
            if let idx = messages.firstIndex(where: { $0.id == streamingID }) {
                messages[idx].content = resp.reply
            }
            finishStreamingTurn(
                streamingID,
                pendingTool: resp.pendingTool,
                tasks: resp.tasks,
                continueNeeded: nil,  // see doc comment: external turns never auto-continue
                usage: resp.usage,
                mode: resp.mode,
                stopped: false
            )
            // No autoChain here either — see doc comment: a phone-driven
            // turn never auto-executes a proposed tool. The card lands on
            // `agent.pendingTool` via finishStreamingTurn above; a Mac panel
            // (when the shared engine has one) renders the confirmation.
            persistCurrentChat()
            drainQueueOrRelease()
            return resp.reply
        } catch {
            // Same mid-flight session-switch race as the success path above,
            // applied to the failure path: none of this catch's side effects
            // (error banner, `.failed` status, persist) may land on whatever
            // session is now loaded if it isn't the one this call started on.
            guard currentSessionIDString == expectedSessionID.uuidString else {
                throw error
            }
            let isCancellation = error is CancellationError || (error as? URLError)?.code == .cancelled
            if revealingTurnID == streamingID {
                finishStreamingTurn(streamingID, pendingTool: nil, tasks: nil, continueNeeded: nil, usage: nil, mode: nil, stopped: true)
            }
            if !isCancellation {
                self.error = error.localizedDescription
                markFailed(streamingID, error)
            }
            persistCurrentChat()
            drainQueueOrRelease()
            throw error
        }
    }
}

/// Thrown by `ChatEngine.runExternalTurn` when it can't safely proceed. See
/// that method's doc comment for why these are typed errors rather than a
/// silent queue/no-op or a turn landing in the wrong place.
enum ExternalTurnError: LocalizedError {
    /// The engine is already running another turn.
    case busy
    /// The engine's active session changed between when the CALLER resolved
    /// it and when this call actually started — e.g. the Mac user switched
    /// the shared engine to a different chat during the `await`s
    /// (context-building, etc.) between resolve and this call. Thrown
    /// instead of silently appending the turn into whatever session happens
    /// to be current now.
    case sessionMoved

    var errorDescription: String? {
        switch self {
        case .busy: return "This chat is busy with another turn — try again in a moment."
        case .sessionMoved: return "That chat is no longer open on your Mac — try again."
        }
    }
}
