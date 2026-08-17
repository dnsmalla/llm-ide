import Foundation

/// v2 chat message envelope — the shape of one turn both on disk (inside a
/// `ChatSession`) and in memory (`ChatEngine.messages`). The wire boundary
/// with the server is exactly `wireTurn()` (`ChatMessage` → `{role, content}`)
/// and `migrate(role:content:sessionDate:)` / `init(wireTurn:sessionDate:)`
/// (`{role, content}` → `ChatMessage`).
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
    /// "Running npm test" — so the transcript shows WHAT it did instead of the
    /// raw `<<<TOOL_CALL>>>` JSON that used to stream into the reply. Replaces
    /// the old view-nested `CodeAssistantPanel.ToolStep` (deleted in Task 9,
    /// together with the `ChatEngine.turnActivity` dictionary that keyed them
    /// by turn id): steps now live on the message they belong to, so they
    /// survive a session reload instead of being in-memory only.
    struct ToolStep: Codable, Equatable, Identifiable, Sendable {
        let id: UUID
        let label: String
        let tool: String?
        let at: Date

        init(id: UUID = UUID(), label: String, tool: String?, at: Date = Date()) {
            self.id = id
            self.label = label
            self.tool = tool
            self.at = at
        }

        /// SF Symbol matching the action — carried over verbatim from the
        /// deleted `CodeAssistantPanel.ToolStep.icon` so the transcript
        /// renders identically to before.
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
        /// +3 lines") — the first line of the legacy ack text, verbatim.
        var summary: String
        var exitCode: Int?         // bash
        var command: String?       // bash
        /// Everything after the first line (and, for bash, after the
        /// `"$ <command>"` line): the command's output, a git op's stdout, an
        /// edit ack's continuation. `nil` — NOT `""` — when the ack was a
        /// single line, because `legacyContent()` distinguishes the two
        /// ("(git push result)" vs "(git push result)\n").
        var output: String?
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
            // nil, not "", when nothing followed the header/command line —
            // see `output`'s doc comment and `legacyContent()`.
            var output: String? = lines.isEmpty ? nil : lines.joined(separator: "\n")
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

        /// THE inverse of the classification above: rebuilds the exact legacy
        /// synthetic-ack string this payload was parsed from, purely from the
        /// typed fields. This is the ONLY thing the server ever sees of a
        /// `.toolResult` message (`ChatMessage.wireTurn()` and
        /// `ChatEngine.historyForRequest` both go through it), so it has to be
        /// byte-identical to what the confirmers in `CodeAssistant+Bash/Git/
        /// Edits/Issues/PR.swift` wrote — otherwise the agent's view of its own
        /// tool results would silently drift mid-session across the upgrade.
        /// `ChatEngineMessageTests` pins that round trip against every v1
        /// fixture.
        ///
        /// The header is `summary` verbatim rather than re-rendered from
        /// `kind`/`exitCode`/`isFailure`: those three don't carry enough to
        /// reproduce the exact wording ("(bash result - exit code: 0)" vs
        /// "(bash failed - exit code: 1)" vs "(git push result)"), and the
        /// first line is stored losslessly anyway.
        func legacyContent() -> String {
            // The "blocked" bash variant is a single-line message whose header
            // IS the whole content; `parse` unwrapped it by dropping the
            // leading "(bash " (6 chars) and the trailing ")", so re-wrapping
            // `output` — NOT `summary`, which is still the fully-wrapped
            // header and would nest a second "(bash …)" around it — restores
            // the original exactly.
            if kind == .bash, summary.contains("blocked") {
                return output.map { "(bash \($0))" } ?? summary
            }
            var text = summary
            // bash only: the "$ <command>" line sits between the header and
            // the output. Non-bash acks have no such line, and `command` is
            // always nil for them.
            if let command { text += "\n$ \(command)" }
            // A SINGLE newline before the body — the production format is
            // `"\(header)\n$ \(displayCommand)\n\(body)"` (CodeAssistant+Bash
            // .swift), and any blank line the real output started with is
            // already part of `output`.
            if let output { text += "\n" + output }
            return text
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

    init(id: UUID = UUID(), role: Role, content: String, status: Status, createdAt: Date,
         toolSteps: [ToolStep] = [], toolResult: ToolResultPayload? = nil,
         metadata: Metadata? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.status = status
        self.createdAt = createdAt
        self.toolSteps = toolSteps
        self.toolResult = toolResult
        self.metadata = metadata
    }

    // MARK: - v1 → v2 migration

    /// THE single transform behind v1 JSON migration
    /// (`ChatSession.init(from:)`, one call per legacy `{role, content}`
    /// turn) AND live classification of the synthetic tool-result acks the
    /// confirmers still produce as strings (`ChatEngine.appendTurn` →
    /// `init(wireTurn:sessionDate:)` below) — the brief's Interfaces section
    /// names the migration entry point `migrate(role:content:sessionDate:)`
    /// and its Step 3 prose separately mentions a `fromWireTurn` for the
    /// engine-boundary conversion, but a `(role, content)` pair IS a
    /// `CodeAssistTurn` (that's its whole wire shape) — same classification
    /// work either way, so there is exactly one implementation, not two.
    ///
    /// `sessionDate` becomes `createdAt`: v1 turns had no per-turn timestamp,
    /// so migration uses the session's `lastUsedAt` as a best-effort stand-in
    /// (per the brief); a live append passes the actual current time.
    ///
    /// NOTE: this classifies ANY `"("`-prefixed user string as a tool result,
    /// which is why `ChatEngine.runTurn` does NOT route the human's own
    /// prompt through it — a person who opens a message with a parenthesis is
    /// still typing a message.
    static func migrate(role: LlmIdeAPIClient.CodeAssistRole, content: String, sessionDate: Date) -> ChatMessage {
        // Bash-result ack — checked first because "(bash " is a MORE
        // SPECIFIC prefix than the generic "(" branch below; letting the
        // generic branch run first would downgrade every bash turn to
        // `.other` before this ever got a chance to match.
        if role == .user, let payload = ToolResultPayload.parse(content: content) {
            return ChatMessage(role: .toolResult, content: content, status: .done,
                                createdAt: sessionDate, toolResult: payload)
        }
        // Every other legacy synthetic-ack convention: role user, content
        // starting with "(". See `classifyAckKind`'s doc comment for the
        // full list of conventions this covers and why it's best-effort.
        //
        // Split into first line + remainder exactly the way the bash branch
        // above does, so `legacyContent()` can reconstruct the WHOLE ack
        // rather than just its first line: a git-op result ("(git push
        // result)\n<stdout>") carries real content on the lines after the
        // summary, and truncating it would quietly change what the agent
        // sees of its own tool output.
        if role == .user, content.hasPrefix("(") {
            let lines = content.components(separatedBy: "\n")
            let summary = lines.first ?? content
            let body = lines.count > 1 ? lines.dropFirst().joined(separator: "\n") : nil
            let kind = classifyAckKind(content)
            let payload = ToolResultPayload(kind: kind, summary: summary, exitCode: nil,
                                             command: nil, output: body, url: nil,
                                             isFailure: ackIsFailure(summary: summary, kind: kind))
            return ChatMessage(role: .toolResult, content: content, status: .done,
                                createdAt: sessionDate, toolResult: payload)
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
    /// by v1 JSON migration (one call per legacy turn), by
    /// `ChatEngine.appendTurn` (the confirmers' synthetic acks, classified on
    /// the way in) and by `MobileControlManager.swift`'s explorer-chat proxy,
    /// all of which hold a `CodeAssistTurn` (which is just `{role, content}`)
    /// and need the right `ChatMessage` shape for it.
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

    /// Whether a non-bash ack should render as a warning rather than a
    /// success. This is where the old `ChatMessageList.toolNoticeIcon`
    /// content-sniffing moved to: the VIEW now just reads
    /// `payload.isFailure`, and the one place that has to look at the legacy
    /// wording is the classifier that owns every other legacy-string decision.
    ///
    /// Deliberately narrowed from the old check, which scanned the WHOLE ack
    /// text: a successful "(git push result)" whose stdout happened to contain
    /// the word "failed" used to flip the capsule to a warning. Only the
    /// summary line — the one the capsule actually shows — decides now.
    private static func ackIsFailure(summary: String, kind: ToolResultPayload.Kind) -> Bool {
        kind == .skip || summary.contains("failed") || summary.contains("skipped")
    }

    // MARK: - Wire encoding — THE server contract (spec: unchanged)

    /// Reconstructs the legacy `{role: "user"|"assistant", content}` shape
    /// the server still (and only ever) understands.
    ///
    /// A `.toolResult` message rebuilds its text from the typed payload via
    /// `ToolResultPayload.legacyContent()` — there is no stored copy of the
    /// original string to short-circuit with (Task 8 kept one; Task 9 dropped
    /// it once `legacyContent()` became lossless for EVERY kind, so a
    /// tool-result turn no longer costs two copies of its text on disk and
    /// there is exactly one reconstruction path to test). The `?? content`
    /// fallback covers a `.toolResult` message with no payload at all, which
    /// nothing constructs.
    func wireTurn() -> LlmIdeAPIClient.CodeAssistTurn {
        switch role {
        case .toolResult:
            return .init(role: .user, content: toolResult?.legacyContent() ?? content)
        case .assistant:
            // `Status.stopped` is the v2 representation; the marker suffix is
            // re-attached ONLY here, on the way out to the server, so the
            // agent still reads a stopped reply the way it always has.
            let text = (status == .stopped && !content.isEmpty) ? content + "\n\n_(stopped)_" : content
            return .init(role: .assistant, content: text)
        case .user:
            return .init(role: .user, content: content)
        }
    }
}
