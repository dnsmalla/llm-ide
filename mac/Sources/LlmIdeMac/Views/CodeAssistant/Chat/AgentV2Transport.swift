import Foundation

/// Abstraction over `POST /agent/v2/stream` so `AgentV2Transport` — and its
/// tests — can drive the event stream without a live `LlmIdeAPIClient` (or
/// URLSession). `LlmIdeAPIClient` satisfies this structurally (Task 9's
/// `agentV2Stream(_:onEvent:)`); the conformance below just states it.
protocol AgentV2Streaming: Sendable {
    func agentV2Stream(
        _ body: [String: Any],
        onEvent: @escaping @MainActor (AgentV2Event) -> Void
    ) async throws
}

extension LlmIdeAPIClient: AgentV2Streaming {}

/// Typed failure of one v2 turn. `sessionUnresumable` is the retry signal:
/// the panel (Task 12) catches it and re-fires the turn with `fresh: true`,
/// which makes the server drop the recorded SDK-session mapping and start
/// a new session for the chat.
enum AgentV2Error: Error, Equatable, Sendable {
    /// `error(code: "SESSION_UNRESUMABLE")` — the chat's SDK session file is
    /// gone/corrupt; resume is impossible but a fresh session is fine.
    case sessionUnresumable
    /// Any other stream-carried `error` event, code and message verbatim.
    case engine(code: String?, message: String)
    /// The stream closed with neither a `result` nor an `error` event —
    /// the turn's outcome is unknown, so it must surface as a failure
    /// rather than a silently empty reply.
    case streamEndedWithoutResult
}

// The panel's error banner shows `error.localizedDescription`; without this
// conformance Foundation renders the useless "The operation couldn't be
// completed. (LlmIdeMacLib.AgentV2Error error 0.)" and the server's actual
// message never reaches the user.
extension AgentV2Error: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .sessionUnresumable:
            return "The chat's engine session could not be resumed."
        case .engine(let code, let message):
            // The catch-all ENGINE_ERROR code adds nothing for the user;
            // a specific code (rate limit, auth, …) is worth showing.
            if let code, !code.isEmpty, code != "ENGINE_ERROR" {
                return "Agent engine error (\(code)): \(message)"
            }
            return "Agent engine error: \(message)"
        case .streamEndedWithoutResult:
            return "The engine stream ended without a result."
        }
    }
}

/// Deferred failure capture for one turn. Stream-event callbacks are
/// non-throwing, so failures detected inside them — an `error` event, or
/// (on the 3-callback path) an approval nobody can answer — are recorded
/// here and thrown once the stream ends. It's a class rather than a local
/// `var` because the recording sites live in different stack frames: the
/// event loop in `runTurn` and the `onApproval` sink the 3-callback entry
/// point passes down to it.
@MainActor
private final class TurnFailureCapture {
    private(set) var value: AgentV2Error?

    /// First failure wins — anything after the root cause is post-mortem
    /// noise (e.g. a park-timeout `error` following an unhandled approval).
    func record(_ error: AgentV2Error) {
        if value == nil { value = error }
    }
}

/// `ChatTransport` over the v2 agent engine (`POST /agent/v2/stream`).
///
/// Mapping contract (mirrors what `CodeAssistTransport` gets from the legacy
/// endpoint, so the panel renders both engines identically):
///
/// - **Reply** — the concatenation of every `delta` text. Unlike the legacy
///   `done.reply` overwrite there is no terminal full-text echo on v2; the
///   deltas ARE the reply.
/// - **Progress** — `tool_use_start`/`tool_result` map to `AgentProgress`
///   with `phase: "tool"` and the tool's wire name, labelled through the
///   shared `progressLabel`/`toolVerb` conventions. A `tool_result` carries
///   only its `toolUseId`, so its name is resolved from the preceding
///   `tool_use_start` (unknown id → nil → "Working…").
/// - **Approvals** — `approval_request` surfaces verbatim through
///   `onApproval`. The transport never answers them: the stream stays open
///   while the engine parks, and the panel/engine (Tasks 11–12) posts the
///   decision separately.
/// - **Usage** — the legacy `Usage` block is attachment/memory accounting;
///   the v2 server reports neither (its `usage` events carry token counts,
///   which no legacy field fits). The attachment figures are computed
///   client-side from the request — the same arithmetic the legacy server
///   applies (`files.length`, summed chars, `files.map(f => f.path)`) — so
///   the panel's usage footnote keeps working; token counts are dropped.
/// - **Errors** — `error` events can't throw through the non-throwing
///   `onEvent` callback, so the failure is captured and thrown once the
///   stream ends. The 3-callback entry point reuses that same deferral
///   for approvals it cannot answer (see below).
@MainActor
final class AgentV2Transport: ChatTransport, @unchecked Sendable {
    let streamer: AgentV2Streaming

