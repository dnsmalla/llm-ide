import Foundation

/// How a source produces content. `liveCapture` sources (meetings) are
/// event-driven and have no fetch; `fetch` sources (email, later Slack) pull
/// new items on demand. One protocol covers both — live-capture sources use
/// the default no-op `fetchAndIngest`.
enum SourceMode { case liveCapture, fetch }

/// Outcome of one source's `fetchAndIngest` run, surfaced on the Sources card.
/// (Relocated from `SourceIngestService.Result` so the protocol can use it.)
enum SourceIngestResult {
    case imported(Int, moreAvailable: Int, oversize: Int) // N notes; more left; large skipped
    case none                          // fetched, but nothing new
    case noSource                      // no configured/enabled source
    /// Fetch or ingest error. `imported` = notes that DID land before the
    /// failure (0 for a fetch error that wrote nothing). The driver rescans
    /// only when `imported > 0`, matching the original behavior.
    case failure(String, imported: Int)
}

/// Runtime dependencies a fetch source needs to ingest. Bundled so sources stay
/// stateless (`SourceRegistry.all` is a static list) while the driver injects
/// the live objects.
@MainActor
struct SourceContext {
    let api: LlmIdeAPIClient
    let config: AppConfig
    /// Notes-folder root for `MeetingFileStore`.
    let root: URL
    /// `<project>/notes/` — where the AI `.docx` note is written.
    let notesOutputFolder: URL
}

/// A unified input source. Metadata classifies files and drives the Library
/// SOURCES UI; `fetchAndIngest` pulls new content (fetch sources only — live
/// capture sources inherit the no-op default and are driven by their own
/// engine, e.g. `AutoCaptureService`).
protocol InputSource {
    /// Stable id, e.g. "meeting", "email". Stored on `LibraryItem.sourceId`.
    var id: String { get }
    /// Library SOURCES sub-group label.
    var displayName: String { get }
    /// SF Symbol for the sub-group + cards.
    var icon: String { get }
    /// Muted text shown when the sub-group has no files.
    var emptyText: String { get }
    /// Frontmatter `platform` values (lowercased) that classify a file to this
    /// source. e.g. email → ["email"]; meeting → ["meet","teams","zoom","mic"].
    var platforms: [String] { get }
    var mode: SourceMode { get }
    /// Pull new content and write it into the project. Returns the outcome.
    /// Default no-op for `.liveCapture` sources.
    @MainActor func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult
}

extension InputSource {
    @MainActor func fetchAndIngest(_ ctx: SourceContext) async -> SourceIngestResult { .none }
}
