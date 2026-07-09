import Foundation

/// Generic driver for fetch-based input sources. Builds the `SourceContext` and
/// drives the registry's fetch sources (email today; Slack later), owning the
/// one-time Library re-index + refresh after ingest. Per-source fetch/ingest
/// logic lives in the `InputSource` implementations (e.g. `EmailSource`).
///
/// `@MainActor` because it touches `AppConfig` and posts the Library-refresh
/// notification; the heavy file + summarize work is awaited but off-main inside
/// the sources.
@MainActor
struct SourceIngestService {
    let api: LlmIdeAPIClient
    let config: AppConfig
    /// Notes-folder root for `MeetingFileStore`.
    let root: URL
    /// `<project>/notes/` — where the AI `.docx` note is written.
    let notesOutputFolder: URL
    /// Forces the Library SQLite index to pick up new files immediately
    /// rather than waiting for the kqueue watcher tick.
    let indexer: FolderIndexer

    private var context: SourceContext {
        SourceContext(api: api, config: config, root: root, notesOutputFolder: notesOutputFolder)
    }

    /// Fetch + ingest a single source by id (used by the Sources card, which
    /// shows that source's specific outcome). Rescans only when the source
    /// actually did work — `.none`/`.noSource` skip it, matching the original
    /// behavior (no spurious full re-index + refresh when nothing was imported).
    func importSource(id: String) async -> SourceIngestResult {
        guard let source = SourceRegistry.source(id: id) else { return .noSource }
        let result = await source.fetchAndIngest(context)
        if Self.needsRescan(result) { await rescanAndNotify() }
        return result
    }

    /// Back-compat entry point for the email Sources card.
    func importNewEmails() async -> SourceIngestResult {
        await importSource(id: "email")
    }

    /// Whether a result warrants a Library re-index: only when content may have
    /// landed (`.imported`) or a partial import failed mid-batch (`.failure`).
    /// `.none` (no new items) and `.noSource` change nothing on disk.
    private static func needsRescan(_ result: SourceIngestResult) -> Bool {
        switch result {
        case .imported: return true
        case .failure(_, let imported): return imported > 0  // rescan only if notes landed
        case .none, .noSource: return false
        }
    }

    /// One full re-index after ingest + the Library refresh, off-main.
    private func rescanAndNotify() async {
        let indexer = self.indexer
        await Task.detached(priority: .background) { try? indexer.fullScan() }.value
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }
}
