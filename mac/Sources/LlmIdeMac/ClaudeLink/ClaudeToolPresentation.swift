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
        // Real SDK tool names, currently unreachable: neither is in
        // `V2_BUILTIN_ALLOWED_TOOLS` (engine.mjs), so `canUseTool` denies them.
        // Kept rather than deleted — allowing either server-side should not
        // also silently degrade its label to the "Using Task" fallback.
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

// MARK: - Salient argument

extension ClaudeToolPresentation {
    /// The one argument worth showing beside a tool's verb — "Reading
    /// Foo.swift" rather than a bare "Reading".
    ///
    /// The legacy wire has the SERVER pick this (`toolActivityDetail` in
    /// `llm_agent/runtime/loop.mjs`) and sends it as `detail`. The v2 wire
    /// sends the arguments whole instead, so the choice is made here — and it
    /// is made in the linker, next to the tool-name vocabulary, so the two
    /// engines' tool lines read identically.
    ///
    /// Deliberately mirrors the server's key order and its two presentation
    /// rules: a path shows only its last two segments (an absolute path gets
    /// truncated from the wrong end in a narrow chat column), and the result is
    /// capped so a line can never carry a file body or a diff.
    ///
    /// SDK built-ins use snake_case argument names (`file_path`) while
    /// llm-ide's own tools use `path`/`file`; both are accepted.
    static func salientArgument(tool: String?, argsJSON: String?) -> String? {
        guard let argsJSON, !argsJSON.isEmpty,
              let data = argsJSON.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        let keysInPriorityOrder = [
            "file_path", "path", "file",          // Read / Edit / Write / read-file
            "pattern", "query", "q",              // Grep / Glob / search-kb
            "command",                            // Bash / run-bash
            "url", "branch", "question", "prompt",
        ]
        var picked: String?
        for key in keysInPriorityOrder {
            if let value = object[key] as? String, !value.trimmingCharacters(in: .whitespaces).isEmpty {
                picked = value.trimmingCharacters(in: .whitespaces)
                break
            }
        }
        guard let raw = picked else { return nil }

        let normalized = normalizedToolName(tool ?? "")
        let isPathish = ["read-file", "list-files", "update-file", "read", "edit", "write", "multiedit"]
            .contains(normalized) || raw.contains("/")
        let shown = isPathish
            ? raw.split(separator: "/").suffix(2).joined(separator: "/")
            : raw
        let collapsed = shown.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return collapsed.count > 80 ? String(collapsed.prefix(80)) + "…" : collapsed
    }
}

// MARK: - Icon

extension ClaudeToolPresentation {
    /// SF Symbol for a tool, keyed on the NORMALIZED name so the SDK's
    /// built-ins (`Read`, `Bash`, `Edit`) and llm-ide's own kebab-case tools
    /// share one table.
    ///
    /// This used to live on `ChatMessage.ToolStep` as a second, independent
    /// switch keyed on the RAW wire name — so every SDK built-in fell through
    /// to the generic wrench while the verb beside it, resolved here, correctly
    /// said "Running". One event, two tables, two levels of knowledge, one row
    /// of the transcript.
    static func icon(for tool: String?) -> String {
        switch normalizedToolName(tool ?? "") {
        case "read-file", "read":                       return "doc.text"
        case "list-files", "glob":                      return "list.bullet"
        case "find-code", "grep":                        return "magnifyingglass"
        case "search-kb":                                return "books.vertical"
        case "web-search", "websearch":                  return "globe"
        case "fetch-url", "webfetch":                    return "link"
        case "bash", "run-bash", "bashoutput", "killshell": return "terminal"
        case "git-op":                                   return "arrow.triangle.branch"
        case "update-file", "edit", "write", "multiedit", "notebookedit": return "pencil"
        case "ask-internal", "ask-subagent", "task":     return "sparkles"
        case "task-create", "task-update", "task-list", "todowrite": return "checklist"
        case "project_memory":                           return "brain"
        case "load-skill", "slashcommand":               return "sparkle"
        case "exitplanmode":                             return "checkmark.seal"
        default:                                         return "wrench.and.screwdriver"
        }
    }
}
