import Foundation
import os.log

private let sumLog = Logger(subsystem: "com.llmide.macapp", category: "Summarization")

/// Shared summarization pipeline used by AppShell, CaptionScraper, and
/// MeetingDetailViewModel.
///
/// Each call site used to inline the same four-step pattern:
///   1. `api.summarize` (no wall-clock deadline — see Step 1 below)
///   2. `writeSummary(into:)` on success
///   3. Fallback `MeetingSummary` + `writeSummary` on failure
///   4. `MeetingNoteGenerator.generateDocx(...)` to produce the polished note
///
/// Extracting it here means a single change propagates to all consumers
/// and the individual call sites stay readable.
enum MeetingSummarizationService {

    /// Run the summarisation pipeline for a single meeting.
    ///
    /// - Parameters:
    ///   - api: Authenticated API client.
    ///   - transcript: Raw transcript text to send to the model.
    ///   - title: Meeting title; also used as the fallback `gist` when the API fails.
    ///   - language: Transcript language code (empty string → infer from content).
    ///   - startedAt: Meeting start time — written into the .docx header.
    ///   - durationSeconds: Optional meeting duration in seconds.
    ///   - participants: Participant list written into the .docx header.
    ///   - transcriptFileURL: The `.md` file whose frontmatter will receive the summary.
    ///   - docxOutputURL: Where to write the generated `.docx`. Pass `nil` to skip
    ///     `.docx` generation (e.g. when the notes folder is unknown).
    ///   - root: `MeetingFileStore` root used for `writeSummary`.
    /// - Returns: The produced `MeetingSummary` — may be a minimal fallback
    ///   if the API call fails or times out.
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
        docxOutputURL: URL?,
        root: URL
    ) async -> MeetingSummary {

        // ── Step 1: AI summary, with no wall-clock deadline ──
        // This used to race `api.summarize` against a 5-minute `Task.sleep` and
        // throw when the sleep won. Summarising a long meeting transcript is
        // exactly the case that loses that race: the user recorded a two-hour
        // call, waited five minutes, and got the fallback summary instead of the
        // real one. The client session no longer imposes a clock either (see
        // LlmIdeAPIClient), so the request now runs until the server answers or
        // the surrounding Task is cancelled — and the `catch` below still lands on
        // the local fallback if it genuinely fails.
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
            // Summarisation failed or timed out — build a minimal fallback so:
            //   • The Library row clears "Summarising…" (gist = title)
            //   • The .docx is still produced with the raw transcript
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

        // ── Step 2: Generate the polished .docx note ──
        guard let docxOutputURL else { return summary }
        try? FileManager.default.createDirectory(
            at: docxOutputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        MeetingNoteGenerator.generateDocx(
            summary: summary,
            title: title,
            startedAt: startedAt,
            participants: participants,
            outputURL: docxOutputURL)

        return summary
    }
}
