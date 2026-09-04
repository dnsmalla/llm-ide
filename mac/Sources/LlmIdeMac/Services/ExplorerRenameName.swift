import Foundation

/// What an inline-rename edit MEANS, decided before any filesystem call.
///
/// Lives under `Services/`, not `Views/Explorer/`, for the same reason
/// `ExplorerKeyCommand` does: `Package.swift` excludes `Views/Explorer`
/// wholesale from a build with `file_explorer` deselected but excludes NO test
/// file, so a rule living in the view could not be pinned by a test at all.
enum ExplorerRenameName {
    enum Outcome: Equatable {
        /// Nothing to do — close the editor without touching the disk. Covers
        /// an empty/whitespace-only name and a name that didn't change.
        case cancel
        /// Apply this trimmed name.
        case apply(String)
        /// Refuse. The caller keeps the editor open with the user's text so a
        /// bad name can be corrected rather than retyped.
        case reject(ExplorerFileError)
    }

    /// Resolve `raw` (what the user typed) against `current` (the name the row
    /// carries now).
    ///
    /// The ONE validity rule applied here is the newline one, because it is the
    /// one `ExplorerFileOps.validate` does not cover: that function trims
    /// leading and trailing whitespace-and-newlines, so an INTERIOR newline
    /// ("a⏎b.txt" — reachable by pasting a wrapped line into the field) sails
    /// through to `moveItem` and produces a filename that tears in two
    /// everywhere this project treats one line as one record;
    /// `ExplorerDragPayload.encode` already drops such a path rather than emit
    /// something `decode` would split. Everything else ("/", ".", "..",
    /// already-exists) stays owned by `ExplorerFileOps` — one definition of a
    /// valid name, checked at the point that acts on it — and surfaces through
    /// the same `.reject` path when it throws.
    ///
    /// Tested against `\.isNewline` rather than `contains("\n")`: Swift treats
    /// "\r\n" as ONE Character, so a literal check misses CRLF, and it misses
    /// a lone CR and U+2028 outright.
    static func resolve(_ raw: String, current: String) -> Outcome {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != current else { return .cancel }
        guard !trimmed.contains(where: \.isNewline) else { return .reject(.invalidName) }
        return .apply(trimmed)
    }
}
