import Foundation

/// Part of the Claude linker (see `docs/explanation/claude-linker.md`):
/// the ONE table mapping tool wire names — llm-ide's own kebab-case tools
/// AND the Claude Agent SDK's CapitalizedCamel built-ins — to the words the
/// UI shows. When an SDK update renames a tool or adds a built-in, this
/// file (plus `AgentV2Event.swift` for wire shapes) is the Mac-side edit;
/// `LlmIdeAPIClient` and `ToolApprovalCard` delegate here and stay stable.
enum ClaudeToolPresentation {

    /// Wire tool name reduced to the name a verb can be looked up by.
    ///
    /// The v2 engine reports the SDK's own names, which come in two shapes
    /// the legacy loop never produced: MCP tools are namespaced
    /// (`mcp__llmide__task-update`) and built-ins are capitalized
    /// (`Bash`, `Read`). Both fell through `verb`'s default and rendered
    /// as "Using mcp__llmide__task-update" — a column of wire identifiers
    /// where the legacy engine showed sentences. Normalizing here rather
    /// than adding cases keeps ONE verb table for both engines.
    static func normalizedToolName(_ tool: String) -> String {
        // mcp__<server>__<tool> → <tool>. The server segment is an install
        // detail; the tool is the part with a verb.
        var name = tool
        if name.hasPrefix("mcp__"), let range = name.range(of: "__", options: .backwards) {
            name = String(name[range.upperBound...])
        }
        // The SDK's built-ins are CapitalizedCamel where every llm-ide tool
        // is kebab-case; lowercasing lets one table answer both.
        return name.lowercased()
    }

    /// Verb for a tool, phrased as the action being performed rather than the
    /// tool's wire name. "Using read-file…" tells the user nothing they care
    /// about; "Reading" plus the file does.
    static func verb(_ tool: String?) -> String {
        switch tool.map(normalizedToolName) {
        case "web-search":    return "Searching the web"
        case "fetch-url":     return "Fetching a page"
        case "ask-internal":  return "Checking app context"
        case "ask-subagent":  return "Delegating to a subagent"
        case "read-file":     return "Reading"
        case "list-files":    return "Listing"
        case "search-kb":     return "Searching the library"
        case "run-bash":      return "Running"
        case "bash":          return "Running"
        case "git-op":        return "Git"
        case "update-file":   return "Editing"
        case "list-issues":   return "Listing issues"
        case "get-issue":     return "Reading issue"
        case "task-create", "task-update", "task-list": return "Planning"
        // SDK built-ins (v2 engine). Same verbs as their llm-ide analogues
        // above, so a chat reads identically whichever engine ran the turn.
        case "read":          return "Reading"
        case "write":         return "Writing"
        case "edit", "multiedit", "notebookedit": return "Editing"
        case "glob":          return "Listing"
        case "grep":          return "Searching"
        case "websearch":     return "Searching the web"
        case "webfetch":      return "Fetching a page"
        case "task":          return "Delegating to a subagent"
        case "todowrite":     return "Planning"
        case "bashoutput":    return "Reading command output"
        case "killshell":     return "Stopping a command"
        case "slashcommand":  return "Running a command"
        case "exitplanmode":  return "Finishing the plan"
        case .some(let name): return "Using \(name)"
        case nil:             return "Working"
        }
    }

    /// Human-readable status for a progress event — shown as a live line in
    /// the Code Assistant instead of a frozen "Thinking…". `detail` is the
    /// tool's salient argument (file, query, command) supplied by the server;
    /// without it the line degrades to just the verb rather than exposing
    /// wire names.
    static func progressLabel(phase: String?, tool: String?, detail: String? = nil) -> String {
        switch phase {
        case "writing": return "Writing the answer…"
        case "tool":
            let verb = Self.verb(tool)
            if let detail, !detail.isEmpty { return "\(verb) \(detail)…" }
            return "\(verb)…"
        default: return "Thinking…"
        }
    }

    // MARK: - Approval card wording (per SDK tool name, NOT normalized —
    // approvals carry the SDK's exact `toolName` and the card must speak
    // about that specific tool).

    /// "Edit file" / "Write file" for the two write tools, "Run <name>" for
    /// everything else (Bash and any future gated tool), "Run tool" when the
    /// server didn't send a `toolName` at all.
    static func approvalTitle(toolName: String?) -> String {
        switch toolName {
        case "Edit": return "Edit file"
        case "Write": return "Write file"
        case .some(let name): return "Run \(name)"
        case nil: return "Run tool"
        }
    }

    /// SF Symbol matching `approvalTitle(toolName:)` — a pencil for Edit, a
    /// pencil-on-page for Write, a terminal glyph for everything else
    /// (Bash included, since a shell command IS what "terminal" reads as).
    static func approvalIcon(toolName: String?) -> String {
        switch toolName {
        case "Edit": return "pencil"
        case "Write": return "square.and.pencil"
        default: return "terminal.fill"
        }
    }

    /// "Always Allow Edit" / "Always Allow Write" / "Always Allow Bash" —
    /// a permanent grant must say which tool it always-allows rather than a
    /// bare "Always Allow". Falls back to the bare label (no trailing space)
    /// when the server didn't send a `toolName`.
    static func alwaysAllowLabel(toolName: String?) -> String {
        guard let name = toolName, !name.isEmpty else { return "Always Allow" }
        return "Always Allow \(name)"
    }
}
