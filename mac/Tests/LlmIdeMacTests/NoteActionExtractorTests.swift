import Testing
@testable import LlmIdeMac
import Foundation

final class NoteActionExtractorTests {

    let tempRoot: URL

    init() throws {
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("nae-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: tempRoot) }

    // MARK: - Helpers

    private func write(filename: String, id: String, title: String, body: String) throws -> URL {
        let url = tempRoot.appendingPathComponent(filename)
        let content = """
        ---
        id: \(id)
        title: "\(title)"
        started_at: "2026-05-15T10:00:00Z"
        ---
        \(body)
        """
        try content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func makeRow(id: String, title: String, filename: String) -> MeetingIndex.Row {
        MeetingIndex.Row(
            id: id, path: filename, title: title,
            startedAt: 1747296000000, endedAt: nil, durationSec: nil,
            gist: nil, tldrJSON: nil,
            actionsCount: 0, decisionsCount: 0, blockersCount: 0,
            fileMtime: 0, fileSize: 0,
            indexedAt: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    @Test func extractsActionsFromMeeting() throws {
        let body = """
        ## Actions
        - Fix login bug
        - Add unit tests
        ## Decisions
        - Use PostgreSQL
        """
        try write(filename: "meeting1.md", id: "AAA", title: "Sprint 1", body: body)
        let rows = [makeRow(id: "AAA", title: "Sprint 1", filename: "meeting1.md")]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.count == 2)
        #expect(actions.map(\.text).contains("Fix login bug"))
        #expect(actions.map(\.text).contains("Add unit tests"))
        #expect(actions.allSatisfy { $0.meetingId == "AAA" })
        #expect(actions.allSatisfy { $0.meetingTitle == "Sprint 1" })
    }

    @Test func skipsEmptyActionsSection() throws {
        let body = "## Actions\n\n## Decisions\n- Use Redis\n"
        try write(filename: "meeting2.md", id: "BBB", title: "Empty", body: body)
        let rows = [makeRow(id: "BBB", title: "Empty", filename: "meeting2.md")]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.isEmpty)
    }

    @Test func skipsNoteWithNoActionsSection() throws {
        let body = "## Decisions\n- Use Redis\n"
        try write(filename: "meeting3.md", id: "CCC", title: "NoActions", body: body)
        let rows = [makeRow(id: "CCC", title: "NoActions", filename: "meeting3.md")]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.isEmpty)
    }

    @Test func actionIdIsStableAcrossRuns() throws {
        let body = "## Actions\n- Stable task\n"
        try write(filename: "meeting4.md", id: "DDD", title: "M", body: body)
        let rows = [makeRow(id: "DDD", title: "M", filename: "meeting4.md")]
        let first  = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        let second = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(first[0].id == second[0].id)
    }

    @Test func stripsCheckboxPrefixFromActions() throws {
        let body = "## Actions\n- [ ] Fix login bug\n- [x] Add unit tests\n"
        try write(filename: "meeting_cb.md", id: "FFF", title: "Sprint 2", body: body)
        let rows = [makeRow(id: "FFF", title: "Sprint 2", filename: "meeting_cb.md")]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.count == 2)
        #expect(actions.map(\.text).contains("Fix login bug"))
        #expect(actions.map(\.text).contains("Add unit tests"))
    }

    @Test func combinesActionsFromMultipleMeetings() throws {
        try write(filename: "m1.md", id: "E1", title: "M1", body: "## Actions\n- Task A\n")
        try write(filename: "m2.md", id: "E2", title: "M2", body: "## Actions\n- Task B\n")
        let rows = [
            makeRow(id: "E1", title: "M1", filename: "m1.md"),
            makeRow(id: "E2", title: "M2", filename: "m2.md"),
        ]
        let actions = NoteActionExtractor.extract(from: rows, notesRoot: tempRoot)
        #expect(actions.count == 2)
        #expect(Set(actions.map(\.text)) == Set(["Task A", "Task B"]))
    }
}
