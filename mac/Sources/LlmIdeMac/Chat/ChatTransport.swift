import Foundation

/// Abstraction over "send one chat turn to the backend and stream back
/// progress/chunks". `CodeAssistTransport` is the real implementation
/// (thin wrapper over `LlmIdeAPIClient`); a scripted double lives in the
/// test target so the future chat engine (Tasks 4, 11, 12) can be driven
/// deterministically, with no live server.
protocol ChatTransport: Sendable {
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult

    /// v2 engines surface mid-turn approval questions (a parked
    /// `AskUserQuestion` the turn blocks on until the user answers via
    /// `POST /agent/v2/decision`). The default below ignores them — legacy
    /// engines (`CodeAssistTransport`, `AgentAskTransport`, test doubles)
    /// never produce any, so they compile unchanged and their callers can
    /// adopt the 4-callback form without caring which engine answered.
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult
}

extension ChatTransport {
    /// Default 4-callback round trip: forward to the 3-callback variant and
    /// drop `onApproval` — the legacy engines this default serves cannot
    /// park on a question.
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        try await roundTrip(input, onProgress: onProgress, onChunk: onChunk)
    }
}

/// Everything one code-assist turn needs, independent of the SwiftUI view
/// that gathers it. Mirrors `LlmIdeAPIClient.CodeAssistRequest` field for
/// field (minus `tier`, which no caller of `codeAssistRoundTrip` sets today).
struct ChatTransportInput: Sendable {
    let message: String
    let history: [LlmIdeAPIClient.CodeAssistTurn]
    let attachments: [LlmIdeAPIClient.CodeAttachment]
    let skills: [String]
    let agentContext: AgentContext?
    let language: String?
    let model: String?
    /// Explicit backend provider string, resolved via `makeProvider(selectedProvider:)`.
    let provider: String?
    let mode: String?
    /// True only for the turn the saved-plan card's "Execute plan" action
    /// fires. The server uses it to inject the plan-execution skill
    /// (extension/llm_agent/runtime/plan-pipeline.mjs) — it is the one signal
    /// the backend can trust that this Execute turn is working an
    /// already-approved plan rather than a fresh request. `var` with a
    /// default so the memberwise init stays source-compatible with every
    /// existing call site, which passes nothing.
    var planExecute: Bool = false

    /// Determine the provider string to send: `custom:<uuid>` verbatim for a
    /// custom provider, or the built-in tool's `provider` for everything else.
    /// Moved verbatim from `CodeAssistantPanel+Session.swift`'s
    /// `codeAssistRoundTrip` (lines 330-338).
    static func makeProvider(selectedProvider: String) -> String {
        if selectedProvider.hasPrefix("custom:") {
            // For custom providers, send the full custom:uuid identifier.
            return selectedProvider
        }
        // For built-in providers, use the provider string from the AICliTool.
        return (AICliTool(rawValue: selectedProvider) ?? .claudeCode).provider
    }
}

/// Outcome of one turn. Mirrors `LlmIdeAPIClient.CodeAssistResponse` field
/// for field so a transport can be swapped without the caller reshaping data.
struct ChatTransportResult: Sendable {
    let reply: String
    let pendingTool: PendingTool?
    let tasks: [AgentTask]?
    let continueNeeded: Bool?
    let usage: LlmIdeAPIClient.CodeAssistResponse.Usage?
    let mode: String?
}

extension ChatTransportResult: Equatable {
    // Hand-written rather than synthesized: `AgentTask` and
    // `LlmIdeAPIClient.CodeAssistResponse.Usage` are declared `Codable` only
    // (not `Equatable`) in their home files, and automatic `Equatable`
    // synthesis requires the conformance to be declared alongside the
    // original type declaration — not from an extension in a different file.
    // Comparing field-by-field here avoids reaching into those files for a
    // conformance this task's scope doesn't otherwise need.
    static func == (lhs: ChatTransportResult, rhs: ChatTransportResult) -> Bool {
        guard lhs.reply == rhs.reply,
              lhs.pendingTool == rhs.pendingTool,
              lhs.continueNeeded == rhs.continueNeeded,
              lhs.mode == rhs.mode,
              usageEqual(lhs.usage, rhs.usage)
        else { return false }
        return tasksEqual(lhs.tasks, rhs.tasks)
    }

    private static func tasksEqual(_ a: [AgentTask]?, _ b: [AgentTask]?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (l?, r?):
            guard l.count == r.count else { return false }
            return zip(l, r).allSatisfy {
                $0.id == $1.id && $0.title == $1.title && $0.status.rawValue == $1.status.rawValue
            }
        default: return false
        }
    }

    private static func usageEqual(
        _ a: LlmIdeAPIClient.CodeAssistResponse.Usage?,
        _ b: LlmIdeAPIClient.CodeAssistResponse.Usage?
    ) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (l?, r?):
            return l.attachmentCount == r.attachmentCount
                && l.attachmentChars == r.attachmentChars
                && l.paths == r.paths
                && l.truncatedPaths == r.truncatedPaths
                && l.memoryApproxTokens == r.memoryApproxTokens
                && l.memoryChars == r.memoryChars
                && l.memoryHasChatMemory == r.memoryHasChatMemory
        default: return false
        }
    }
}

extension ChatTransportResult {
    init(_ response: LlmIdeAPIClient.CodeAssistResponse) {
        self.init(
            reply: response.reply,
            pendingTool: response.pendingTool,
            tasks: response.tasks,
            continueNeeded: response.continueNeeded,
            usage: response.usage,
            mode: response.mode
        )
    }
}

/// Real `ChatTransport` — thin wrapper over `LlmIdeAPIClient`'s streaming
/// code-assist endpoint, with the same one-shot buffered fallback
/// `codeAssistRoundTrip` has always done: a transport-level failure (never a
/// server-reported application error) retries once on the buffered endpoint
/// so a streaming/parse bug can't break the feature outright.
///
/// A class (not the struct it started as) solely for `onLiveTasks`: the
/// engine-selection composite holds its legacy transport as a `let`
/// existential, and a callback wired after construction has to land on the
/// same instance the round trips run on.
final class CodeAssistTransport: ChatTransport, @unchecked Sendable {
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
                planExecute: input.planExecute,
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
                planExecute: input.planExecute)
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
                planExecute: input.planExecute,
                onProgress: onProgress, onChunk: onChunk, onApproval: onApproval,
                onLiveTasks: onLiveTasks)
            return ChatTransportResult(response)
        } catch let e as APIError {
            guard Self.shouldFallbackBuffered(error: e, sawProgress: false) else { throw e }
            let response = try await api.codeAssist(
                message: input.message, language: input.language, model: input.model,
                provider: input.provider, history: input.history, attachments: input.attachments,
                skills: input.skills, agentContext: input.agentContext, mode: input.mode,
                planExecute: input.planExecute)
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
    static func shouldFallbackBuffered(error: APIError, sawProgress: Bool) -> Bool {
        guard case .http = error else { return false }
        return !sawProgress
    }
}
