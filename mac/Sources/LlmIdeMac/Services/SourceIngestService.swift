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
    /// shows that source's specific outcome). Runs one rescan/notify after.
    func importSource(id: String) async -> SourceIngestResult {
        guard let source = SourceRegistry.source(id: id) else { return .noSource }
        let result = await source.fetchAndIngest(context)
        await rescanAndNotify()
        return result
    }

    /// Back-compat entry point for the email Sources card.
    func importNewEmails() async -> SourceIngestResult {
        await importSource(id: "email")
    }

    /// Fetch + ingest every fetch source, then one rescan/notify. Returns the
    /// per-source outcomes keyed by source id. (Forward-looking: today only
    /// email is a fetch source; a new fetch source is picked up automatically.)
    func importAll() async -> [String: SourceIngestResult] {
        var results: [String: SourceIngestResult] = [:]
        for source in SourceRegistry.fetchSources {
            results[source.id] = await source.fetchAndIngest(context)
        }
        await rescanAndNotify()
        return results
    }

    /// One full re-index after ingest + the Library refresh, off-main.
    private func rescanAndNotify() async {
        let indexer = self.indexer
        await Task.detached(priority: .background) { try? indexer.fullScan() }.value
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }
}
