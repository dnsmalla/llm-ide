import Foundation
import os.log

private let sumLog = Logger(subsystem: "com.llmide.macapp", category: "Summarization")

/// Shared summarization pipeline used by AppShell, CaptionScraper, and
/// MeetingDetailViewModel.
///
/// Produces **two** llm-doc outputs per meeting:
///   1. `.docx` via bundled `note_template.docx` + Python (existing polished note)
///   2. `.md`  via `<project>/templates/meeting-note/template.md` (editable layout)
enum MeetingSummarizationService {

    /// Run summarisation, then write both the `.docx` and template-based `.md` notes.
    @discardableResult
    static func run(
        api: LlmIdeAPIClient,
        transcript: String,
        title: String,
        language: String,
        startedAt: Date,
        durationSeconds: Int?,
        participants: [String],
        transcriptFileURL: URL,
        projectRoot: URL,
        rawFile: String,
        root: URL
    ) async -> MeetingSummary {

        let summary: MeetingSummary
        do {
            let s = try await api.summarize(
                transcript: transcript,
                title: title,
                language: language,
                startedAt: startedAt,
                durationSeconds: durationSeconds,
                participants: participants)
            do {
                try MeetingFileStore(root: root).writeSummary(into: transcriptFileURL, summary: s)
            } catch {
                sumLog.error("writeSummary failed: \(error.localizedDescription, privacy: .public)")
            }
            summary = s
        } catch {
            sumLog.error("summarize failed — using fallback: \(error.localizedDescription, privacy: .public)")
            let fallback = MeetingSummary(
                gist: title,
                tldr: [],
                full: transcript,
                actions: [],
                decisions: [],
                blockers: [],
                model: "unavailable",
                generatedAt: Date())
            try? MeetingFileStore(root: root).writeSummary(into: transcriptFileURL, summary: fallback)
            summary = fallback
        }

        let writer = MeetingNoteWriter(repoRoot: projectRoot)

        // ── Step 2a: polished .docx (existing pipeline) ──
        let tempDocx = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-meeting-\(UUID().uuidString).docx")
        MeetingNoteGenerator.generateDocx(
            summary: summary,
            title: title,
            startedAt: startedAt,
            participants: participants,
            outputURL: tempDocx)
        if let docxData = try? Data(contentsOf: tempDocx) {
            do {
                _ = try await writer.writeDocxNote(
                    docxContent: docxData,
                    title: title,
                    startedAt: startedAt,
                    participants: participants,
                    rawFile: rawFile)
                try? FileManager.default.removeItem(at: tempDocx)
            } catch {
                // Keep the temp .docx on failure — it is the only copy of the
                // polished note (the .md below is a separate layout).
                sumLog.error("writeDocxNote failed, keeping \(tempDocx.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }

        // ── Step 2b: template .md (project templates/meeting-note/) ──
        let markdown = IngestTemplateRenderer.renderMeetingNote(
            projectRoot: projectRoot,
            summary: summary,
            title: title,
            startedAt: startedAt,
            durationSeconds: durationSeconds,
            participants: participants,
            transcript: transcript,
            rawFile: rawFile)
        do {
            _ = try await writer.writeMarkdownNote(
                markdown: markdown,
                title: title,
                startedAt: startedAt,
                participants: participants,
                rawFile: rawFile)
        } catch {
            sumLog.error("writeMarkdownNote failed: \(error.localizedDescription, privacy: .public)")
        }

        return summary
    }
}
