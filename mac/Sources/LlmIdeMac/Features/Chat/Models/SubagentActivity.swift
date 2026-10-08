import Foundation

/// What one turn's plugin subagents did — the composer's "N agents" chip and
/// its popover. Derived, never stored: the source of truth is the turn's
/// persisted tool steps, so a reloaded session shows the same summary.
///
/// LLM-IDE subagents are plugin subagents reached through the `ask-subagent`
/// tool (the SDK's own Agent/Task tool is disabled on purpose — engine.mjs).
/// On v2 it arrives MCP-prefixed (`mcp__llmide__ask-subagent`), on legacy bare.
///
/// Public and pure so `chat-contract-lab` asserts it (no XCTest here).
public struct SubagentActivity: Equatable, Sendable {
    public enum State: String, Equatable, Sendable {
        case running, done, error
        /// The turn ended (Stop, failure) before the subagent answered.
        case stopped
    }

    /// One subagent call.
    public struct Run: Equatable, Sendable, Identifiable {
        /// Position in the turn's step list — stable for the turn's lifetime.
        public let id: Int
        /// The subagent's name, or nil while its arguments are still streaming.
        public let name: String?
        public let state: State
        public let startedAt: Date
        public let endedAt: Date?
        /// What actually ran (the result's `meta`, API v71+). Nil on legacy,
        /// on older servers, and while running.
        public let provider: String?
        public let model: String?
        public let tier: String?

        /// Seconds from start to end, or to `now` while running. Nil when the
        /// end is unknown for a finished run (a step persisted before
        /// `endedAt` existed).
        public func elapsed(now: Date) -> TimeInterval? {
            if let endedAt { return max(0, endedAt.timeIntervalSince(startedAt)) }
            return state == .running ? max(0, now.timeIntervalSince(startedAt)) : nil
        }
    }

    /// The fields of a tool step this summary reads — a public mirror of
    /// `ChatMessage.ToolStep`, which stays internal.
    public struct Step: Sendable {
        public let tool: String?
        public let args: String?
        public let resultText: String?
        public let isError: Bool?
        public let at: Date
        public let endedAt: Date?

        public init(tool: String?, args: String?, resultText: String?, isError: Bool?, at: Date, endedAt: Date?) {
            self.tool = tool
            self.args = args
            self.resultText = resultText
            self.isError = isError
            self.at = at
            self.endedAt = endedAt
        }
    }

    /// Where the turn is — decides what an unanswered call means.
    public enum Turn: Sendable { case streaming, done, stopped, failed }

    public let runs: [Run]

    public var total: Int { runs.count }
    public var runningCount: Int { runs.filter { $0.state == .running }.count }
    public var isEmpty: Bool { runs.isEmpty }

    /// The chip's text: "0 agents", "1 agent", "3 agents"; "1 running" while
    /// any is running (Claude Code's footer reads the same way).
    public var chipLabel: String {
        if runningCount > 0 { return "\(runningCount) running" }
        return total == 1 ? "1 agent" : "\(total) agents"
    }

    public static let empty = SubagentActivity(runs: [])

    public init(runs: [Run]) { self.runs = runs }

    /// The summary of one turn's steps.
    public static func derive(steps: [Step], turn: Turn) -> SubagentActivity {
        var runs: [Run] = []
        for (index, step) in steps.enumerated() where isSubagentTool(step.tool) {
            let meta = step.resultText.flatMap(Self.meta(resultText:))
            runs.append(Run(
                id: index,
                name: subagentName(argsJSON: step.args),
                state: state(of: step, turn: turn),
                startedAt: step.at,
                endedAt: step.endedAt,
                provider: meta?.provider,
                model: meta?.model,
                tier: meta?.tier
            ))
        }
        return SubagentActivity(runs: runs)
    }

    /// `ask-subagent`, bare (legacy) or MCP-prefixed (v2).
    public static func isSubagentTool(_ tool: String?) -> Bool {
        ClaudeToolPresentation.isSubagentTool(tool)
    }

    /// The `name` argument of an `ask-subagent` call.
    public static func subagentName(argsJSON: String?) -> String? {
        guard let object = jsonObject(argsJSON),
              let name = (object["name"] as? String)?.trimmingCharacters(in: .whitespaces),
              !name.isEmpty else { return nil }
        return name
    }