    /// SDK session id reported by the most recent turn's `init` event. The
    /// decision endpoint tenancy-checks `requestId` + `sdkSessionId` + user,
    /// so the approval submitter (Task 11's `submitApproval`) needs this
    /// value alongside the parked `AgentV2Approval`.
    private(set) var sdkSessionId: String?

    /// Clears the recorded SDK session id — the session-swap staleness half
    /// of `ChatEngine.resetTransientSessionState`. The id belongs to the
    /// outgoing chat's SDK session, and a decision POSTed against it after
    /// the swap would pass the server's requestId + sdkSessionId tenancy
    /// check (same user) while answering the wrong chat's question. The next
    /// turn's `init` event records the new chat's id.
    func resetSdkSessionId() {
        sdkSessionId = nil
    }

    init(streamer: AgentV2Streaming) {
        self.streamer = streamer
    }

    /// 3-callback requirement — the form no v2 caller should take. An
    /// `approvalRequest` arriving here has nobody to answer it: the engine
    /// parks the turn server-side awaiting a decision that can never be
    /// posted, and this call would await the stream indefinitely. So the
    /// sink passed down records a typed `APPROVAL_UNHANDLED` failure
    /// through the same deferred-throw path stream errors use (recorded in
    /// the callback, thrown once the stream ends) — the turn fails in a
    /// diagnosable way instead of hanging. Exists because the protocol
    /// requires both signatures of every conformer; v2 callers (Tasks
    /// 11–12) use the 4-callback form.
    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void
    ) async throws -> ChatTransportResult {
        let failure = TurnFailureCapture()
        return try await runTurn(input, fresh: false, failure: failure,
                                 onProgress: onProgress, onChunk: onChunk) { approval in
            failure.record(.engine(
                code: "APPROVAL_UNHANDLED",
                message: "approvalRequest \(approval.requestId) arrived on the "
                    + "3-callback roundTrip path, which has no onApproval "
                    + "handler to answer it"
            ))
        }
    }

    func roundTrip(
        _ input: ChatTransportInput,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        try await runTurn(input, fresh: false, failure: TurnFailureCapture(),
                          onProgress: onProgress, onChunk: onChunk, onApproval: onApproval)
    }

    /// v2-only variant with an explicit `fresh` flag: `true` tells the
    /// server to skip the chat's recorded SDK session and start a new one.
    /// The panel's `sessionUnresumable` recovery (Task 12) retries the same
    /// turn through this entry point; the plain 4-callback conformance
    /// above always resumes.
    func roundTrip(
        _ input: ChatTransportInput,
        fresh: Bool,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        try await runTurn(input, fresh: fresh, failure: TurnFailureCapture(),
                          onProgress: onProgress, onChunk: onChunk, onApproval: onApproval)
    }

    /// Core turn shared by every entry point above. `failure` is supplied
    /// by the caller so the 3-callback path's approval sink can record into
    /// the same deferred-failure storage the `error`-event mapping uses —
    /// one throw point at stream end, first cause wins.
    private func runTurn(
        _ input: ChatTransportInput,
        fresh: Bool,
        failure: TurnFailureCapture,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: @escaping @MainActor (AgentV2Approval) -> Void
    ) async throws -> ChatTransportResult {
        // Body mirrors the legacy request's shared fields minus
        // history/tier/provider: v2 sessions own conversation history
        // server-side, model routing is server-side, and no v2 caller sets
        // a tier. Optional fields are omitted rather than nulled — the
        // route types each one and treats missing exactly like absent.
        var body: [String: Any] = [
            "message": input.message,
            "skills": input.skills,
            "attachments": input.attachments.map { ["path": $0.path, "content": $0.content] },
        ]
        if let language = input.language { body["language"] = language }
        if let model = input.model { body["model"] = model }
        if let mode = input.mode { body["mode"] = mode }
        if let agentContext = input.agentContext,
           let data = try? JSONEncoder().encode(agentContext),
           let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            body["agentContext"] = dict
        }
        if fresh { body["fresh"] = true }

        var reply = ""
        var resolvedMode: String?
        var sawTerminal = false
        // toolUseId → wire name, so a nameless tool_result can still report
        // which tool finished.
        var toolNames: [String: String] = [:]

        try await streamer.agentV2Stream(body) { event in
            // `result` and `error` are terminal; the route's post-turn
            // bookkeeping could still emit events (a known server-side
            // wrinkle), and deltas after either would corrupt the reply.
            guard !sawTerminal else { return }
            switch event {
            case .init_(let payload):
                if let sid = payload.sessionId { self.sdkSessionId = sid }
            case .delta(let text):
                reply += text
                onChunk(text)
            case .toolUseStart(let id, let name):
                if let id, let name { toolNames[id] = name }
                self.fireToolProgress(name, onProgress: onProgress)
            case .toolResult(let payload):
                self.fireToolProgress(payload.toolUseId.flatMap { toolNames[$0] },
                                      onProgress: onProgress)
            case .toolArgsDelta:
                // Live arg assembly for an open tool card. `ChatTransport`
                // has no channel for it (legacy progress carries no args);
                // Task 11's card UI grows its own surface if it ever needs
                // streaming args.
                break
            case .usage:
                // Token counts have no legacy `Usage` field (see class doc);
                // consumed here so the mapping decision is explicit.
                break
            case .approvalRequest(let approval):
                onApproval(approval)
            case .approvalResolved:
                break  // informational: the decision's effect arrives as continued events
            case .modeSet(let mode):
                resolvedMode = mode
            case .result:
                sawTerminal = true
            case .error(let code, let message):
                sawTerminal = true
                failure.record(code == "SESSION_UNRESUMABLE"
                    ? .sessionUnresumable
                    : .engine(code: code, message: message))
            case .sdk:
                break  // unknown/passthrough types: observable on the wire, not actionable here
            }
        }

        if let failure = failure.value {
            throw failure
        }
        guard sawTerminal else {
            throw AgentV2Error.streamEndedWithoutResult
        }

        return ChatTransportResult(
            reply: reply,
            pendingTool: nil,
            tasks: nil,
            continueNeeded: false,
            usage: LlmIdeAPIClient.CodeAssistResponse.Usage(
                attachmentCount: input.attachments.count,
                attachmentChars: input.attachments.reduce(0) { $0 + $1.content.count },
                paths: input.attachments.map(\.path),
                truncatedPaths: nil,
                memoryApproxTokens: nil,
                memoryChars: nil,
                memoryHasChatMemory: nil
            ),
            // The route echoes the resolved mode right after `init`
            // (`mode_set`) — the v2 analog of the legacy `done.mode`. Fall
            // back to the requested mode when the echo never arrived.
            mode: resolvedMode ?? input.mode
        )
    }

    /// One tool progress tick, labelled with the shared legacy conventions
    /// (`progressLabel` → `toolVerb`), detail always nil — the v2 wire has
    /// no parsed salient argument for a tool call, only raw arg deltas.
    private func fireToolProgress(
        _ tool: String?,
        onProgress: @escaping @MainActor (LlmIdeAPIClient.AgentProgress) -> Void
    ) {
        onProgress(LlmIdeAPIClient.AgentProgress(
            label: LlmIdeAPIClient.progressLabel(phase: "tool", tool: tool),
            phase: "tool",
            tool: tool,
            detail: nil
        ))
    }
}
