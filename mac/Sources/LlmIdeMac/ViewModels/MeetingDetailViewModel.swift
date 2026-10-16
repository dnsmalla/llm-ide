import Foundation
import Observation

@MainActor
@Observable
final class MeetingDetailViewModel {
    enum LoadState: Equatable { case idle, loading, loaded, error(String) }
    /// The meeting file this view model shows.  The detail view compares it
    /// to decide between refreshing this instance and building a new one.
    let fileURL: URL
    private let api: LlmIdeAPIClient?
    private let summaries: MeetingSummarizeTracker
    /// Bumped by every `load()`; a load whose read finishes after a newer
    /// load started must not overwrite the newer result.
    private var loadGeneration = 0

    var state: LoadState = .idle
    var frontmatter: MeetingFrontmatter?
    var summarySectionMarkdown: String?
    var transcript: String?
    /// Derived from the shared tracker, not stored here, so a re-created
    /// view model for the same file still shows the banner and keeps ⌘R
    /// disabled while an earlier instance's run is in flight.
    var summarizing: Bool { summaries.isSummarizing(fileURL) }

    init(fileURL: URL, api: LlmIdeAPIClient?,
         summaries: MeetingSummarizeTracker = .shared) {
        self.fileURL = fileURL; self.api = api
        self.summaries = summaries
    }

    func load() async throws {
        loadGeneration += 1
        let generation = loadGeneration
        // A refresh of already-shown content keeps it on screen instead of
        // flashing the loading shimmer.
        if frontmatter == nil { state = .loading }
        do {
            let url = fileURL
            let contents = try await Task.detached(priority: .userInitiated) {
                try String(contentsOf: url, encoding: .utf8)
            }.value
            guard generation == loadGeneration else { return }
            guard let split = FrontmatterCoder.split(file: contents) else {
                state = .error("Missing frontmatter")
                return
            }
            frontmatter = try FrontmatterCoder.decode(split.yaml)
            let body = String(contents[split.bodyStart...])
            if let t = body.range(of: "## Transcript") {
                summarySectionMarkdown = String(body[..<t.lowerBound])
                transcript = String(body[t.lowerBound...])
            } else {
                summarySectionMarkdown = body
                transcript = nil
            }
            state = .loaded
        } catch {
            guard generation == loadGeneration else { return }
            state = .error(error.localizedDescription)
            throw error
        }
    }

    func resummarize() async {
        guard let api = api, let fm = frontmatter, let transcript = transcript else { return }
        // Two runs on one file would race writing the same summary.
        guard summaries.begin(fileURL) else { return }
        defer { summaries.end(fileURL) }

        let root = NotesFolderConfig().currentFolder
        let projectRoot = root.deletingLastPathComponent()

        let rawFileName = fileURL.lastPathComponent
        let monthPath = AppDateFormatter.yearMonthPath(fm.startedAt)
        let rawFile = "meetings/\(monthPath)/\(rawFileName)"

        await MeetingSummarizationService.run(
            api: api,
            transcript: transcript,
            title: fm.title,
            language: fm.language,
            startedAt: fm.startedAt,
            durationSeconds: fm.durationSeconds,
            participants: fm.participants,
            transcriptFileURL: fileURL,
            projectRoot: projectRoot,
            rawFile: rawFile,
            root: root,
            forceRegenerate: true)

        try? await load()
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }
}

/// Which meeting files have a summarize run in flight, app-wide.  Lives
/// outside `MeetingDetailViewModel` because the detail view may replace its
/// view model mid-run (selection change and back, index refresh); the run's
/// state must outlive the instance that started it.
@MainActor
@Observable
final class MeetingSummarizeTracker {
    static let shared = MeetingSummarizeTracker()

    private(set) var inFlight: Set<URL> = []

    init() {}

    func isSummarizing(_ url: URL) -> Bool {
        inFlight.contains(url.standardizedFileURL)
    }

    /// Marks `url` as summarizing.  Returns false (and changes nothing)
    /// when a run for it is already in flight.
    func begin(_ url: URL) -> Bool {
        inFlight.insert(url.standardizedFileURL).inserted
    }

    func end(_ url: URL) {
        inFlight.remove(url.standardizedFileURL)
    }
}
