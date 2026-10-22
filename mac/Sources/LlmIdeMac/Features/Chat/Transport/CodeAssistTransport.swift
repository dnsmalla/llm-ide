import Foundation

/// Real `ChatTransport` — thin wrapper over `LlmIdeAPIClient`'s streaming
/// code-assist endpoint, with the same one-shot buffered fallback
/// `codeAssistRoundTrip` has always done: a transport-level failure (never a
/// server-reported application error) retries once on the buffered endpoint
/// so a streaming/parse bug can't break the feature outright.
///
/// A class (not the struct it started as) solely for `onLiveTasks`: the
/// engine-selection composite holds its legacy transport as a `let`
/// existential, and a callback wired after construction has to land on the
/// same instance the round trips run on. `@MainActor` (like
/// `AgentV2Transport`) rather than `@unchecked Sendable`, so that mutable
/// callback is written and read on one actor instead of racing a round trip
/// running off the main actor.
@MainActor
final class CodeAssistTransport: ChatTransport {
    let api: LlmIdeAPIClient

    /// Mid-turn task list from the stream's `tasks_progress` events (server
    /// v42+). Same contract as `AgentV2Transport.onLiveTasks`: display only,
    /// never drives auto-continue — the terminal `tasks` event stays the
    /// authoritative list on the returned result. Nil (older servers send no
    /// such events) simply leaves progress turn-granular, as before.
    var onLiveTasks: (@MainActor ([AgentTask]) -> Void)?

    init(api: LlmIdeAPIClient) {
        self.api = api
    }

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        do {
            let response = try await api.codeAssistStream(
                message: input.message, language: input.language, model: input.model,
                provider: input.provider, history: input.history, attachments: input.attachments,
                skills: input.skills, agentContext: input.agentContext, mode: input.mode,
                planExecute: input.planExecute, planWrite: input.planWrite,
                questionCard: input.questionCard,
                onProgress: onProgress, onChunk: onChunk,
                onLiveTasks: onLiveTasks)
            return ChatTransportResult(response)
        } catch let e as APIError {
            // APIError == a server/stream/format failure (cancellations surface
            // as CancellationError / URLError.cancelled, which propagate).
            guard Self.shouldFallbackBuffered(error: e, sawProgress: false) else { throw e }
            let response = try await api.codeAssist(
                message: input.message, language: input.language, model: input.model,
                provider: input.provider, history: input.history, attachments: input.attachments,
                skills: input.skills, agentContext: input.agentContext, mode: input.mode,
                planExecute: input.planExecute, planWrite: input.planWrite,
                questionCard: input.questionCard)
            return ChatTransportResult(response)
        }
    }

    /// 4-callback override: unlike the protocol's default (which drops
    /// `onApproval` entirely, correct for the transports that truly never
    /// park one), the legacy engine's gated `run-bash` DOES now park a
    /// `ToolApproval` (Task 8) — it surfaces as a `progress` SSE event with
    /// `phase: "approval_request"`, which `codeAssistStream` already decodes
    /// into an `AgentV2Approval` and forwards here. Same buffered-fallback
    /// policy as the 3-callback overload above; the buffered `/code-assist`
    /// endpoint has no equivalent streaming approval channel, but a fallback
    /// only fires when `sawProgress` was false, and a parked approval always
    /// sets it true (see `codeAssistStream`), so this path can't silently
    /// re-run a gated command without its approval ever having been seen.
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        do {
            let response = try await api.codeAssistStream(
                message: input.message, language: input.language, model: input.model,
                provider: input.provider, history: input.history, attachments: input.attachments,
                skills: input.skills, agentContext: input.agentContext, mode: input.mode,
                planExecute: input.planExecute, planWrite: input.planWrite,
                questionCard: input.questionCard,
                onProgress: onProgress, onChunk: onChunk, onApproval: onApproval,
                onLiveTasks: onLiveTasks)
            return ChatTransportResult(response)
        } catch let e as APIError {
            guard Self.shouldFallbackBuffered(error: e, sawProgress: false) else { throw e }
            let response = try await api.codeAssist(
                message: input.message, language: input.language, model: input.model,
                provider: input.provider, history: input.history, attachments: input.attachments,
                skills: input.skills, agentContext: input.agentContext, mode: input.mode,
                planExecute: input.planExecute, planWrite: input.planWrite,
                questionCard: input.questionCard)
            return ChatTransportResult(response)
        }
    }

    /// Pure policy: is this error safe to retry on the buffered endpoint?
    /// Only a transport failure (`.http`) that happened before any progress
    /// was observed is safe — retrying after progress was seen would re-run
    /// whatever server-side tools already fired.
    ///
    /// In practice `codeAssistStream` already folds that liveness signal into
    /// the error case it throws (`LlmIdeAPIClient+CodeAssist.swift:285-298`):
    /// a stream that produced no progress at all surfaces as the retryable
    /// `.http(STREAM_INCOMPLETE)`; a stream that had already run server-side
    /// tools (progress or chunks seen) surfaces as `.agent` instead. So by the
    /// time `roundTrip`'s catch block calls this, an `.http` error already
    /// implies no progress was seen — `roundTrip` passes `sawProgress: false`
    /// unconditionally rather than threading its own tracking through. The
    /// parameter stays part of the policy's signature (rather than being
    /// dropped) so the rule is provable as a pure function independent of
    /// that upstream folding, and so a future caller with its own liveness
    /// signal can still assert it directly.
    nonisolated static func shouldFallbackBuffered(error: APIError, sawProgress: Bool) -> Bool {
        // Only a server-side failure can be transient enough for the other
        // endpoint to succeed. A 4xx is the server REFUSING this request —
        // re-POSTing it spent another rate-limit token on a 429 (and lost its
        // Retry-After message) and simply failed again on a 400.
        guard case .http(let status, _, _, _) = error, status >= 500 || status == 0 else { return false }
        return !sawProgress
    }
}
