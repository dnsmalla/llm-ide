import Foundation

/// v2 chat message envelope — the persisted shape for one turn inside a
/// `ChatSession`. This is the on-disk/model format only: `ChatEngine.history`
/// stays `[LlmIdeAPIClient.CodeAssistTurn]` until Task 9 rewires the
/// turn-lifecycle logic onto this type. Until then, the boundary between the
/// two is exactly `wireTurn()` (`ChatMessage` → wire turn) and
/// `init(wireTurn:sessionDate:)` (wire turn → `ChatMessage`).
///
/// The point of the richer shape: legacy history stored client-executed tool
/// acknowledgements as magic `"("`-prefixed user strings (e.g. "(applied
/// update to parser.swift: +3 lines)") and a stopped stream as a literal
/// `"\n\n_(stopped)_"` suffix on the content. v2 turns those into a typed
/// `role: .toolResult` message with a structured `ToolResultPayload`, and a
/// real `Status.stopped` — while still being able to resynthesize the exact
/// legacy wire text via `wireTurn()`, because the server-side agent loop only
/// understands `{role: "user"|"assistant", content}` and nothing about this
/// richer shape changes that contract.
struct ChatMessage: Identifiable, Codable, Equatable, Sendable {
    enum Role: String, Codable { case user, assistant, toolResult }
    enum Status: String, Codable { case streaming, done, stopped, failed }

    /// One tool step the agent took during a turn — "Reading Foo.swift",
    /// "Running npm test". Mirrors `CodeAssistantPanel.ToolStep` (still the
    /// type `ChatEngine.turnActivity` uses today; Task 9 is what actually
    /// moves the transcript's live rendering onto `ChatMessage`).
    struct ToolStep: Codable, Equatable, Identifiable, Sendable {
        let id: UUID
        let label: String
        let tool: String?
        let at: Date

        /// SF Symbol matching the action — copied verbatim from
        /// `CodeAssistantPanel.ToolStep.icon` (CodeAssistantPanel.swift:106-120)
        /// so the two render identically.
        var icon: String {
            switch tool {
            case "read-file", "get-issue":            return "doc.text"
            case "list-files", "list-issues":         return "list.bullet"
            case "search-kb":                         return "books.vertical"
            case "web-search":                        return "globe"
            case "fetch-url":                         return "link"
            case "bash", "run-bash":                  return "terminal"
            case "git-op":                            return "arrow.triangle.branch"
            case "update-file":                       return "pencil"
            case "ask-internal", "ask-subagent":      return "sparkles"
            case "task-create", "task-update", "task-list": return "checklist"
            default:                                  return "wrench.and.screwdriver"
            }
        }
    }

    /// Structured shape of a `role == .toolResult` message: what kind of
    /// client-executed tool produced it, plus whichever of the bash-specific
    /// fields apply.
    struct ToolResultPayload: Codable, Equatable, Sendable {
        enum Kind: String, Codable { case edit, bash, git, issue, skip, other }
        let kind: Kind
        /// Human line shown in the capsule ("applied update to parser.swift:
        /// +3 lines") — the first line of the legacy ack text.
        var summary: String
        var exitCode: Int?         // bash
        var command: String?       // bash
        var output: String?        // bash (full, beyond the first line)
        var url: String?           // issue/PR
        /// NOT in the brief's originally printed struct — added because the
        /// code this parser replaces (`BashResultDisplay` in
        /// CommandOutputView.swift) tracks failure separately from
        /// `exitCode`: the "blocked" variant has no exit code at all, and a
        /// failed command has a REAL exit code with `isFailure == true`,
        /// while a successful one has `isFailure == false`. Neither
        /// `exitCode == nil` nor `exitCode != 0` recovers this correctly for
        /// every case, so it needs its own field — the same reasoning
        /// `BashResultDisplay.isFailure` already encoded.
        var isFailure: Bool = false

        /// Parses the `"(bash result - exit code: N)\n$ <command>\n<output>"`
        /// convention (and its "(bash failed - …)" / "(bash blocked - …)"
        /// variants) — moved verbatim from `BashResultDisplay.parse`
        /// (CommandOutputView.swift:14-48), just retargeted to return a
        /// `ToolResultPayload` (`kind: .bash`) instead of a
        /// `BashResultDisplay`. Same regex/prefix logic, same "blocked"
        /// special case. Returns nil for anything that isn't a bash-result
        /// turn, exactly like the original.
        static func parse(content: String) -> ToolResultPayload? {
            guard content.hasPrefix("(bash ") else { return nil }
            var lines = content.components(separatedBy: "\n")
            guard !lines.isEmpty else { return nil }
            let header = lines.removeFirst()
            let isFailure = header.contains("failed") || header.contains("blocked")
            var exitCode: Int?
            if let range = header.range(of: "exit code: ") {
                let digits = header[range.upperBound...].prefix { $0.isNumber || $0 == "-" }
                exitCode = Int(digits)
            }
            var command: String?
            if let first = lines.first, first.hasPrefix("$ ") {
                command = String(first.dropFirst(2))
                lines.removeFirst()
            }
            var output = lines.joined(separator: "\n")
            // The "blocked" variant (CodeAssistant+Bash.swift's
            // validateCommand guard) is a single-line message with no exit
            // code, no command, and no separate body — the header IS the
            // whole message (e.g. "(bash blocked - command contains
            // potentially dangerous operations)"). Keyed directly on the
            // "blocked" keyword rather than inferring it from the absence of
            // exitCode/command/output, matching the original's reasoning.
            if header.contains("blocked") {
                var message = header
                if message.hasPrefix("(bash ") { message.removeFirst(6) }
                if message.hasSuffix(")") { message.removeLast() }
                output = message
            }
            let summary = header.trimmingCharacters(in: .whitespaces)
            return ToolResultPayload(kind: .bash, summary: summary, exitCode: exitCode,
                                      command: command, output: output, url: nil,
                                      isFailure: isFailure)
        }
    }

