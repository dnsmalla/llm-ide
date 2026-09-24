import XCTest
@testable import LlmIdeMacLib

/// A failed summarize used to write the whole transcript as the summary AND
/// as the .docx/.md notes; that note then made `hasNote(forRawFile:)`
/// suppress every later auto-summary. The failure path must write nothing.
@MainActor
final class MeetingSummarizationFallbackTests: XCTestCase {

    func testFailedSummarizeWritesNoNoteAndLeavesTranscriptUntouched() async throws {
        let projectRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("sum-fallback-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: projectRoot) }
        let root = projectRoot.appendingPathComponent("source", isDirectory: true)

        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let store = MeetingFileStore(root: root)
        let handle = try store.createPartial(id: "fallback-session", startedAt: started,
                                             platform: "teams", language: "en")
        try handle.appendCaption(timestamp: started, speaker: "Aki", text: "hello")
        let url = try store.finalize(handle: handle, title: "Standup",
                                     endedAt: started.addingTimeInterval(60), participants: ["Aki"])
        let before = try String(contentsOf: url, encoding: .utf8)
        let rawFile = "meetings/\(AppDateFormatter.yearMonthPath(started))/\(url.lastPathComponent)"

        // No session store → summarize throws `noSession` with no network I/O.
        let api = LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456")
        let summary = await MeetingSummarizationService.run(
            api: api, transcript: "[Aki] hello", title: "Standup", language: "en",
            startedAt: started, durationSeconds: 60, participants: ["Aki"],
            transcriptFileURL: url, projectRoot: projectRoot, rawFile: rawFile, root: root)

        XCTAssertEqual(summary.model, "unavailable")
        let hasNote = await MeetingNoteWriter(repoRoot: projectRoot).hasNote(forRawFile: rawFile)
        XCTAssertFalse(hasNote, "no note, so the next auto-summary still runs")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), before,
                       "the transcript file gains no transcript-as-summary section")
    }
}