    /// The `meta` block of an `ask-subagent` result (API v71+). The server puts
    /// it FIRST, so a result the wire cut at 20k chars (a long answer) still
    /// carries it: when the whole text does not parse, the leading
    /// `{"meta":{…}` object is cut out and parsed alone. Nil for an older
    /// server's result or plain text.
    public static func meta(resultText: String) -> (provider: String?, model: String?, tier: String?)? {
        // Cheap reject first: results are up to 20k chars and this runs on
        // every composer render.
        guard resultText.contains("\"meta\""),
              let meta = (jsonObject(resultText)?["meta"] as? [String: Any])
                ?? leadingMetaObject(resultText) else { return nil }
        func text(_ key: String) -> String? {
            guard let value = meta[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        return (text("provider"), text("model"), text("tier"))
    }

    /// "anthropic · Haiku 4.5 (cheap)" — what the popover shows under a run.
    /// Nil when nothing is known.
    public static func routeLabel(provider: String?, model: String?, tier: String?) -> String? {
        let modelName = model.map { ModelDisplayName.fromId($0) ?? $0 }
        let parts = [provider, modelName].compactMap { $0 }
        guard !parts.isEmpty else { return tier.map { "(\($0))" } }
        let base = parts.joined(separator: " · ")
        return tier.map { "\(base) (\($0))" } ?? base
    }

    /// "4s", "1m 05s" — elapsed time in the popover.
    public static func elapsedLabel(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded(.down))
        if whole < 60 { return "\(whole)s" }
        return String(format: "%dm %02ds", whole / 60, whole % 60)
    }

    private static func state(of step: Step, turn: Turn) -> State {
        if step.isError == true || isErrorResult(step.resultText) { return .error }
        if step.resultText != nil || step.endedAt != nil { return .done }
        switch turn {
        case .streaming: return .running
        // A done turn with an unanswered call: only a step persisted before
        // `endedAt` existed looks like this — it did finish.
        case .done: return .done
        case .stopped: return .stopped
        case .failed: return .error
        }
    }

    /// The handler's failure envelope is `{"error": "…"}` with is_error false
    /// (it returns rather than throws), so the flag alone misses it.
    private static func isErrorResult(_ text: String?) -> Bool {
        guard let text, text.hasPrefix("{\"error\"") else { return false }
        return jsonObject(text)?["error"] != nil
    }

    /// The object after a leading `{"meta":` — brace-balanced, skipping
    /// braces inside strings — parsed on its own.
    private static func leadingMetaObject(_ text: String) -> [String: Any]? {
        let prefix = "{\"meta\":"
        guard text.hasPrefix(prefix) else { return nil }
        let body = text.utf8.dropFirst(prefix.utf8.count)
        guard body.first == UInt8(ascii: "{") else { return nil }
        var depth = 0
        var inString = false
        var escaped = false
        var end = body.startIndex
        scan: for index in body.indices {
            let byte = body[index]
            if inString {
                if escaped { escaped = false } else if byte == UInt8(ascii: "\\") { escaped = true } else if byte == UInt8(ascii: "\"") { inString = false }
                continue
            }
            switch byte {
            case UInt8(ascii: "\""): inString = true
            case UInt8(ascii: "{"): depth += 1
            case UInt8(ascii: "}"):
                depth -= 1
                if depth == 0 { end = body.index(after: index); break scan }
            default: break
            }
        }
        guard depth == 0, end > body.startIndex else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(body[body.startIndex..<end]))) as? [String: Any]
    }

    private static func jsonObject(_ text: String?) -> [String: Any]? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

extension SubagentActivity {
    /// The summary of one transcript message's steps.
    static func of(_ message: ChatMessage?) -> SubagentActivity {
        guard let message else { return .empty }
        let turn: Turn
        switch message.status {
        case .streaming: turn = .streaming
        case .done: turn = .done
        case .stopped: turn = .stopped
        case .failed: turn = .failed
        }
        return derive(steps: message.toolSteps.map {
            Step(tool: $0.tool, args: $0.args, resultText: $0.resultText,
                 isError: $0.isError, at: $0.at, endedAt: $0.endedAt)
        }, turn: turn)
    }
}
