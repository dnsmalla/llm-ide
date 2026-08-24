import Foundation
import Observation

@MainActor
@Observable
final class MeetingDetailViewModel {
    enum LoadState: Equatable { case idle, loading, loaded, error(String) }
    private let fileURL: URL
    private let api: LlmIdeAPIClient?

    var state: LoadState = .idle
    var frontmatter: MeetingFrontmatter?
    var summarySectionMarkdown: String?
    var transcript: String?
    var summarizing = false

    init(fileURL: URL, api: LlmIdeAPIClient?) {
        self.fileURL = fileURL; self.api = api
    }

    func load() async throws {
        state = .loading
        do {
            let url = fileURL
            let contents = try await Task.detached(priority: .userInitiated) {
                try String(contentsOf: url, encoding: .utf8)
            }.value
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
            state = .error(error.localizedDescription)
            throw error
        }
    }

    func resummarize() async {
        guard let api = api, let fm = frontmatter, let transcript = transcript else { return }
        summarizing = true
        defer { summarizing = false }

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
            root: root)

        try? await load()
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }
}
