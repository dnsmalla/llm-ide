import Foundation
import os.log

private let sumLog = Logger(subsystem: "com.llmide.macapp", category: "Summarization")

/// Shared summarization pipeline used by AppShell, CaptionScraper, and
/// MeetingDetailViewModel.
///
/// Lives in Core (the notes capability) rather than Library because Live's
/// capture pipeline and Library's meeting detail both run it, and features
/// may not name each other. Its whole closure (`MeetingFileStore`,
/// `MeetingNoteWriter`, `IngestNoteDedup`) is Core.
///
/// Produces one llm-doc output per meeting: a `.md` via
/// `<project>/templates/meeting-note/template.md` (editable layout).
enum MeetingSummarizationService {

    /// Run summarisation, then write the template-based `.md` note.
    /// Skips when an llm-doc note already exists for `rawFile`, unless `forceRegenerate`.
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
        root: URL,
        forceRegenerate: Bool = false
    ) async -> MeetingSummary {
        let writer = MeetingNoteWriter(repoRoot: projectRoot)
        if !forceRegenerate, await writer.hasNote(forRawFile: rawFile) {
            sumLog.info("Skipping meeting summarization — note already exists for \(rawFile, privacy: .public)")
            return MeetingSummary(
                gist: title,
                tldr: [],
                full: "",
                actions: [],
                decisions: [],
                blockers: [],
                model: "skipped-existing",
                generatedAt: Date())
        }

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
            // Write no NOTE on failure. This path used to store the whole
            // transcript as the "summary" (into the raw file and as the .md
            // note), and the note it left behind made `hasNote`
            // suppress every later summary — the meeting was stuck with a
            // transcript-as-summary. Nothing retries automatically, so the
            // failure is recorded in the raw file's frontmatter (body and
            // transcript untouched) where the Library row shows it, and
            // Re-summarize replaces it.
            sumLog.error("summarize failed — no note written: \(error.localizedDescription, privacy: .public)")
            do {
                try MeetingFileStore(root: root).markSummaryFailed(in: transcriptFileURL)
            } catch {
                sumLog.error("markSummaryFailed failed: \(error.localizedDescription, privacy: .public)")
            }
            return MeetingSummary(
                gist: title,
                tldr: [],
                full: transcript,
                actions: [],
                decisions: [],
                blockers: [],
                model: "unavailable",
                generatedAt: Date())
        }

        // ── Template .md (project templates/meeting-note/) ──
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
