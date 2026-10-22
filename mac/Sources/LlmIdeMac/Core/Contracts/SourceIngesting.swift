import Foundation

/// Outcome of one source's fetch + ingest run, surfaced on the Sources card
/// and in the Auto Task "Source Update" log.
///
/// Lives in Core (it used to sit in Library's `InputSource.swift`) because
/// AutoTask's scheduler switches on it through `SourceIngesting`. It is a pure
/// value type over `String`/`Int`, so moving it pulls nothing from Library
/// along with it.
enum SourceIngestResult {
    case imported(Int, moreAvailable: Int, oversize: Int) // N notes; more left; large skipped
    case none                          // fetched, but nothing new
    case noSource                      // no configured/enabled source
    /// Fetch or ingest error. `imported` = notes that DID land before the
    /// failure (0 for a fetch error that wrote nothing). The driver rescans
    /// only when `imported > 0`, matching the original behavior.
    case failure(String, imported: Int)
}

/// One fetch-mode source as the scheduler sees it: enough to drive an import
/// by id and to label log lines, nothing more.
struct SourceIngestTarget: Equatable {
    let id: String
    let displayName: String
}

/// What AutoTask's Source Update task needs from Library's ingestion, without
/// naming `SourceIngestService` / `SourceRegistry` — those drag in every
/// connector (Email, Slack, Box, MCP), which are Library's internals.
/// Library provides the conformance; Shell injects it into
/// `AutoCodeUpdateService`.
@MainActor
protocol SourceIngesting {
    /// The sources a scheduled ingestion run should poll, in run order.
    var fetchSources: [SourceIngestTarget] { get }
    /// Fetch + ingest one source into `environment`'s notes folder, re-indexing
    /// the Library when anything landed.
    func importSource(id: String, into environment: AppEnvironment) async -> SourceIngestResult
}
