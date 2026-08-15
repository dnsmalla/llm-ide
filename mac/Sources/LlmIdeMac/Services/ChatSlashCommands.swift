import Foundation

/// Built-in chat slash commands — recognized as real UI actions the same way
/// Claude Code's own /clear works, NOT sent to the model as a prompt. Kept as
/// a small pure helper (not inlined in ChatComposer.submit()) so the parsing
/// itself is unit-testable without the surrounding chat/session machinery.
/// Mirrors extension/src/sidepanel/chat-commands.ts's isBuiltinClearCommand —
/// same command set, same case/whitespace tolerance, both surfaces.
enum ChatSlashCommands {
    private static let clearCommands: Set<String> = ["/clear", "/reset", "/new"]

    /// Whether `text` (as typed, before any send) is a built-in "clear chat" command.
    static func isClearCommand(_ text: String) -> Bool {
        clearCommands.contains(text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }
}
