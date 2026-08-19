import Foundation

/// Live state of ONE parked approval either chat engine is blocking on —
/// an `AskUserQuestion` (v2 only, P1) or a `ToolApproval` (either engine,
/// P2; see `AgentV2Approval.kind`).
///
/// Held by `ChatEngine.pendingApproval` (not the raw `AgentV2Approval`) so
/// the card can render submit/error status that changes after arrival: a
/// failed decision POST records `lastError` and KEEPS the card so the user
/// can retry, and only a server-accepted answer (`{ok:true}`) marks it
/// `submitted` and lets the engine drop it. `@Observable` for the same
/// reason every other engine state is: `ApprovalQuestionCard`/
/// `ToolApprovalCard` bind to it and must re-render when the submit outcome
/// lands.
@MainActor
@Observable
final class AgentV2ApprovalState {
    let approval: AgentV2Approval
    /// The legacy chat's own `agentContext.sessionId` at the moment this
    /// approval arrived — captured because the legacy `CodeAssistTransport`
    /// (unlike `AgentV2Transport`, which persists its `sdkSessionId` across
    /// the turn) holds no session state of its own. Nil for a v2-engine
    /// approval, which instead reads `ChatEngine.agentV2SessionId` at submit
    /// time; `submitToolDecision` picks whichever is non-nil for the
    /// engine actually holding this approval.
    let legacySessionId: String?
    /// True only after the server ACCEPTED a decision for this approval.
    /// Stays false through retries — a failed POST is not a submission.
    private(set) var submitted = false
    /// Last submit failure, surfaced on the card next to the retry affordance.
    /// Cleared implicitly: a state that succeeded is dropped, and a NEW
    /// approval mints a fresh state.
    private(set) var lastError: String?

    init(approval: AgentV2Approval, legacySessionId: String? = nil) {
        self.approval = approval
        self.legacySessionId = legacySessionId
    }

    func markSubmitted() {
        submitted = true
    }

    func recordSubmitFailure(_ message: String) {
        lastError = message
    }
}

/// The approval surface of `ChatEngine` — pending state, the transport's
/// `onApproval` sink, and the submit/dismiss actions. Split into this file
/// alongside `AgentV2ApprovalState` the same way the external-turn and
/// panel-write surfaces split out of ChatEngine.swift; the stored state
/// itself (`pendingApproval`, `postApprovalDecision`) lives in that file
/// because extensions can't hold stored properties.
extension ChatEngine {

    /// Note recorded into the streaming turn's tool steps (and forwarded to
    /// the phone's live progress channel) when an approval parks during an
    /// EXTERNAL turn. The pause glyph reads at a glance in the step list;
    /// "on Mac" tells the phone user WHERE the interactive card lives — the
    /// phone mirrors the transcript but cannot render the card itself.
    static let externalApprovalNote = "⏸ Question pending on Mac…"

    /// True while an EXTERNAL (phone-driven) turn is executing on this
    /// engine. `runExternalTurn` stores `externalRunTask` before the turn
    /// body runs and the body itself clears it (via `drainQueueOrRelease`)
    /// only at its tail, so non-nil here reliably means "a phone-driven turn
    /// is mid-flight" — the signal the approval path uses to decide whether
    /// the Mac-pending note is needed.
    var isExternalTurn: Bool { externalRunTask != nil }

    /// The engine's v2 transport, unwrapped through EITHER shape it takes —
    /// bare (`AgentV2Transport`) or behind the engine-selection composite
    /// (`AgentV2EngineTransport.v2`), which is what the factory installs
    /// when the beta toggle is on. Nil for plain legacy engines.
    var agentV2Transport: AgentV2Transport? {
        if let direct = transport as? AgentV2Transport { return direct }
        return (transport as? AgentV2EngineTransport)?.v2
    }

    /// The v2 transport's most recent SDK session id (off its `init` event).
    /// The decision POST tenancy-checks requestId + sdkSessionId + user, so
    /// `submitApproval` reads this at submit time. Nil for legacy transports,
    /// which never park approvals — and nil then is harmless, because no
    /// card exists to submit from.
    var agentV2SessionId: String? {
        agentV2Transport?.sdkSessionId
    }

    /// True when this engine carries the v2 machinery, the beta toggle
    /// currently selects it, AND the loaded chat is a v2 chat (its engine
    /// marker) — the per-turn rule minus the per-turn provider, which is
    /// exactly what view-level affordances keyed to "this is a v2 chat"
    /// (the save-plan message action) need. Mirrors the selection the
    /// transport itself applies each turn, so the two can't drift.
    var usesAgentV2Engine: Bool {
        agentV2Transport != nil
            && AgentV2Selection.toggleEnabled()
            && currentSessionEngineMarker() == AgentV2Selection.sessionEngineV2
    }

