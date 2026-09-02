import Foundation

// Decode layer for the v2 chat engine's SSE event stream
// (`POST /agent/v2/stream`).  Tasks 10–12 (the chat session/engine built
// on this) consume these types verbatim, so the shapes are pinned by the
// server contract, not by Mac convenience:
//
//   extension/llm_agent/sdk/events.mjs   init/delta/tool_use_start/
//                                       tool_args_delta/tool_result/
//                                       usage/result/sdk
//   extension/llm_agent/sdk/engine.mjs   approval_request/approval_resolved
//   extension/routes/agent-v2.mjs        mode_set/error/tasks
//
// The wire keys are camelCase (`sessionId`, `costUsd`, `partialJson`, …) —
// they mirror these property names exactly, and the explicit CodingKeys
// below document + pin that mapping per struct.  Forward-compatibility
// rules (spec §4): unknown event types surface as `.sdk(rawTypeString)`,
// unknown fields are ignored (JSONDecoder's default), and a known type
// with missing/invalid fields fails the whole decode (nil) rather than
// half-decoding into a misleading case.

// MARK: - Event payloads

/// One MCP server entry on the `init` event.
struct AgentV2McpServer: Sendable, Equatable, Codable {
    let name: String?
    let status: String?

    enum CodingKeys: String, CodingKey { case name, status }
}

/// First event of every stream — SDK session identity + capability list.
struct AgentV2Init: Sendable, Equatable, Codable {
    let sessionId: String?
    let claudeCodeVersion: String?
    let model: String?
    let tools: [String]
    let capabilities: [String]
    let mcpServers: [AgentV2McpServer]

    enum CodingKeys: String, CodingKey {
        case sessionId, claudeCodeVersion, model, tools, capabilities, mcpServers
    }
}

/// Terminal output of one tool call. The server caps `text` at 20,000
/// characters and marks the cut with `truncated` — the raw output stays
/// server-side.
struct AgentV2ToolResult: Sendable, Equatable, Codable {
    let toolUseId: String?
    let isError: Bool
    let text: String
    let truncated: Bool

    enum CodingKeys: String, CodingKey {
        case toolUseId, isError, text, truncated
    }
}

/// Token usage for one assistant message. `contextPercent` is reserved by
/// the spec table (§4) but events.mjs does not emit it yet, so it decodes
/// as nil on today's stream — optional by design, not oversight.
struct AgentV2Usage: Sendable, Equatable, Codable {
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let contextPercent: Double?

    enum CodingKeys: String, CodingKey {
        case inputTokens, outputTokens, cacheReadTokens, contextPercent
    }
}

/// One selectable answer of a parked `AskUserQuestion`.
struct AgentV2ApprovalOption: Sendable, Equatable, Codable {
    let label: String
    let description: String?

    enum CodingKeys: String, CodingKey { case label, description }
}

/// One question of a parked approval. Header ≤ 12 chars, 2–4 options per
/// the spec's card rules.
struct AgentV2ApprovalQuestion: Sendable, Equatable, Codable {
    let question: String
    let header: String?
    let options: [AgentV2ApprovalOption]
    let multiSelect: Bool

    enum CodingKeys: String, CodingKey {
        case question, header, options, multiSelect
    }
}

/// Structured payload of a ToolApproval — what the card renders as a diff /
/// command / content preview. Every field is optional: which ones are
/// populated depends on the tool (Edit: filePath/oldString/newString/
/// replaceAll; Write: filePath/contentPreview/totalChars/exists; Bash:
/// command). `truncated` is present only when the server cut a field to its
/// 20k cap. `replaceAll`/`exists` ride Swift's automatic Codable synthesis
/// (no custom CodingKeys/init(from:) on this struct) — adding a field here
/// is sufficient, no decode-side change needed.
struct AgentV2ApprovalArgs: Sendable, Equatable, Codable {
    let filePath: String?
    let oldString: String?
    let newString: String?
    let contentPreview: String?
    let totalChars: Int?
    let command: String?
    let truncated: Bool?
    /// Edit only: true when the tool call would replace every occurrence,
    /// not just one (final whole-branch review, I4).
    let replaceAll: Bool?
    /// Write only: true when the target file already exists on disk, i.e.
    /// this call overwrites rather than creates (final whole-branch review, I5).
    let exists: Bool?
}

