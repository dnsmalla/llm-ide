import Foundation

/// The drag payload for Explorer tree rows: newline-joined absolute paths,
/// carried as a plain `String`.
///
/// `String` rather than `URL` or a custom `UTType`: it is the drag idiom this
/// codebase already uses (`Views/Issues/RepoKanbanPanel.swift`), it needs no
/// `Transferable` conformance of our own, and it lets ONE drag carry a whole
/// multi-selection — which `.draggable` cannot express any other way, since it
/// hands over one item per dragged row.
///
/// Lives under `Services/`, not `Views/Explorer/`, because `Package.swift`
/// excludes `Views/Explorer` wholesale from a build with `file_explorer`
/// deselected but excludes NO test file — a type under `Views/Explorer/` would
/// make `ExplorerDragPayloadTests` fail to compile in every lite build.
enum ExplorerDragPayload {
    /// Paths containing a newline are DROPPED, not encoded.
    ///
    /// Such a name is legal on macOS but cannot survive a newline-delimited
    /// payload; emitting it would decode into two paths and move an unrelated
    /// file — or, worse, a path that happens to exist. Losing a drag is
    /// recoverable (the user drags again, or uses cut/paste); moving the wrong
    /// file is not. The rejection is per-item rather than whole-payload so a
    /// 200-file drag is not defeated by one pathological name; the dropped
    /// item simply stays where it was, which is visible in the tree.
    ///
    /// The predicate is `\.isNewline`, matching `decode`'s separator exactly —
    /// a lone CR, U+2028 and U+2029 are newlines to Swift too, so filtering
    /// only "\n" would still let `decode` tear a path in half.
    static func encode(_ urls: [URL]) -> String {
        urls.map { ExplorerPaths.key($0) }
            .filter { !$0.contains(where: \.isNewline) }
            .joined(separator: "\n")
    }

    /// Split on `\.isNewline`, never on the literal "\n": Swift treats "\r\n"
    /// as ONE Character, so a literal split would weld a stray "\r" onto the
    /// preceding path. Whitespace is NOT trimmed — leading/trailing spaces are
    /// legal in macOS filenames — so only genuinely blank lines are dropped.
    static func decode(_ text: String) -> [URL] {
        text.split(whereSeparator: \.isNewline)
            .map(String.init)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { URL(fileURLWithPath: $0) }
    }
}
