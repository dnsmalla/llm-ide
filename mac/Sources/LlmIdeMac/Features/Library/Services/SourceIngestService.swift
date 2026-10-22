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
    /// `<project>/llm-doc/` — where the AI `.docx` note is written.
    let notesOutputFolder: URL
    /// Forces the Library SQLite index to pick up new files immediately
    /// rather than waiting for the kqueue watcher tick.
    let indexer: FolderIndexer

    private var context: SourceContext {
        SourceContext(api: api, config: config, root: root, notesOutputFolder: notesOutputFolder,
                      sourceConnectorRoot: config.sourceConnectorRootOverride)
    }

    /// Fetch + ingest a single source by id (used by the Sources card, which
    /// shows that source's specific outcome). Rescans only when the source
    /// actually did work — `.none`/`.noSource` skip it, matching the original
    /// behavior (no spurious full re-index + refresh when nothing was imported).
    func importSource(id: String) async -> SourceIngestResult {
        guard let source = SourceRegistry.source(id: id) else { return .noSource }
        // Settings "Import now" and the AutoTask scheduler each build their own
        // service, so the guard lives in a shared registry, not on `self`. Two
        // overlapping runs of one source both fetch the same not-yet-marked
        // items and write duplicate notes (Slack's createPartial then mints
        // `-untitled-2`). The second caller gets a failure it can show rather
        // than a silent `.none` that would read as "nothing new".
        guard SourceIngestInFlight.begin(id) else {
            return .failure(SourceIngestInFlight.alreadyRunningMessage, imported: 0)
        }
        defer { SourceIngestInFlight.end(id) }
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

/// Per-source in-flight set shared by every `SourceIngestService` instance.
/// `@MainActor` like the service, so check-and-insert is atomic without a lock:
/// nothing can interleave between `contains` and `insert` on one actor.
@MainActor
enum SourceIngestInFlight {
    static let alreadyRunningMessage = "An import for this source is already running."
    private static var running: Set<String> = []

    /// Claims `id`; false when another run already holds it.
    static func begin(_ id: String) -> Bool {
        running.insert(id).inserted
    }

    static func end(_ id: String) {
        running.remove(id)
    }

    static func isRunning(_ id: String) -> Bool {
        running.contains(id)
    }
}

/// Library's side of the Core `SourceIngesting` seam: AutoTask's Source Update
/// task drives ingestion through this so it never names `SourceIngestService`
/// or `SourceRegistry` (and, through them, the connectors). Installed by
/// Shell (`FeatureCatalog.bootAutoTask`).
///
/// Builds a fresh `SourceIngestService` per call because the service is bound
/// to one project's notes folder + indexer, which come from the environment
/// the scheduler passes in at run time — the active project can change
/// between runs. The service is a stateless struct, so this costs nothing.
@MainActor
struct LibrarySourceIngester: SourceIngesting {
    let api: LlmIdeAPIClient
    let config: AppConfig

    var fetchSources: [SourceIngestTarget] {
        SourceRegistry.fetchSources.map { SourceIngestTarget(id: $0.id, displayName: $0.displayName) }
    }

    func importSource(id: String, into environment: AppEnvironment) async -> SourceIngestResult {
        let service = SourceIngestService(
            api: api,
            config: config,
            root: environment.notesConfig.currentFolder,
            notesOutputFolder: environment.notesOutputFolder,
            indexer: environment.indexer)
        return await service.importSource(id: id)
    }
}