/// A parked approval the engine is blocking on. `kind` distinguishes the two
/// P2 shapes: "AskUserQuestion" (questions/options, P1) and "ToolApproval"
/// (a gated act tool asking allow/deny/always-allow, P2) — see
/// extension/llm_agent/sdk/engine.mjs's canUseTool and
/// extension/llm_agent/tools/registry.mjs's run-bash entry. `toolName`/
/// `argsSummary` are populated only for a `ToolApproval`; `questions` is
/// populated only for an `AskUserQuestion`. `kind` defaults to
/// "AskUserQuestion" and `questions` to `[]` on decode so a payload from an
/// older server (or any fixture predating this field) still decodes exactly
/// as it always did.
struct AgentV2Approval: Sendable, Equatable, Codable {
    let requestId: String
    let kind: String
    let questions: [AgentV2ApprovalQuestion]
    let toolName: String?
    let argsSummary: String?
    let args: AgentV2ApprovalArgs?

    init(requestId: String, kind: String = "AskUserQuestion", questions: [AgentV2ApprovalQuestion] = [],
         toolName: String? = nil, argsSummary: String? = nil, args: AgentV2ApprovalArgs? = nil) {
        self.requestId = requestId
        self.kind = kind
        self.questions = questions
        self.toolName = toolName
        self.argsSummary = argsSummary
        self.args = args
    }

    enum CodingKeys: String, CodingKey { case requestId, kind, questions, toolName, argsSummary, args }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "AskUserQuestion"
        questions = try c.decodeIfPresent([AgentV2ApprovalQuestion].self, forKey: .questions) ?? []
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName)
        argsSummary = try c.decodeIfPresent(String.self, forKey: .argsSummary)
        args = try c.decodeIfPresent(AgentV2ApprovalArgs.self, forKey: .args)
    }
}

/// Terminal event of a successful turn (the SDK's result message mapped
/// through events.mjs; every field is `?? null` server-side).
struct AgentV2Result: Sendable, Equatable, Codable {
    let subtype: String?
    let costUsd: Double?
    let numTurns: Int?
    let durationMs: Int?
    let sessionId: String?
    let stopReason: String?

    enum CodingKeys: String, CodingKey {
        case subtype, costUsd, numTurns, durationMs, sessionId, stopReason
    }
}

// MARK: - Event enum

/// One event off the v2 SSE stream. The associated values mirror the wire
/// payloads above; the scalar-carrying cases (delta, toolUseStart, …)
/// correspond to events whose only meaningful fields are those scalars.
enum AgentV2Event: Sendable, Equatable {
    /// `{"type":"init", …}` — first event; carries the SDK session id.
    case init_(AgentV2Init)
    /// `{"type":"delta","text":…}` — streamed assistant text.
    case delta(String)
    /// `{"type":"tool_use_start","id":…,"name":…}` — open a tool card.
    case toolUseStart(id: String?, name: String?)
    /// `{"type":"tool_args_delta","index":…,"partialJson":…}` — live args
    /// assembly; the index disambiguates concurrent tool calls in one turn.
    case toolArgsDelta(index: Int, partialJson: String)
    /// `{"type":"tool_result", …}` — close a tool card.
    case toolResult(AgentV2ToolResult)
    /// `{"type":"usage", …}` — per-assistant-message token usage.
    case usage(AgentV2Usage)
    /// `{"type":"approval_request", …}` — engine parked on AskUserQuestion.
    case approvalRequest(AgentV2Approval)
    /// `{"type":"approval_resolved","requestId":…,"outcome":…}` — the parked
    /// approval settled (answer/deny/…) on any stream holder.
    case approvalResolved(requestId: String, outcome: String)
    /// `{"type":"mode_set","mode":…}` — resolved-mode echo, injected by the
    /// route right after `init`.
    case modeSet(String)
    /// `{"type":"tasks","tasks":[…],"continueNeeded":…}` — session task list
    /// after a successful turn (legacy /code-assist parity).
    case tasks(tasks: [AgentTask], continueNeeded: Bool)
    /// `{"type":"tasks_progress","tasks":[…]}` — the SAME list, re-sent
    /// mid-turn whenever a tool call changed it (server API v41). Carries no
    /// `continueNeeded` by design: work is obviously still pending during
    /// the turn, and a client that auto-chains on that flag would launch a
    /// second turn on top of the running one. Progress display only.
    case tasksProgress([AgentTask])
    /// `{"type":"result", …}` — terminal on success.
    case result(AgentV2Result)
    /// `{"type":"error","code":…,"message":…}` — terminal on failure. The
    /// route also emits a `retryable` flag this model deliberately does not
    /// carry yet; the code (e.g. SESSION_UNRESUMABLE) is the retry signal.
    case error(code: String?, message: String)
    /// `{"type":"sdk","sdkType":…}` (observation passthrough) OR an event
    /// type this build doesn't know: the payload is the raw type string so
    /// new upstream capabilities stay observable on the wire.
    case sdk(String?)

