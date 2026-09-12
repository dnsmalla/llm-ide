import Foundation

/// What the Swift decoder actually KEPT from one wire event.
///
/// This is the Mac half of `scripts/conformance-agent-v2.mjs`. The runner
/// compares this set against the field set declared in
/// `schema/agent-v2/agent-v2.schema.json`; a schema field missing from here is
/// a field the server sends and the app silently discards, and the gate fails
/// unless the runner's `ALLOWED_UNDECODED` table explains it.
///
/// Why a hand-written list rather than reflection: the payload types are
/// `Decodable`, not `Encodable`, so there is nothing to re-encode and inspect.
/// The switch below is exhaustive ON PURPOSE — adding an `AgentV2Event` case
/// breaks this file at compile time, which is the reminder to extend the schema
/// in the same edit.
///
/// Paths are dotted to match the schema's nesting (`questions.options.label`),
/// and only fields that are actually PRESENT on this value are reported: an
/// optional left nil by the fixture is not "captured".
/// The one symbol `chat-contract-lab` needs. Kept deliberately narrow: making
/// `AgentV2Event` itself public would expose the whole event vocabulary — ten
/// types — outside the module just to run a gate.
public enum AgentV2Conformance {
    /// Decode one wire event and report the fields Swift kept, or `nil` if the
    /// payload does not decode at all.
    public static func fieldReport(forJSON data: Data) -> [String]? {
        AgentV2Event.decode(fromJSON: data)?.decodedFieldNames()
    }

    /// The salient-argument picker, exposed for the lab. Pure string logic with
    /// two presentation rules (path-tail, 80-char cap) that are easy to break
    /// silently, and the v2 counterpart of the server's `toolActivityDetail`.
    public static func salientArgument(tool: String?, argsJSON: String?) -> String? {
        ClaudeToolPresentation.salientArgument(tool: tool, argsJSON: argsJSON)
    }

    /// The tool → SF Symbol table, exposed for the lab. `AgentProgressLabelTests`
    /// asserts the same mapping, but it is an XCTest file and this toolchain
    /// cannot even compile those — so the lab is where these actually run.
    public static func icon(for tool: String?) -> String {
        ClaudeToolPresentation.icon(for: tool)
    }

    /// The tool → verb table, same reasoning.
    public static func verb(for tool: String?) -> String {
        ClaudeToolPresentation.verb(tool)
    }
}

extension AgentV2Event {
    func decodedFieldNames() -> [String] {
        switch self {
        case .init_(let payload):
            var names = ["sessionId", "claudeCodeVersion", "model", "tools", "capabilities", "mcpServers"]
            if !payload.mcpServers.isEmpty {
                names += ["mcpServers.name", "mcpServers.status"]
            }
            return names

        case .delta:
            return ["text"]

        case .toolUseStart:
            return ["index", "id", "name"]

        case .toolArgsDelta:
            return ["index", "partialJson"]

        case .toolResult:
            return ["toolUseId", "isError", "text", "truncated"]

        case .usage(let payload):
            // `contextPercent` is declared on AgentV2Usage but no emitter sends
            // it — reported only when a fixture actually carries one, so the
            // runner sees the truth rather than the declaration.
            var names = ["inputTokens", "outputTokens", "cacheReadTokens"]
            if payload.cacheCreationTokens != nil { names.append("cacheCreationTokens") }
            if payload.contextPercent != nil { names.append("contextPercent") }
            return names

        case .approvalRequest(let approval):
            var names = ["requestId", "kind"]
            if approval.toolName != nil { names.append("toolName") }
            if approval.argsSummary != nil { names.append("argsSummary") }
            if let args = approval.args {
                names.append("args")
                if args.command != nil { names.append("args.command") }
                if args.filePath != nil { names.append("args.filePath") }
                if args.oldString != nil { names.append("args.oldString") }
                if args.newString != nil { names.append("args.newString") }
                if args.replaceAll != nil { names.append("args.replaceAll") }
                if args.contentPreview != nil { names.append("args.contentPreview") }
                if args.totalChars != nil { names.append("args.totalChars") }
                if args.exists != nil { names.append("args.exists") }
                if args.truncated != nil { names.append("args.truncated") }
            }
            if !approval.questions.isEmpty {
                names += ["questions", "questions.question", "questions.multiSelect", "questions.options"]
                if approval.questions.contains(where: { $0.header != nil }) {
                    names.append("questions.header")
                }
                let options = approval.questions.flatMap(\.options)
                if !options.isEmpty {
                    names.append("questions.options.label")
                    if options.contains(where: { $0.description != nil }) {
                        names.append("questions.options.description")
                    }
                    // NOTE: no `questions.options.preview` — the SDK sends it,
                    // AgentV2ApprovalOption has no such field, so option
                    // previews cannot render. Real drift, listed in the
                    // runner's ALLOWED_UNDECODED until the field is added.
                }
            }
            return names

        case .approvalResolved:
            return ["requestId", "outcome"]

        case .modeSet:
            return ["mode"]

        case .memory:
            return ["sessionFacts", "chars", "approxTokens"]

        case .tasks:
            return ["tasks", "tasks.id", "tasks.title", "tasks.status", "continueNeeded"]

        case .tasksProgress:
            return ["tasks", "tasks.id", "tasks.title", "tasks.status"]

        case .result:
            return ["subtype", "costUsd", "numTurns", "durationMs", "sessionId", "stopReason"]

        case .error:
            // NOTE: no `retryable` — the wire carries it, `ErrorWire` does not
            // decode it, so the Mac infers retryability from `code` alone.
            return ["code", "message"]

        case .sdk:
            // NOTE: no `subtype`, no `raw` — deliberately dropped.
            return ["sdkType"]
        }
    }
}
