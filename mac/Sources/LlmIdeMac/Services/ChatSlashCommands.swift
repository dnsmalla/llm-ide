import Foundation

/// Built-in chat slash commands — recognized as real UI actions the same way
/// Claude Code's own /clear works, NOT sent to the model as a prompt. Kept as
/// a small pure helper (not inlined in ChatComposer.submit()) so the parsing
/// itself is unit-testable without the surrounding chat/session machinery.
/// Mirrors extension/src/sidepanel/chat-commands.ts's isBuiltinClearCommand —
/// same command set, same case/whitespace tolerance, both surfaces.
///
/// Scoped deliberately: only commands with a REAL llm-ide equivalent are
/// declared here. Most of Claude Code's own command set (/login, /desktop,
/// /teleport, /keybindings, ...) has no llm-ide analogue at all, and showing
/// them as if they worked would be worse than not showing them — see the
/// llm_default_sources/commands/commands.json reference catalog for the
/// full Claude Code list instead (browsable, not wired to any action).
enum ChatSlashCommands {

    // MARK: - Catalog (single source of truth)

    /// What accepting/submitting a built-in does. The recognizer tables below
    /// are DERIVED from this, so the "/" menu, the alias set, and the actual
    /// behavior cannot drift apart (they used to be three hand-kept copies).
    enum Action: Equatable {
        case clearChat
        case openSection(ShellState.Section)
        case switchModel
    }

    /// One built-in "/" command. `insert` is what the composer draft becomes
    /// when the menu row is accepted (a trailing space means "now type the
    /// argument", e.g. "/model "). `detail` folds the aliases into the
    /// description so they stay discoverable without separate rows.
    struct Builtin: Equatable {
        let label: String       // canonical form, e.g. "/clear"
        let aliases: [String]   // e.g. ["/reset", "/new"] — same action
        let description: String
        let insert: String
        let action: Action

        init(label: String, aliases: [String] = [], description: String,
             insert: String? = nil, action: Action) {
            self.label = label; self.aliases = aliases
            self.description = description
            self.insert = insert ?? label
            self.action = action
        }

        /// Menu row description, aliases appended from the SAME array the
        /// recognizers are built from — never a hand-written restatement.
        var detail: String {
            guard !aliases.isEmpty else { return description }
            let word = aliases.count == 1 ? "alias" : "aliases"
            return "\(description) (\(word): \(aliases.joined(separator: ", ")))"
        }
    }

    /// The built-in command set. `/loop` maps to llm-ide's own Loop Engine —
    /// the closest analogue to Claude Code's "/loop: run a prompt on a
    /// recurring interval". `/hooks`, `/mcp`, `/plugin`, `/agents` land on
    /// the Library, where plugin hook handlers/trust, MCP servers, and
    /// subagents are inspected and configured.
    static let builtins: [Builtin] = [
        Builtin(label: "/clear", aliases: ["/reset", "/new"],
                description: "Clear this conversation", action: .clearChat),
        Builtin(label: "/model",
                description: "Switch the model for the current provider",
                insert: "/model ", action: .switchModel),
        Builtin(label: "/config", aliases: ["/settings"],
                description: "Open Settings", action: .openSection(.settings)),
        Builtin(label: "/loop",
                description: "Open the Loop Engine", action: .openSection(.loopEngine)),
        Builtin(label: "/mcp",
                description: "Open Library → MCP Plugins", action: .openSection(.library)),
        Builtin(label: "/plugin", aliases: ["/plugins"],
                description: "Open Library → Plugins", action: .openSection(.library)),
        Builtin(label: "/agents",
                description: "Open Library → Plugins (subagents)", action: .openSection(.library)),
        Builtin(label: "/hooks",
                description: "Open Library → Plugins (hook handlers & trust)",
                action: .openSection(.library)),
    ]

    /// Every name (canonical + alias) a built-in answers to, lowercased —
    /// used by the "/" menu to drop plugin commands that would be shadowed:
    /// submit() checks these recognizers BEFORE dispatching to the server,
    /// so a plugin command with a colliding trigger could never run anyway,
    /// and listing it would be a lie.
    static let reservedNames: Set<String> = Set(
        builtins.flatMap { [$0.label] + $0.aliases }.map { $0.lowercased() }
    )

    // MARK: - Recognizers (derived from `builtins`)

    private static let clearCommands: Set<String> = Set(
        builtins.filter { $0.action == .clearChat }
            .flatMap { [$0.label] + $0.aliases }
            .map { $0.lowercased() }
    )

    private static let sectionCommands: [String: ShellState.Section] = {
        var map: [String: ShellState.Section] = [:]
        for b in builtins {
            guard case .openSection(let section) = b.action else { continue }
            for name in [b.label] + b.aliases { map[name.lowercased()] = section }
        }
        return map
    }()

    /// Whether `text` (as typed, before any send) is a built-in "clear chat" command.
    static func isClearCommand(_ text: String) -> Bool {
        clearCommands.contains(text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    /// The app section `text` should navigate to, or nil if it isn't one of
    /// the section commands — real navigation via the same `.openSection`
    /// notification AppShell already listens for (see NotificationNames.swift),
    /// not a fake/inert entry.
    static func sectionCommand(_ text: String) -> ShellState.Section? {
        sectionCommands[text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()]
    }

    /// The argument after "/model" (possibly empty, for a bare "/model"), or
    /// nil if `text` isn't a /model command at all.
    static func modelArgument(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased() == "/model" || trimmed.lowercased().hasPrefix("/model ") else { return nil }
        return String(trimmed.dropFirst("/model".count)).trimmingCharacters(in: .whitespaces)
    }
}
