import Foundation
import Testing
@testable import LlmIdeMacLib

@Suite("NoteWriter dedup")
struct NoteWriterDedupTests {

    @Test("meeting writer skips duplicate rawFile")
    func meetingDedup() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("meeting-dedup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let writer = MeetingNoteWriter(repoRoot: root)
        let rawFile = "meetings/2026/08/standup.md"
        let started = Date(timeIntervalSince1970: 1_700_000_000)

        #expect(await writer.hasNote(forRawFile: rawFile) == false)

        _ = try await writer.writeMarkdownNote(
            markdown: "# Standup\n\n## Summary\n\nDone.",
            title: "Standup",
            startedAt: started,
            participants: ["Aki"],
            rawFile: rawFile)

        #expect(await writer.hasNote(forRawFile: rawFile))
        let rawFiles = try await writer.existingRawFiles()
        #expect(rawFiles.contains(rawFile))
    }

    @Test("email writer skips duplicate sourceHash")
    func emailDedup() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("email-dedup-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let writer = EmailNoteWriter(repoRoot: root)
        let hash = "deadbeef"
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let classification = LlmIdeAPIClient.EmailClassification(
            category: "work", noteWorthy: true, summary: "Review PR", todos: [])

        #expect(await writer.hasNote(forSourceHash: hash) == false)

        let first = try await writer.writeNote(
            from: "aki@example.com",
            date: date,
            subject: "PR",
            classification: classification,
            originalBody: "Please review",
            sourceHash: hash,
            rawFile: "emails/2026/08/raw.txt")

        let second = try await writer.writeNote(
            from: "aki@example.com",
            date: date,
            subject: "PR",
            classification: classification,
            originalBody: "Please review",
            sourceHash: hash,
            rawFile: "emails/2026/08/raw.txt")

        #expect(first == second)
        #expect(await writer.hasNote(forSourceHash: hash))
        let notes = try await NoteService(repoRoot: root).queryNotes(NoteFilter(type: .email))
        #expect(notes.count == 1)
    }

    @Test("frontmatter scan finds keys when index is empty")
    func frontmatterFallback() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("dedup-scan-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let noteDir = NoteService(repoRoot: root).getMonthDir(type: .email, date: Date(timeIntervalSince1970: 1_700_000_000))
        try FileManager.default.createDirectory(at: noteDir, withIntermediateDirectories: true)
        let md = """
        ---
        source: email
        sourceHash: "abc123"
        rawFile: "emails/2026/08/raw.txt"
        ---

        # Email

        Summary only.
        """
        try md.write(to: noteDir.appendingPathComponent("note.md"), atomically: true, encoding: .utf8)

        let hashes = await IngestNoteDedup.sourceHashes(repoRoot: root, type: .email)
        #expect(hashes.contains("abc123"))
    }
}
