import Foundation

/// Panel-driven writes into `ChatEngine` — synthetic tool-result acks,
/// `acknowledge`'s follow-up policy, content replacement for externally
/// produced turns, and the Loop-run slot claim. Split out of
/// ChatEngine.swift in Task 17 as a pure mechanical move.
extension ChatEngine {
    // MARK: - Panel-driven writes
    //
    // `messages` is `private(set)` because the engine owns the turn lifecycle.
    // These are the narrow openings the panel still needs, each matching one
    // thing it did directly when it owned the array.

    /// Append a synthetic turn the PANEL produced: the "(executed create-issue
    /// → …)" / "(bash result …)" / "(applied update to …)" acknowledgements
    /// every client-executed tool writes so the agent sees its own result as
    /// conversation context, and the placeholder a chat-triggered Loop run
    /// streams its log into.
    ///
    /// Still takes a WIRE turn — the confirmers in `CodeAssistant+Bash/Git/
    /// Edits/Issues/PR.swift` legitimately produce those strings (that text is
    /// what the agent has to read back on the next round-trip), and they are
    /// unchanged by Task 9. What changed is that the string is classified
    /// ONCE, here, the moment it enters the transcript: `ChatMessage.migrate`
    /// turns it into a typed `.toolResult` message, so nothing downstream —
    /// least of all the view — ever sniffs it again.
    ///
    /// Returns the new message's id: the message gets its own (the caller's
    /// `CodeAssistTurn.id` is a throwaway client-side value), and the
    /// chat-triggered Loop run needs that handle to stream into via
    /// `setTurnContent`.
    @discardableResult
    func appendTurn(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> UUID {
        let message = ChatMessage(wireTurn: turn, sessionDate: Date())
        messages.append(message)
        return message.id
    }

    /// How (if at all) `acknowledge` should re-invoke the agent after
    /// appending a client-executed tool's result.
    ///
    /// The two "yes" cases are NOT interchangeable — picking the wrong one
    /// reintroduces exactly the bug Task 10's code review caught: forcing a
    /// follow-up through while an autonomous turn is already mid-stream
    /// starts a second concurrent `/code-assist` round-trip (two streaming
    /// placeholders racing `revealingTurnID`, and `runTask` tracking only one
    /// of them, so Stop can't cancel both).
    enum FollowUp {
        /// Don't start a follow-up turn.
        case none
        /// Start one only if the engine is idle — routes through plain
        /// `sendFollowup()`, which no-ops under its own `!busy` guard. This is
        /// the right choice for every confirmer that runs from a USER-DRIVEN
        /// sheet tap (create/comment/update issue, create PR, create branch):
        /// the tap can race the 0.8s auto-continue window
        /// `finishStreamingTurn` schedules after a `pendingTool` turn, and if
        /// an autonomous turn is already mid-stream when the sheet confirms,
        /// the follow-up should be silently skipped exactly as the old
        /// `sendFollowup()` call at those sites always did — not forced
        /// through.
        case ifIdle
        /// Force the engine out of `busy` and start a follow-up
        /// unconditionally — routes through `unblockAndFollowUp()`. Reserved
        /// for a confirmer whose action can legitimately run from INSIDE a
        /// turn that already set `busy = true` (the Bypass-mode auto-chain
        /// path through `autoChainPendingAction`: bash / update-file / git-op
        /// executed without a card) — there, `busy` would otherwise stay
        /// stuck `true` forever, because nothing else clears it until this
        /// ack's own follow-up runs.
        case forceUnblock
    }

    /// Append a client-executed tool's result as a typed `.toolResult`
    /// message, then apply `followUp` to decide whether (and how) to
    /// re-invoke the agent so it can react to it in natural language.
    ///
    /// This is what the confirmers in `CodeAssistant+Bash/Git/Issues/PR.swift`
    /// and `CodeAssistantPanel+Session.swift`/`+Edits.swift` call now (Task
    /// 10) instead of each building its own synthetic ack STRING and passing
    /// it through `appendTurn` to be classified back into a payload via
    /// `ChatMessage.migrate`: they build the typed `ToolResultPayload`
    /// directly, and `payload.legacyContent()` is what still reconstructs the
    /// exact string the server has always read on the wire — nothing about
    /// that contract changes here, only where the classification work used to
    /// happen (on the way OUT of a string) now happens on the way IN.
    ///
    /// See `FollowUp`'s own cases for which one a given call site needs —
    /// they are not interchangeable.
    func acknowledge(_ payload: ChatMessage.ToolResultPayload, followUp: FollowUp) async {
        let message = ChatMessage(
            role: .toolResult,
            content: payload.legacyContent(),
            status: .done,
            createdAt: Date(),
            toolResult: payload
        )
        messages.append(message)
        switch followUp {
        case .none:
            break
        case .ifIdle:
            await sendFollowup()
        case .forceUnblock:
            await unblockAndFollowUp()
        }
    }

    /// Replace the content of an existing message, addressed by id. No-op when
    /// the id is gone (the session was switched out from under a long-running
    /// producer) — deliberately, so a stale writer can't resurrect a turn into
    /// a chat it doesn't belong to.
    func setTurnContent(id: UUID, _ content: String) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].content = content
    }

    /// Replace `messages` wholesale from an externally-sourced transcript —
    /// e.g. `LlmChatViewModel.loadHistory()`'s periodic poll of the
    /// server-persisted `/kb/agent/ask` history. Unlike `switchSession`/
    /// `handleOnAppearSessions`, this does NOT touch `ChatSessionStore`, the
    /// current-chat pointer, or transient/agent state — a caller that isn't
    /// backed by this engine's disk session store (the LLM Chat sheet's
    /// history lives server-side, not in a `ChatSession` file) just wants the
    /// in-memory transcript kept in sync with the source of truth. Callers
    /// are responsible for not calling this mid-turn (would clobber the
    /// in-flight streaming placeholder) — `busy` is intentionally not
    /// asserted here so a test can drive it directly.
    func replaceMessages(_ msgs: [ChatMessage]) {
        messages = msgs
    }

    /// Claim the turn slot for a run the PANEL executes itself — one that
    /// streams into an assistant turn rather than going through `transport`.
    /// Applies the same start-of-turn resets `runTurn` does, for the same
    /// reasons: a stale action card left interactive under the new "latest
    /// assistant turn" can run its own completion handler and clear `busy`
    /// out from under the run, and a leftover status/error line would render
    /// as if it belonged to it.
    ///
    /// Idempotent, and paired with `drainQueueOrRelease()` at the end of the
    /// run so a message queued during it is still drained.
    func beginPanelRun() {
        busy = true
        agent.pendingTool = nil
        statusText = ""
        error = nil
    }

    /// Hand the engine the handle for a panel-driven run, so the composer's
    /// existing Stop button (`stop()`) cancels it like any other turn.
    func setRunTask(_ task: Task<Void, Never>?) {
        runTask = task
    }

}