    /// Type-discriminated decode. Returns nil for malformed JSON, an
    /// object without a `type` key, or a KNOWN type whose payload fails to
    /// decode (half-decoded events would mislead the UI); unknown types
    /// decode to `.sdk(rawTypeString)` per the forward-compatibility rule.
    static func decode(fromJSON data: Data) -> AgentV2Event? {
        guard let wire = try? JSONDecoder().decode(WireType.self, from: data) else { return nil }
        switch wire.type {
        case "init":
            return Self.payload(AgentV2Init.self, data).map { .init_($0) }
        case "delta":
            return Self.payload(DeltaWire.self, data).map { .delta($0.text) }
        case "tool_use_start":
            return Self.payload(ToolUseStartWire.self, data).map { .toolUseStart(id: $0.id, name: $0.name) }
        case "tool_args_delta":
            return Self.payload(ToolArgsDeltaWire.self, data).map { .toolArgsDelta(index: $0.index, partialJson: $0.partialJson) }
        case "tool_result":
            return Self.payload(AgentV2ToolResult.self, data).map { .toolResult($0) }
        case "usage":
            return Self.payload(AgentV2Usage.self, data).map { .usage($0) }
        case "approval_request":
            return Self.payload(AgentV2Approval.self, data).map { .approvalRequest($0) }
        case "approval_resolved":
            return Self.payload(ApprovalResolvedWire.self, data).map { .approvalResolved(requestId: $0.requestId, outcome: $0.outcome) }
        case "mode_set":
            return Self.payload(ModeSetWire.self, data).map { .modeSet($0.mode) }
        case "tasks":
            return Self.payload(TasksWire.self, data).map { .tasks(tasks: $0.tasks, continueNeeded: $0.continueNeeded) }
        case "tasks_progress":
            return Self.payload(TasksProgressWire.self, data).map { .tasksProgress($0.tasks) }
        case "result":
            return Self.payload(AgentV2Result.self, data).map { .result($0) }
        case "error":
            return Self.payload(ErrorWire.self, data).map { .error(code: $0.code, message: $0.message) }
        case "sdk":
            return .sdk(Self.payload(SdkWire.self, data).flatMap { $0.sdkType })
        default:
            return .sdk(wire.type)
        }
    }

    /// Decode a payload struct from the full event JSON. The shared
    /// `type` discriminator rides the same object; the payload CodingKeys
    /// don't list it, so JSONDecoder skips it.
    private static func payload<T: Decodable>(_ type: T.Type, _ data: Data) -> T? {
        try? JSONDecoder().decode(T.self, from: data)
    }

    private struct WireType: Decodable { let type: String }

    // Wire fragments for the scalar-carrying cases. Private to this file —
    // callers consume the enum, never these.
    private struct DeltaWire: Decodable { let text: String }
    private struct ToolUseStartWire: Decodable { let id: String?; let name: String? }
    private struct ToolArgsDeltaWire: Decodable { let index: Int; let partialJson: String }
    private struct ApprovalResolvedWire: Decodable { let requestId: String; let outcome: String }
    private struct ModeSetWire: Decodable { let mode: String }
    private struct TasksWire: Decodable { let tasks: [AgentTask]; let continueNeeded: Bool }
    private struct TasksProgressWire: Decodable { let tasks: [AgentTask] }
    private struct ErrorWire: Decodable { let code: String?; let message: String }
    /// `sdk` events carry the raw upstream message in `raw` — decoding it
    /// is not required to observe the type, and forcing it would make a
    /// passthrough event fail on shapes we don't model. `sdkType` alone.
    private struct SdkWire: Decodable { let sdkType: String? }
}
