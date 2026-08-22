import Testing
import Foundation
@testable import LlmIdeMacLib

/// Pins the SOURCES-section classification: the owning raw directory under
/// `source/` is authoritative, frontmatter is the fallback. The regression:
/// classification read only `.md` frontmatter and defaulted everything else
/// to Meetings — raw fetched mail is `.txt` with no frontmatter, so all of
/// `source/emails/` landed in the "Meetings" sub-group while "Mail" sat
/// empty.
@MainActor
struct LibraryItemStoreSourceScanTests {

    private func makeProject() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("llmide-sourcescan-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("source/emails/2026/08"),
            withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("source/meetings/2026/08"),
            withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("source/documents"),
            withIntermediateDirectories: true)
        return root
    }

    private func scanItem(named name: String, in root: URL) -> LibraryItem? {
        LibraryItemStore.performScan(root: root, externalFolders: [])
            .first { $0.name == name }
    }

    @Test("a raw .txt email under source/emails/ classifies as mail, not meetings")
    func rawTxtEmailIsMail() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("raw mail body".utf8).write(
            to: root.appendingPathComponent("source/emails/2026/08/2026-08-22-mail.txt"))

        let item = try #require(scanItem(named: "2026-08-22-mail.txt", in: root))
        #expect(item.sourceId == EmailSource().id)
        // Sub-group-relative tree: the "emails" level IS the Mail sub-group
        // header, so the tree starts at the year.
        #expect(item.treePath == ["2026", "08"])
    }

    @Test("a transcript under source/meetings/ classifies as meeting")
    func meetingTranscriptIsMeeting() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("---\nplatform: \"meet\"\n---\nhi".utf8).write(
            to: root.appendingPathComponent("source/meetings/2026/08/standup.md"))

        let item = try #require(scanItem(named: "standup.md", in: root))
        #expect(item.sourceId == MeetingSource().id)
        #expect(item.treePath == ["2026", "08"])
    }

    @Test("explicit frontmatter beats the directory — source/meetings/ is shared, and only `platform: slack` separates a Slack transcript from a captured meeting")
    func frontmatterBeatsDirectory() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("---\nplatform: \"slack\"\n---\nhi".utf8).write(
            to: root.appendingPathComponent("source/meetings/2026/08/slack-thread.md"))

        let item = try #require(scanItem(named: "slack-thread.md", in: root))
        #expect(item.sourceId == SlackSource().id)
    }

    @Test("an unrecognized frontmatter platform doesn't collapse to the meeting default when the directory owns the file")
    func unknownPlatformFallsThroughToDirectory() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("---\nplatform: \"weirdo\"\n---\nhi".utf8).write(
            to: root.appendingPathComponent("source/emails/2026/08/odd.md"))

        let item = try #require(scanItem(named: "odd.md", in: root))
        #expect(item.sourceId == EmailSource().id)
    }

    @Test("a loose file directly in source/ falls back to frontmatter classification")
    func looseFileFallsBackToFrontmatter() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("---\nsource: \"email\"\n---\nhi".utf8).write(
            to: root.appendingPathComponent("source/loose.md"))

        let item = try #require(scanItem(named: "loose.md", in: root))
        #expect(item.sourceId == EmailSource().id)
    }

    @Test("a file in an unowned directory (source/documents/) keeps the historical meeting default")
    func unownedDirectoryFallsBack() throws {
        let root = try makeProject()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("plain".utf8).write(
            to: root.appendingPathComponent("source/documents/spec.txt"))

        let item = try #require(scanItem(named: "spec.txt", in: root))
        #expect(item.sourceId == MeetingSource().id)
        // Unowned dir: nothing to fold into a sub-group header, so the full
        // path stays visible in the tree.
        #expect(item.treePath == ["documents"])
    }
}