    struct Metadata: Codable, Equatable, Sendable {
        var mode: String?
        var usage: LlmIdeAPIClient.CodeAssistResponse.Usage?
        var skills: [String]?
        var failedError: String?
        var retryPayload: RetryPayload?
    }

    struct RetryPayload: Codable, Equatable, Sendable {
        let message: String
        let skillIds: [String]
    }

    let id: UUID
    let role: Role
    var content: String
    var status: Status
    let createdAt: Date
    var toolSteps: [ToolStep]
    var toolResult: ToolResultPayload?   // role == .toolResult
    var metadata: Metadata?

    /// Verbatim legacy wire text, set only when this message was produced by
    /// `migrate(role:content:sessionDate:)` (v1→v2 migration, OR the
    /// `ChatEngine` ↔ `ChatSession` boundary conversion, which runs every
    /// live turn through the same function). `wireTurn()` returns this
    /// untouched when present, guaranteeing a byte-exact round trip for
    /// every migrated/converted `.toolResult` message — including the
    /// non-bash kinds (e.g. "(applied update to X: Y)") whose `summary`
    /// alone is not always enough to reconstruct the original string.
    /// Private: it exists purely to make `wireTurn()` exact, not as
    /// something other code should read or compare on.
    private var legacyContent: String?

    init(id: UUID = UUID(), role: Role, content: String, status: Status, createdAt: Date,
         toolSteps: [ToolStep] = [], toolResult: ToolResultPayload? = nil,
         metadata: Metadata? = nil, legacyContent: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.status = status
        self.createdAt = createdAt
        self.toolSteps = toolSteps
        self.toolResult = toolResult
        self.metadata = metadata
        self.legacyContent = legacyContent
    }

    // MARK: - v1 → v2 migration

    /// THE single transform behind both v1 JSON migration
    /// (`ChatSession.init(from:)`, one call per legacy `{role, content}`
    /// turn) and the `ChatEngine` ↔ `ChatSession` boundary conversion
    /// (`init(wireTurn:sessionDate:)` below) — the brief's Interfaces section
    /// names the migration entry point `migrate(role:content:sessionDate:)`
    /// and its Step 3 prose separately mentions a `fromWireTurn` for the
    /// engine-boundary conversion, but a `(role, content)` pair IS a
    /// `CodeAssistTurn` (that's its whole wire shape) — same classification
    /// work either way, so there is exactly one implementation, not two.
    ///
    /// `sessionDate` becomes `createdAt`: v1 turns had no per-turn timestamp,
    /// so migration uses the session's `lastUsedAt` as a best-effort stand-in
    /// (per the brief); the engine-boundary conversion passes the actual
    /// current time for freshly-written turns.
    static func migrate(role: LlmIdeAPIClient.CodeAssistRole, content: String, sessionDate: Date) -> ChatMessage {
        // Bash-result ack — checked first because "(bash " is a MORE
        // SPECIFIC prefix than the generic "(" branch below; letting the
        // generic branch run first would downgrade every bash turn to
        // `.other` before this ever got a chance to match.
        if role == .user, let payload = ToolResultPayload.parse(content: content) {
            return ChatMessage(role: .toolResult, content: content, status: .done,
                                createdAt: sessionDate, toolResult: payload, legacyContent: content)
        }
        // Every other legacy synthetic-ack convention: role user, content
        // starting with "(". See `classifyAckKind`'s doc comment for the
        // full list of conventions this covers and why it's best-effort.
        if role == .user, content.hasPrefix("(") {
            let summary = content.components(separatedBy: "\n").first ?? content
            let kind = classifyAckKind(content)
            let payload = ToolResultPayload(kind: kind, summary: summary, exitCode: nil,
                                             command: nil, output: nil, url: nil, isFailure: false)
            return ChatMessage(role: .toolResult, content: content, status: .done,
                                createdAt: sessionDate, toolResult: payload, legacyContent: content)
        }
        // Assistant turn ending in the legacy stopped marker
        // (`ChatEngine.finishStreamingTurn`'s `"\n\n_(stopped)_"` suffix,
        // only ever appended when the content was non-empty — see that
        // function's guard — so a suffix match here always has real content
        // in front of it).
        if role == .assistant, content.hasSuffix("\n\n_(stopped)_") {
            let stripped = String(content.dropLast("\n\n_(stopped)_".count))
            return ChatMessage(role: .assistant, content: stripped, status: .stopped, createdAt: sessionDate)
        }
        let mappedRole: Role = role == .user ? .user : .assistant
        return ChatMessage(role: mappedRole, content: content, status: .done, createdAt: sessionDate)
    }

