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
    var summarySectionMarkdown: String?     // body between frontmatter and Transcript
    var transcript: String?                 // Transcript heading + lines
    var summarizing = false

    init(fileURL: URL, api: LlmIdeAPIClient?) {
        self.fileURL = fileURL; self.api = api
    }

    func load() async throws {
        state = .loading
        do {
            // Read off the main actor — a synchronous String(contentsOf:) on
            // a large notes file would otherwise stall the UI. Parsing resumes
            // on the main actor (where the @Observable properties live).
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
        // root is the project's source/ folder; its parent is the project
        // root, so notes land in the canonical <projectRoot>/llm-doc/.
        let projectRoot = root.deletingLastPathComponent()
        let writer = MeetingNoteWriter(repoRoot: projectRoot)

        // Use the .md filename stem as the docx suffix — stable across re-runs.
        let dateSlug = AppDateFormatter.dateHourMinuteLocal(fm.startedAt)
        let stem     = fileURL.deletingPathExtension().lastPathComponent.prefix(8)
        let filename = "\(dateSlug)-\(stem)-meeting-notes.docx"
        // Nested llm-doc/meetings/YYYY/MM/ (matches AppShell's resummarizeMeetingFile
        // and generateNoteForLiveSession) — this used to be ProjectLayout(...).notesDir
        // directly, which has no `meetings/YYYY/MM/` nesting at all, so the .docx
        // landed flat in llm-doc/ instead of llm-doc/meetings/YYYY/MM/.
        let docxURL = writer.outputDirectory(for: fm.startedAt).appendingPathComponent(filename)

        await MeetingSummarizationService.run(
            api: api,
            transcript: transcript,
            title: fm.title,
            language: fm.language,
            startedAt: fm.startedAt,
            durationSeconds: fm.durationSeconds,
            participants: fm.participants,
            transcriptFileURL: fileURL,
            docxOutputURL: docxURL,
            root: root)

        // Re-save via MeetingNoteWriter for unified storage + note-index
        // registration — previously this function stopped after the raw
        // .docx write above and never called writeNote(), so the file was
        // both mis-nested AND missing from llm-doc/index.json.
        let rawFileName = fileURL.lastPathComponent
        let monthPath = AppDateFormatter.yearMonthPath(fm.startedAt)
        let rawFile = "meetings/\(monthPath)/\(rawFileName)"
        if let docxData = try? Data(contentsOf: docxURL) {
            do {
                _ = try await writer.writeNote(
                    docxContent: docxData,
                    title: fm.title,
                    startedAt: fm.startedAt,
                    participants: fm.participants,
                    rawFile: rawFile
                )
                try? FileManager.default.removeItem(at: docxURL)
            } catch {
                // Leave the temp .docx in place on failure — deleting it
                // here would lose the only copy of the note.
            }
        }

        try? await load()
        NotificationCenter.default.post(name: .meetingIndexChanged, object: nil)
    }
}