    /// Sink for the transport's 4-callback `onApproval`. Called by every
    /// round-trip site (runTurn / sendFollowup / performExternalTurn), so the
    /// card appears for Mac-driven and phone-driven turns alike — the Mac
    /// panel owns the shared engine either way, and rendering is deliberately
    /// NOT gated on the turn's origin.
    ///
    /// During an EXTERNAL turn the phone's mirrored transcript also needs to
    /// say WHY the turn went quiet, so the note rides the same road a tool
    /// step takes (`recordProgress`): it lands in the streaming message's
    /// `toolSteps`, persisted with the turn and visible wherever the session
    /// renders.
    func handleApprovalArrival(_ approval: AgentV2Approval, legacySessionId: String? = nil) {
        pendingApproval = AgentV2ApprovalState(approval: approval, legacySessionId: legacySessionId)
        guard isExternalTurn else { return }
        recordProgress(LlmIdeAPIClient.AgentProgress(
            label: Self.externalApprovalNote, phase: "tool", tool: nil, detail: nil
        ))
    }

    /// Posts the user's answers for the parked approval via
    /// `POST /agent/v2/decision` (`postApprovalDecision` — the panel wires
    /// the real `LlmIdeAPIClient.agentV2Decision`, tests script a double).
    ///
    /// On `{ok:true}` the state is marked submitted and dropped. On `false`
    /// or a thrown error the state SURVIVES with `lastError` set, so the
    /// card stays up and the user can retry — a failed POST answered
    /// nothing server-side.
    func submitApproval(answers: [String: String]) async {
        guard let state = pendingApproval else { return }
        guard let sdkSessionId = agentV2SessionId else {
            state.recordSubmitFailure("No SDK session id for this engine — cannot post the decision. Try a new turn.")
            return
        }
        do {
            let ok = try await postApprovalDecision(state.approval.requestId, sdkSessionId, answers)
            guard ok else {
                state.recordSubmitFailure("The server declined the decision. Check the answer and retry.")
                return
            }
            state.markSubmitted()
            // Identity-checked: if a second approval REPLACED this state while
            // the POST was in flight, its card must not be dropped for a
            // decision that answered the old question.
            if pendingApproval === state {
                pendingApproval = nil
            }
        } catch {
            state.recordSubmitFailure(error.localizedDescription)
        }
    }

    /// Drops the pending card WITHOUT posting anything. The server expires an
    /// unanswered approval on its own (the registry timeout / turn abort
    /// paths deny it), so dismissal is purely client-side teardown.
    func dismissApproval() {
        pendingApproval = nil
    }

    /// Posts the user's decision for a parked `ToolApproval` — `action` is
    /// one of "deny" | "allow" | "always-allow", never an `answers`
    /// dictionary (that shape is `AskUserQuestion`-only; see
    /// `submitApproval`). Routes to whichever engine actually holds this
    /// approval: the v2 transport's `agentV2SessionId` (`POST
    /// /agent/v2/decision`, Task 7) if present, else the state's own
    /// `legacySessionId` (`POST /code-assist/decision`, Task 8) — a v2 and a
    /// legacy engine never coexist on one `ChatEngine`, so exactly one of
    /// the two is ever available for a given approval.
    ///
    /// Same submit/retry contract as `submitApproval`: `{ok:true}` marks the
    /// state submitted and drops the card (identity-checked against a
    /// possible replacement while the POST was in flight); anything else
    /// records `lastError` and keeps the card up for a retry.
    func submitToolDecision(action: String) async {
        guard let state = pendingApproval else { return }
        do {
            let ok: Bool
            if let sdkSessionId = agentV2SessionId {
                ok = try await postToolDecision(state.approval.requestId, sdkSessionId, action)
            } else if let legacySessionId = state.legacySessionId {
                ok = try await postLegacyToolDecision(state.approval.requestId, legacySessionId, action)
            } else {
                state.recordSubmitFailure("No session id for this engine — cannot post the decision. Try a new turn.")
                return
            }
            guard ok else {
                state.recordSubmitFailure("The server declined the decision. Try again.")
                return
            }
            state.markSubmitted()
            if pendingApproval === state {
                pendingApproval = nil
            }
        } catch {
            state.recordSubmitFailure(error.localizedDescription)
        }
    }
}
