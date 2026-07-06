import Foundation

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
        let content: String
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
    }
    struct CodeAssistResponse: Codable {
        let reply: String
        let usage: Usage?
        let pendingTool: PendingTool?       // NEW — optional
        let continueNeeded: Bool?
        let tasks: [AgentTask]?
        struct Usage: Codable {
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
            ),
            authenticated: true,
        )
    }

    // One SSE event from the streaming /code-assist endpoint.
    private struct CodeAssistSSEEvent: Decodable {
        let type: String                 // "progress" | "done" | "error"
        let phase: String?               // progress: "thinking" | "tool" | "writing"
        let tool: String?                // progress (phase == "tool"): tool name
        let reply: String?               // done
        let pendingTool: PendingTool?    // done
        let usage: CodeAssistResponse.Usage?  // done
        let continueNeeded: Bool?        // done — agent has more tasks to run
        let tasks: [AgentTask]?          // done — task list from the agent
        let error: String?               // error
    }

    /// Human-readable status for a progress event — shown as a live line in the
    /// Code Assistant instead of a frozen "Thinking…".
    static func progressLabel(phase: String?, tool: String?) -> String {
        switch phase {
        case "writing": return "Writing the answer…"
        case "tool":
            switch tool {
            case "web-search":   return "Searching the web…"
            case "fetch-url":    return "Fetching a page…"
            case "ask-internal": return "Checking app context…"
            case "ask-subagent": return "Delegating to a subagent…"
            default:             return tool.map { "Using \($0)…" } ?? "Working…"
            }
        default: return "Thinking…"
        }
    }

    /// Streaming variant of `codeAssist`. POSTs the same body but with
    /// `Accept: text/event-stream`; the server streams live agent progress
    /// (thinking / tool / writing) which we surface via `onProgress`, then the
    /// final reply lands as one `done` event. The Mac uses the agent path, so
    /// this replaces a 60–90s frozen spinner with a live status line. The
    /// reply itself still arrives whole (token-level streaming of the agent
    /// synthesis turn is a separate follow-up).
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
        onProgress: @escaping @MainActor (String) -> Void,
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
            agentContext: agentContext))

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
                let label = Self.progressLabel(phase: evt.phase, tool: evt.tool)
                await onProgress(label)
            case "done":
                reply = evt.reply ?? ""
                pendingTool = evt.pendingTool
                usage = evt.usage
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
        return CodeAssistResponse(reply: reply, usage: usage, pendingTool: pendingTool, continueNeeded: continueNeeded, tasks: tasks)
    }
}
