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
    /// Each path is PERCENT-ENCODED before it is joined, so a newline can
    /// never appear in the payload at all.
    ///
    /// A newline is legal in a macOS filename, and an earlier version of this
    /// type dropped such a path rather than emit one that `decode` would tear
    /// into two wrong paths. That failed closed, but silently: in a multi-item
    /// drag one file just stayed put, and `encode` runs at drag START, where
    /// there is no error channel to explain it. Encoding removes the class
    /// instead of reporting it — nothing needs dropping, and the CRLF rule in
    /// `decode` still holds for good measure.
    ///
    /// `.alphanumerics` is deliberately the narrowest useful allow-set: it
    /// escapes `%` itself (to `%25`), so the escape character round-trips like
    /// any other, and it escapes every newline, separator and control
    /// character without needing to enumerate them. Unicode letters and
    /// digits ARE alphanumeric, so Japanese names pass through legibly rather
    /// than becoming a wall of `%E8%A8%AD`.
    static func encode(_ urls: [URL]) -> String {
        urls.map { ExplorerPaths.key($0).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }

    /// Split on `\.isNewline`, never on the literal "\n": Swift treats "\r\n"
    /// as ONE Character, so a literal split would weld a stray "\r" onto the
    /// preceding path.
    ///
    /// `removingPercentEncoding` answers nil on a malformed escape, and
    /// `compactMap` drops those — a payload this type did not write (a plain
    /// text drag from another app) either decodes cleanly or is ignored, never
    /// half-decoded into a path that points somewhere unintended.
    ///
    /// Whitespace is NOT trimmed off a decoded path — leading and trailing
    /// spaces are legal in macOS filenames — so only genuinely blank lines are
    /// dropped.
    static func decode(_ text: String) -> [URL] {
        text.split(whereSeparator: \.isNewline)
            .compactMap { String($0).removingPercentEncoding }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { URL(fileURLWithPath: $0) }
    }
}
