import Foundation
import os.log

extension LlmIdeAPIClient {

    struct CodeAttachment: Codable, Identifiable {
        let path: String                // display label, may be ~/-prefixed
        let content: String
        var id: String { path }
    }

    enum CodeAssistRole: String, Codable { case user, assistant }

    /// Identifiable view-model shape used by SwiftUI lists.  The `id`
    /// is client-only (not sent to the server) — encoding strips it
    /// via CodingKeys, decoding synthesizes a fresh UUID.
    struct CodeAssistTurn: Identifiable, Encodable, Decodable, Equatable {
        let id: UUID
        let role: CodeAssistRole
        var content: String
        init(role: CodeAssistRole, content: String) {
            self.id = UUID(); self.role = role; self.content = content
        }
        enum CodingKeys: String, CodingKey { case role, content }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = UUID()
            self.role = try c.decode(CodeAssistRole.self, forKey: .role)
            self.content = try c.decode(String.self, forKey: .content)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(role, forKey: .role)
            try c.encode(content, forKey: .content)
        }
    }

    struct CodeAssistRequest: Encodable {
        let message: String
        let language: String?
        let model: String?
        /// Explicit backend provider ("anthropic"/"openai"/"google"/"custom").
        /// Required for "custom", whose model ids aren't prefix-routable.
        let provider: String?
        /// Optional model tier hint. "subagent" → server routes to
        /// LLMIDE_SUBAGENT_MODEL (cheap, for short judge/verify-author
        /// calls). nil → normal global model.
        let tier: String?
        let history: [CodeAssistTurn]
        let attachments: [CodeAttachment]
        /// Library-skill ids ("<family>/<dir>") the user invoked from the "/"
        /// menu. The server reads each SKILL.md from the local central repo and
        /// frames it as a TRUSTED instruction to follow — we send only ids, never
        /// content, so this channel can't be used to smuggle followable text.
        let skills: [String]
        let agentContext: AgentContext?     // NEW — optional for back-compat
        /// "auto" | "plan" | "assist_plan" | "review" | "document" | "execute". Optional so
        /// an older client (or a request that doesn't care) omits it —
        /// server treats missing/nil exactly like "execute".
        let mode: String?
        /// Set only by the saved-plan card's "Execute plan" action: tells the
        /// server this Execute turn is working an already-approved plan, so it
        /// injects the plan-execution skill (inline vs subagent-driven is the
        /// server's call — only it knows this user's subagents). Optional so
        /// every other request omits it entirely.
        let planExecute: Bool?
    }
    struct CodeAssistResponse: Codable {
        let reply: String
        let usage: Usage?
        let pendingTool: PendingTool?       // NEW — optional
        let continueNeeded: Bool?
        let tasks: [AgentTask]?
        /// Resolved mode the server actually used — differs from the
        /// requested mode only when the request was "auto".
        let mode: String?
        // Equatable + Sendable added for ChatMessage.Metadata (Task 8's v2
        // chat envelope embeds this struct and needs both conformances);
        // Codable behavior is unchanged.
        struct Usage: Codable, Equatable, Sendable {
            let attachmentCount: Int
            let attachmentChars: Int
            let paths: [String]
            /// Attachment paths the server CUT to fit the prompt-size caps.
            /// The agent only saw the head of these files, so auto-edit must
            /// NOT silently overwrite them with a "full rewrite" (it would drop
            /// the tail). Optional for back-compat with older servers.
            let truncatedPaths: [String]?
            /// Per-request project-memory overhead (the always-on memory block
            /// inlined into the prompt). Optional for back-compat with servers
            /// that don't report it.
            let memoryApproxTokens: Int?
            let memoryChars: Int?
            let memoryHasChatMemory: Bool?
        }
    }

    /// One round-trip with Claude.  History is the prior turns to send
    /// for context; attachments are the files the user has dragged or
    /// picked into the panel.  Server caps payload size — anything
    /// over the limit is silently truncated, never rejected.
    func codeAssist(
        message: String,
        language: String?,
        model: String? = nil,
        provider: String? = nil,
        tier: String? = nil,
        history: [CodeAssistTurn],
        attachments: [CodeAttachment],
        skills: [String] = [],
        agentContext: AgentContext? = nil,
        mode: String? = nil,
        planExecute: Bool = false,
    ) async throws -> CodeAssistResponse {
        try await post(
            "/code-assist",
            body: CodeAssistRequest(
                message: message,
                language: language,
                model: model,
                provider: provider,
                tier: tier,
                history: history,
                attachments: attachments,
                skills: skills,
                agentContext: agentContext,
                mode: mode,
                planExecute: planExecute ? true : nil,
            ),
            authenticated: true,
        )
    }

    // One SSE event from the streaming /code-assist endpoint.
    private struct CodeAssistSSEEvent: Decodable {
        let type: String                 // "progress" | "chunk" | "done" | "tasks" | "tasks_progress" | "error"
        let phase: String?               // progress: "thinking" | "tool" | "writing" | "approval_request"
        let tool: String?                // progress (phase == "tool"): tool name
        let detail: String?              // progress (phase == "tool"): what it's acting on
        let text: String?                // chunk: a text delta
        let reply: String?               // done
        let pendingTool: PendingTool?    // done
        let usage: CodeAssistResponse.Usage?  // done
        let continueNeeded: Bool?        // tasks — agent has more tasks to run
        let tasks: [AgentTask]?          // tasks — task list from the agent
        let mode: String?                // done — resolved mode
        let error: String?               // error
        // progress (phase == "approval_request"): the legacy engine's gated
        // run-bash parking a ToolApproval (Task 8's `ctx.loopCtx.emit`) —
        // wrapped in the same `{type:'progress', ...ev}` envelope as every
        // other progress event by ai-routes.mjs's `onProgress` writer.
        let requestId: String?
        let kind: String?
        let toolName: String?
        let argsSummary: String?
    }

    /// One live progress update. Carries the structured fields alongside the
    /// rendered `label` so a caller can both show the transient status line AND
    /// keep a durable record of which tools ran — the label alone can't be
    /// filtered back down to "was this a tool step?".
    struct AgentProgress: Sendable {
        let label: String
        let phase: String?
        let tool: String?
        let detail: String?
        var isTool: Bool { phase == "tool" }
    }

    /// Delegating shims — the tool-name vocabulary (llm-ide tools + the
    /// Agent SDK's built-ins) lives in the Claude linker
    /// (`ClaudeLink/ClaudeToolPresentation.swift`) so an SDK update edits
    /// only the linker; these keep the long-standing call sites stable.
    static func normalizedToolName(_ tool: String) -> String {
        ClaudeToolPresentation.normalizedToolName(tool)
    }

    static func toolVerb(_ tool: String?) -> String {
        ClaudeToolPresentation.verb(tool)
    }

    static func progressLabel(phase: String?, tool: String?, detail: String? = nil) -> String {
        ClaudeToolPresentation.progressLabel(phase: phase, tool: tool, detail: detail)
    }

    /// Streaming variant of `codeAssist`. POSTs the same body but with
    /// `Accept: text/event-stream`; the server streams live agent progress
    /// (thinking / tool / writing) via `onProgress`, and the final synthesis
    /// turn's text arrives incrementally via `onChunk` as `chunk` events, with
    /// the complete text also captured in the terminal `done` event as a
    /// consistency fallback (used verbatim if no chunk events ever arrived —
    /// e.g. an older server, or a provider with no streaming adapter yet).
    func codeAssistStream(
        message: String,
        language: String?,
        model: String? = nil,
        provider: String? = nil,
        tier: String? = nil,
        history: [CodeAssistTurn],
        attachments: [CodeAttachment],
        skills: [String] = [],
        agentContext: AgentContext? = nil,
        mode: String? = nil,
        planExecute: Bool = false,
        onProgress: @escaping @MainActor (AgentProgress) -> Void,
        onChunk: @escaping @MainActor (String) -> Void,
        onApproval: (@MainActor (AgentV2Approval) -> Void)? = nil,
        onLiveTasks: (@MainActor ([AgentTask]) -> Void)? = nil,
    ) async throws -> CodeAssistResponse {
        guard let url = URL(string: baseURL + "/code-assist") else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let token = await MainActor.run(body: { _sessionStore?.accessToken }) {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONEncoder().encode(CodeAssistRequest(
            message: message, language: language, model: model, provider: provider,
            tier: tier, history: history, attachments: attachments, skills: skills,
            agentContext: agentContext, mode: mode, planExecute: planExecute ? true : nil))

        let (bytes, response) = try await session(for: "/code-assist").bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(status: 0, code: "NO_RESPONSE", message: "No HTTP response", details: nil)
        }
        guard http.statusCode == 200 else {
            throw APIError.http(status: http.statusCode, code: "HTTP_ERROR",
                                message: "Code Assistant request failed (\(http.statusCode))", details: nil)
        }

        var reply: String?
        var pendingTool: PendingTool?
        var usage: CodeAssistResponse.Usage?
        var continueNeeded: Bool?
        var tasks: [AgentTask]?
        var mode: String?
        var sawProgress = false
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard !payload.isEmpty, let data = payload.data(using: .utf8),
                  let evt = try? JSONDecoder().decode(CodeAssistSSEEvent.self, from: data)
            else { continue }
            switch evt.type {
            case "progress":
                sawProgress = true
                // The legacy engine's gated run-bash parking a ToolApproval
                // (Task 8) — arrives as a progress event whose phase is
                // "approval_request" rather than the usual thinking/tool/
                // writing labels. Route it to onApproval instead of
                // rendering it as a status line; sawProgress is still set
                // above so a disconnect after this point never falls back
                // to the buffered endpoint and re-runs the parked command.
                if evt.phase == "approval_request", let requestId = evt.requestId, let kind = evt.kind {
                    await onApproval?(AgentV2Approval(requestId: requestId, kind: kind,
                                                       toolName: evt.toolName, argsSummary: evt.argsSummary))
                    continue
                }
                let label = Self.progressLabel(phase: evt.phase, tool: evt.tool, detail: evt.detail)
                await onProgress(AgentProgress(label: label, phase: evt.phase,
                                               tool: evt.tool, detail: evt.detail))
            case "chunk":
                if let text = evt.text, !text.isEmpty {
                    sawProgress = true  // a chunk is proof of life, same as a progress event
                    await onChunk(text)
                }
            case "done":
                reply = evt.reply ?? ""
                pendingTool = evt.pendingTool
                usage = evt.usage
                mode = evt.mode
                // continueNeeded/tasks are NOT on this event — the server
                // (ai-routes.mjs) emits them on a SEPARATE, later "tasks"
                // event instead. Reading evt.continueNeeded/evt.tasks here
                // would always be nil; see the "tasks" case below.
            case "tasks_progress":
                // Mid-turn task list (server v42+): the SAME list as the
                // terminal "tasks" event but WITHOUT continueNeeded, re-sent
                // whenever a tool changed it, so the plan-execute progress
                // bar moves during the turn. Display only — deliberately not
                // written into the `tasks` local, which is what the caller's
                // auto-continue reads from the returned response.
                if let live = evt.tasks, !live.isEmpty {
                    await onLiveTasks?(live)
                }
            case "tasks":
                // Server sends this as its own event, right after "done" —
                // see ai-routes.mjs: writeEvent({ type: 'tasks', tasks, continueNeeded }).
                // Without this case, the event fell into `default: break`
                // and PlanTimelineCard / the auto-continue reflex never saw
                // real data over the streaming path.
                continueNeeded = evt.continueNeeded
                tasks = evt.tasks
            case "error":
                // The backend explicitly reported a failure for THIS turn (the
                // reason is already redacted server-side). Surface it verbatim
                // via `.agent` — not `.http`, which codeAssistRoundTrip would
                // mistake for a transport failure and retry on the buffered
                // endpoint, re-running the same failing call and replacing this
                // real reason with the generic "temporarily unavailable" 502.
                throw APIError.agent(message: evt.error ?? "Code Assistant failed")
            default:
                break
            }
        }
        guard let reply else {
            // The stream ended without a `done` event. If the agent had already
            // streamed progress (it likely ran server-side tools — web-search,
            // create-issue, a git op), retrying on the buffered endpoint would
            // RE-RUN those side effects. Surface as `.agent` (which
            // codeAssistRoundTrip does NOT retry) rather than `.http` (which it
            // does). Only a stream that produced no progress at all is safe to
            // retry, so that case keeps the retryable `.http`.
            if sawProgress {
                throw APIError.agent(message: "The response stream ended after the agent had started working — not retried, to avoid repeating actions it may have already taken.")
            }
            throw APIError.http(status: 500, code: "STREAM_INCOMPLETE",
                                message: "The response stream ended unexpectedly.", details: nil)
        }
        return CodeAssistResponse(reply: reply, usage: usage, pendingTool: pendingTool, continueNeeded: continueNeeded, tasks: tasks, mode: mode)
    }

    // MARK: - Agent v2 (Agent-SDK chat engine)

    private static let agentV2Log = Logger(subsystem: "com.llmide.macapp", category: "API")

    /// Number of times `connectAgentV2Stream` retries a 409 before giving up.
    private static let turnLockMaxAttempts = 4

    /// Opens the SSE connection, absorbing the TURN_IN_PROGRESS race left by
    /// Stop: cancelling the previous turn's `URLSession` task closes the
    /// connection on the client immediately, but the server only frees its
    /// per-chat lock (`agent-v2.mjs`'s `inFlightChatSessions`) once it
    /// detects that close AND the SDK subprocess actually unwinds — which,
    /// for a turn doing real work (e.g. plan generation with tool calls),
    /// can trail the client's own "ready to send again" state by a couple of
    /// seconds. Without this, hitting Stop and immediately sending a
    /// follow-up surfaced that gap as a hard 409 error. Safe to replay: the
    /// route answers 409 before any engine or session-row work (its early
    /// lock probe runs even ahead of the "auto" mode classifier), so no side
    /// effect from a refused attempt exists to duplicate. Bounded: three
    /// sleeps (0.4 s + 0.8 s + 1.6 s = 2.8 s) plus connect time, then the
    /// fourth 409 is surfaced as `TURN_IN_PROGRESS` by the caller. A Stop
    /// during the wait cancels through `Task.sleep`'s `CancellationError`.
    private func connectAgentV2Stream(
        _ req: URLRequest,
        attempt: Int = 1,
    ) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        let (bytes, response) = try await session(for: "/agent/v2/stream").bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(status: 0, code: "NO_RESPONSE", message: "No HTTP response", details: nil)
        }
        if http.statusCode == 409, attempt < Self.turnLockMaxAttempts {
            Self.agentV2Log.debug("agent/v2 turn lock held (409), retry \(attempt)/\(Self.turnLockMaxAttempts)")
            try await Task.sleep(nanoseconds: Self.backoffNanos(attempt))
            return try await connectAgentV2Stream(req, attempt: attempt + 1)
        }
        return (bytes, http)
    }

    /// Streams one v2 chat turn from `POST /agent/v2/stream`.
    ///
    /// `body` is the request dictionary the caller assembled (message,
    /// language, model, mode, skills, agentContext, attachments, fresh) —
    /// deliberately untyped `[String: Any]` so the shared-engine layer owns
    /// the shape and the server can grow it without a client release; the
    /// values must be JSON-serializable.
    ///
    /// SSE handling copies `codeAssistStream` exactly: `data:`-prefixed
    /// lines, one JSON event each, unknown/unparseable lines skipped
    /// silently (the decode layer already maps unknown TYPES onto `.sdk`).
    /// Unlike the legacy endpoint there is nothing to return — terminal
    /// state arrives as `.result` / `.error` events through `onEvent`, and
    /// a stream-level `error` is dispatched, not thrown: the v2 session
    /// layer (Tasks 10–12) owns turning it into chat state, including the
    /// SESSION_UNRESUMABLE retry-with-`fresh` dance. Only transport-level
    /// failures (non-200 before the stream starts, connection errors) throw.
    func agentV2Stream(
        _ body: [String: Any],
        onEvent: @escaping @MainActor (AgentV2Event) -> Void,
    ) async throws {
        guard let url = URL(string: baseURL + "/agent/v2/stream") else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let token = await MainActor.run(body: { _sessionStore?.accessToken }) {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (bytes, http) = try await connectAgentV2Stream(req)
        guard http.statusCode == 200 else {
            // Validation failures answer as plain JSON before the SSE
            // headers go out — same shape as the legacy stream's guard.
            // 409 is the route's per-chat turn lock (TURN_IN_PROGRESS): tell
            // the user what it means instead of a bare status code.
            if http.statusCode == 409 {
                throw APIError.http(status: 409, code: "TURN_IN_PROGRESS",
                                    message: "This chat is still working on its previous request — wait for it to finish (or stop it), then send again.",
                                    details: nil)
            }
            throw APIError.http(status: http.statusCode, code: "HTTP_ERROR",
                                message: "Agent v2 stream request failed (\(http.statusCode))", details: nil)
        }
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard !payload.isEmpty, let data = payload.data(using: .utf8),
                  let evt = AgentV2Event.decode(fromJSON: data)
            else { continue }
            await onEvent(evt)
        }
    }

    struct AgentV2DecisionRequest: Encodable {
        let requestId: String
        let sdkSessionId: String
        let answers: [String: String]
    }

    private struct AgentV2DecisionResponse: Decodable { let ok: Bool }

    /// Answers a parked AskUserQuestion approval via
    /// `POST /agent/v2/decision`. Returns the server's `ok` flag.
    ///
    /// House-error-convention note: this client has no status-tolerant
    /// pattern — its core `send` turns every non-2xx into `APIError.http`.
    /// So a 403 (decision belongs to another user/session) or 404
    /// (unknown/expired requestId) THROWS here; callers that want
    /// best-effort semantics catch `APIError.http` themselves. A `false`
    /// return only happens if a 200 body ever reports `ok:false`.
    func agentV2Decision(requestId: String, sdkSessionId: String, answers: [String: String]) async throws -> Bool {
        let resp: AgentV2DecisionResponse = try await post(
            "/agent/v2/decision",
            body: AgentV2DecisionRequest(requestId: requestId, sdkSessionId: sdkSessionId, answers: answers),
            authenticated: true,
        )
        return resp.ok
    }

    struct AgentV2ToolDecisionRequest: Encodable {
        let requestId: String
        let sdkSessionId: String
        let action: String
    }

    /// Answers a parked `ToolApproval` (act-tool gate) on the V2 engine via
    /// `POST /agent/v2/decision` — sibling to `agentV2Decision`, which
    /// answers an `AskUserQuestion` with `answers`. This posts `action`
    /// instead (no `answers` field), matching Task 7's `answerDecision`
    /// action vocabulary ("allow" | "deny" | "always-allow"). Same
    /// house-error-convention as `agentV2Decision`: a 403/404 throws.
    func agentV2ToolDecision(requestId: String, sdkSessionId: String, action: String) async throws -> Bool {
        let resp: AgentV2DecisionResponse = try await post(
            "/agent/v2/decision",
            body: AgentV2ToolDecisionRequest(requestId: requestId, sdkSessionId: sdkSessionId, action: action),
            authenticated: true,
        )
        return resp.ok
    }

    struct CodeAssistDecisionRequest: Encodable {
        let requestId: String
        let sdkSessionId: String
        let action: String
    }

    /// Answers a parked `ToolApproval` on the LEGACY engine via
    /// `POST /code-assist/decision` (Task 8) — the legacy-engine counterpart
    /// of `agentV2ToolDecision`, reusing the same dependency-free decisions
    /// registry server-side. The wire key is `sdkSessionId` even though the
    /// value passed in is the legacy chat's own `agentContext.sessionId` —
    /// that's the field name `ai-routes.mjs`'s `/code-assist/decision`
    /// handler reads (`body.sdkSessionId`) into the same `answerDecision`
    /// call the v2 route uses.
    func codeAssistDecision(requestId: String, sessionId: String, action: String) async throws -> Bool {
        let resp: AgentV2DecisionResponse = try await post(
            "/code-assist/decision",
            body: CodeAssistDecisionRequest(requestId: requestId, sdkSessionId: sessionId, action: action),
            authenticated: true,
        )
        return resp.ok
    }

    private struct AgentV2DeleteSessionRequest: Encodable { let chatSessionId: String }
    private struct AgentV2DeletedSession: Decodable { let ok: Bool?; let sdkSessionId: String? }

    /// Drops the server-side chat→SDK-session mapping (plus its SDK
    /// transcripts) via `DELETE /agent/v2/session`.
    ///
    /// Best-effort BY CONTRACT: the Mac's local chat delete must proceed
    /// whether or not the server cooperates, so failures are swallowed to
    /// the log and this method returns normally. (The `throws` stays in
    /// the signature to match the pinned Task 10–12 interface; there is
    /// no throw path in practice.)
    func agentV2DeleteSession(chatSessionId: String) async throws {
        do {
            // Core `delete` helper sends no body, and this route reads
            // {chatSessionId} from one — so go through `send` directly.
            let _: AgentV2DeletedSession = try await send(
                path: "/agent/v2/session",
                method: "DELETE",
                body: AgentV2DeleteSessionRequest(chatSessionId: chatSessionId),
                authenticated: true,
            )
        } catch {
            Self.agentV2Log.error("agentV2DeleteSession failed for \(chatSessionId, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }
}
