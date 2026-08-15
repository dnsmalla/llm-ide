import Foundation

/// Built-in chat slash commands — recognized as real UI actions the same way
/// Claude Code's own /clear works, NOT sent to the model as a prompt. Kept as
/// a small pure helper (not inlined in ChatComposer.submit()) so the parsing
/// itself is unit-testable without the surrounding chat/session machinery.
/// Mirrors extension/src/sidepanel/chat-commands.ts's isBuiltinClearCommand —
/// same command set, same case/whitespace tolerance, both surfaces.
///
/// Scoped deliberately: only commands with a REAL llm-ide equivalent are
/// recognized here. Most of Claude Code's own command set (/login, /desktop,
/// /teleport, /keybindings, ...) has no llm-ide analogue at all, and showing
/// them as if they worked would be worse than not showing them — see the
/// llm_default_sources/commands/commands.json reference catalog for the
/// full Claude Code list instead (browsable, not wired to any action).
enum ChatSlashCommands {
    private static let clearCommands: Set<String> = ["/clear", "/reset", "/new"]

    /// Whether `text` (as typed, before any send) is a built-in "clear chat" command.
    static func isClearCommand(_ text: String) -> Bool {
        clearCommands.contains(text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    /// Commands that map onto an existing app section — real navigation via
    /// the same `.openSection`/`.openSettings` notifications AppShell already
    /// listens for (see NotificationNames.swift), not a fake/inert entry.
    /// `/loop` maps to llm-ide's own Loop Engine — the closest analogue to
    /// Claude Code's own "/loop: run a prompt on a recurring interval".
    private static let sectionCommands: [String: ShellState.Section] = [
        "/config": .settings, "/settings": .settings,
        "/loop": .loopEngine,
        "/mcp": .library,
        "/plugin": .library, "/plugins": .library,
        "/agents": .library,
    ]

    /// The app section `text` should navigate to, or nil if it isn't one of
    /// the recognized section commands.
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
