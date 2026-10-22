import Foundation

/// Maps a note file's claims (a frontmatter `platform`/`source` value, or the
/// raw directory it sits in under `source/`) to an input-source id.
///
/// Why a protocol: `LibraryItemStore` lives in `Core/Notes` because every
/// feature reads it, but the list of input sources (`SourceRegistry`) lives in
/// the Library feature because building it pulls in the Email/Slack/MCP
/// connectors. Core may not name a feature type, so the store classifies
/// through this seam and the composition root (Shell) hands it the
/// Library-backed implementation.
///
/// Implementations must be pure and thread-safe: `LibraryItemStore` calls them
/// from a detached background scan.
protocol NoteSourceClassifying: Sendable {
    /// Id given to a file nothing else claims. Historically every unclaimed
    /// `source/` file was a captured meeting, so this is the meeting source id.
    var defaultSourceId: String { get }

    /// Id of the source that owns a frontmatter `platform`/`source` value.
    /// - Precondition: `platform` is already lowercased and trimmed.
    /// - Returns: nil when no registered source claims the value, so the
    ///   caller can fall through to directory-based classification instead of
    ///   collapsing to the default too early.
    func sourceId(forPlatform platform: String) -> String?

    /// Id of the source whose raw files live in `directory` (the first path
    /// component under `source/`, e.g. "emails").
    /// - Returns: nil for a directory no source owns (e.g. "documents").
    func sourceId(forRawDirectory directory: String) -> String?
}
