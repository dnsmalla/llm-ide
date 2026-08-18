import Foundation

/// Live state of ONE parked `AskUserQuestion` the v2 engine is blocking on.
///
/// Held by `ChatEngine.pendingApproval` (not the raw `AgentV2Approval`) so
/// the card can render submit/error status that changes after arrival: a
/// failed decision POST records `lastError` and KEEPS the card so the user
/// can retry, and only a server-accepted answer (`{ok:true}`) marks it
/// `submitted` and lets the engine drop it. `@Observable` for the same
/// reason every other engine state is: `ApprovalQuestionCard` binds to it
/// and must re-render when the submit outcome lands.
@MainActor
@Observable
final class AgentV2ApprovalState {
    let approval: AgentV2Approval
    /// True only after the server ACCEPTED a decision for this approval.
    /// Stays false through retries — a failed POST is not a submission.
    private(set) var submitted = false
    /// Last submit failure, surfaced on the card next to the retry affordance.
    /// Cleared implicitly: a state that succeeded is dropped, and a NEW
    /// approval mints a fresh state.
    private(set) var lastError: String?

    init(approval: AgentV2Approval) {
        self.approval = approval
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

    /// True when this engine carries the v2 machinery AND the beta toggle
    /// currently selects it — the per-turn rule minus the per-turn provider,
    /// which is exactly what view-level affordances keyed to "this is a v2
    /// chat" (the save-plan message action) need. Mirrors the selection the
    /// transport itself applies each turn, so the two can't drift.
    var usesAgentV2Engine: Bool {
        agentV2Transport != nil && AgentV2Selection.toggleEnabled()
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
    func handleApprovalArrival(_ approval: AgentV2Approval) {
        pendingApproval = AgentV2ApprovalState(approval: approval)
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
}