    /// Convenience wrapper for the `CodeAssistTurn` case of `migrate` — used
    /// by v1 JSON migration (one call per legacy turn) and by the
    /// engine-boundary conversions in `ChatEngine.swift`
    /// (`persistCurrentChat`, `handleOnAppearSessions`, `switchSession`,
    /// `deleteSession`, `reloadFromDisk`) and `MobileControlManager.swift`'s
    /// explorer-chat proxy, all of which need a `CodeAssistTurn` (which is
    /// just `{role, content}`) turned into the right `ChatMessage` shape.
    init(wireTurn: LlmIdeAPIClient.CodeAssistTurn, sessionDate: Date) {
        self = ChatMessage.migrate(role: wireTurn.role, content: wireTurn.content, sessionDate: sessionDate)
    }

    /// Classifies a legacy `"("`-prefixed synthetic-ack user turn into a
    /// `ToolResultPayload.Kind`, for OLD-DATA MIGRATION DISPLAY PURPOSES
    /// ONLY. This is a best-effort label so an old chat still shows
    /// "something like an edit/git op/issue happened here" — it is NOT a
    /// byte-perfect oracle, the same spirit as Task 2's v1 fixtures
    /// documenting their own best-effort choices. New data written going
    /// forward doesn't need this: a v2 message's kind comes directly from
    /// whichever call site constructs it.
    ///
    /// Conventions covered (grepped from the actual synthetic-ack call
    /// sites — more than the brief's original 3-substring list):
    ///   - `CodeAssistantPanel+Session.swift`: "executed create-issue → #N url"
    ///   - `CodeAssistant+Issues.swift`: "executed comment-issue → #N",
    ///     "executed update-issue → #N"
    ///   - `CodeAssistant+PR.swift`: "executed create-pr → #N: url" — shares
    ///     `.issue` with the ticket conventions above: `ToolResultPayload.url`
    ///     is documented as "issue/PR", there's no separate `.pr` case.
    ///   - `CodeAssistant+Git.swift`: "executed create-branch → branch", and
    ///     every "(git OP …)" ack (skipped/result/failed) — all `.git`.
    ///   - `CodeAssistantPanel+Session.swift`: "applied update to file: delta" → `.edit`
    ///   - `CodeAssistant+Edits.swift`: "skipped the proposed edit to …" → `.skip`
    ///   - anything else "("-prefixed → `.other`
    private static func classifyAckKind(_ content: String) -> ToolResultPayload.Kind {
        if content.contains("executed create-issue") ||
            content.contains("executed comment-issue") ||
            content.contains("executed update-issue") ||
            content.contains("executed create-pr") {
            return .issue
        }
        if content.contains("executed create-branch") || content.hasPrefix("(git ") {
            return .git
        }
        if content.contains("applied update") {
            return .edit
        }
        if content.contains("skipped") {
            return .skip
        }
        return .other
    }

    // MARK: - Wire encoding — THE server contract (spec: unchanged)

    /// Reconstructs the legacy `{role: "user"|"assistant", content}` shape
    /// the server still (and only ever) understands. Byte-exact for any
    /// message produced by `migrate`/`init(wireTurn:sessionDate:)` (which is
    /// every message this task can produce) because those always populate
    /// `legacyContent` for anything that isn't a plain `.done` turn, and a
    /// plain turn's own `content` IS the original string untouched.
    func wireTurn() -> LlmIdeAPIClient.CodeAssistTurn {
        if let legacyContent {
            return .init(role: .user, content: legacyContent)
        }
        switch role {
        case .toolResult:
            // Defensive fallback for a `.toolResult` message constructed
            // some OTHER way than `migrate` (none exist yet — Task 9 is what
            // adds direct construction sites). Best-effort reconstruction
            // from the typed payload; not exercised by this task's tests.
            return .init(role: .user, content: wireTextForToolResultFallback())
        case .assistant:
            let text = (status == .stopped && !content.isEmpty) ? content + "\n\n_(stopped)_" : content
            return .init(role: .assistant, content: text)
        case .user:
            return .init(role: .user, content: content)
        }
    }

    private func wireTextForToolResultFallback() -> String {
        guard let payload = toolResult else { return content }
        guard payload.kind == .bash else { return payload.summary }
        guard let command = payload.command else {
            return "(bash blocked - \(payload.summary))"
        }
        let header = "(bash \(payload.isFailure ? "failed" : "result") - exit code: \(payload.exitCode.map(String.init) ?? "0"))"
        return "\(header)\n$ \(command)\n\n\(payload.output ?? "")"
    }
}
