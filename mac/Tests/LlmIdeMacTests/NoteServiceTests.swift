// Tests for unified note service (Swift)
// Tests the separation of raw data sources from generated notes

import XCTest
@testable import LlmIdeMac

final class NoteServiceTests: XCTestCase {

    var testRepo: URL!
    var service: NoteService!

    override func setUp() async throws {
        // Create temp directory
        let tempDir = FileManager.default.temporaryDirectory
        testRepo = tempDir.appendingPathComponent("note-service-test-\(UUID().uuidString)")

        try FileManager.default.createDirectory(at: testRepo, withIntermediateDirectories: true)

        service = NoteService(repoRoot: testRepo)
    }

    override func tearDown() async throws {
        // Cleanup
        try? FileManager.default.removeItem(at: testRepo)
    }

    func testDirectoryStructure() async throws {
        // Save a meeting note
        let content = Data("Test meeting".utf8)
        let metadata = NoteMetadata(
            id: "test-id",
            type: .meeting,
            source: "google-meet",
            title: "Test Meeting",
            date: "2026-07-08T09:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-08T09:05:00Z",
            tags: ["standup"],
            participants: ["Alice", "Bob"],
            fileSize: 0
        )

        _ = try await service.saveNote(
            type: .meeting,
            filename: "2026-07-08-090000-test-meeting.docx",
            content: content,
            metadata: metadata
        )

        // Verify meetings directory exists
        let meetingsDir = testRepo.appendingPathComponent("notes/meetings/2026/07")
        XCTAssertTrue(FileManager.default.fileExists(atPath: meetingsDir.path))
    }

    func testSaveMeetingNote() async throws {
        let content = Data("Meeting content".utf8)
        let metadata = NoteMetadata(
            id: "test-id",
            type: .meeting,
            source: "google-meet",
            title: "Test Meeting",
            date: "2026-07-08T09:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-08T09:05:00Z",
            tags: ["standup"],
            participants: ["Alice", "Bob"],
            fileSize: 0
        )

        let result = try await service.saveNote(
            type: .meeting,
            filename: "2026-07-08-090000-test-meeting.docx",
            content: content,
            metadata: metadata
        )

        XCTAssertEqual(result.type, .meeting)
        XCTAssertEqual(result.source, "google-meet")
        XCTAssertTrue(result.path.starts(with: "notes/meetings/"))
        XCTAssertTrue(result.tags.contains("standup"))
    }

    func testSaveEmailNote() async throws {
        let content = Data("# Email\\n\\nContent".utf8)
        let metadata = NoteMetadata(
            id: "test-id",
            type: .email,
            source: "email",
            title: "Test Email",
            date: "2026-07-08T10:00:00Z",
            path: "",
            rawFile: "EmailInbox/2026/07/raw-email.txt",
            sourceHash: "abc123",
            generatedAt: "2026-07-08T10:05:00Z",
            tags: ["action-required"],
            participants: nil,
            fileSize: 0
        )

        let result = try await service.saveNote(
            type: .email,
            filename: "2026-07-08-100000-test-email.md",
            content: content,
            metadata: metadata
        )

        XCTAssertEqual(result.type, .email)
        XCTAssertEqual(result.source, "email")
        XCTAssertTrue(result.path.starts(with: "notes/emails/"))
        XCTAssertEqual(result.rawFile, "EmailInbox/2026/07/raw-email.txt")
        XCTAssertEqual(result.sourceHash, "abc123")
    }

    func testSaveDocumentNote() async throws {
        let content = Data("# Requirements\\n\\n...".utf8)
        let metadata = NoteMetadata(
            id: "test-id",
            type: .document,
            source: "box",
            title: "Requirements Doc",
            date: "2026-07-07T14:00:00Z",
            path: "",
            rawFile: "Documents/2026/07/requirements.pdf",
            sourceHash: nil,
            generatedAt: "2026-07-07T14:05:00Z",
            tags: ["requirements"],
            participants: nil,
            fileSize: 0
        )

        let result = try await service.saveNote(
            type: .document,
            filename: "2026-07-07-140000-requirements-doc.md",
            content: content,
            metadata: metadata
        )

        XCTAssertEqual(result.type, .document)
        XCTAssertEqual(result.source, "box")
        XCTAssertTrue(result.path.starts(with: "notes/documents/"))
        XCTAssertEqual(result.rawFile, "Documents/2026/07/requirements.pdf")
    }

    func testQueryNotesByType() async throws {
        // Save meeting note
        let meetingMetadata = NoteMetadata(
            id: "meeting-1",
            type: .meeting,
            source: "test",
            title: "Meeting",
            date: "2026-07-08T09:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-08T09:05:00Z",
            tags: [],
            participants: nil,
            fileSize: 0
        )

        _ = try await service.saveNote(
            type: .meeting,
            filename: "meeting.docx",
            content: Data("meeting".utf8),
            metadata: meetingMetadata
        )

        // Save email note
        let emailMetadata = NoteMetadata(
            id: "email-1",
            type: .email,
            source: "test",
            title: "Email",
            date: "2026-07-08T10:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-08T10:05:00Z",
            tags: [],
            participants: nil,
            fileSize: 0
        )

        _ = try await service.saveNote(
            type: .email,
            filename: "email.md",
            content: Data("email".utf8),
            metadata: emailMetadata
        )

        // Query meetings
        let meetings = try await service.queryNotes(NoteFilter(type: .meeting))
        XCTAssertEqual(meetings.count, 1)
        XCTAssertEqual(meetings.first?.type, .meeting)

        // Query emails
        let emails = try await service.queryNotes(NoteFilter(type: .email))
        XCTAssertEqual(emails.count, 1)
        XCTAssertEqual(emails.first?.type, .email)
    }

    func testQueryNotesByDateRange() async throws {
        // Save notes on different dates
        let metadata1 = NoteMetadata(
            id: "note-1",
            type: .meeting,
            source: "test",
            title: "Meeting 1",
            date: "2026-07-01T09:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-01T09:05:00Z",
            tags: [],
            participants: nil,
            fileSize: 0
        )

        _ = try await service.saveNote(
            type: .meeting,
            filename: "meeting1.docx",
            content: Data("meeting1".utf8),
            metadata: metadata1
        )

        let metadata2 = NoteMetadata(
            id: "note-2",
            type: .meeting,
            source: "test",
            title: "Meeting 2",
            date: "2026-07-08T09:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-08T09:05:00Z",
            tags: [],
            participants: nil,
            fileSize: 0
        )

        _ = try await service.saveNote(
            type: .meeting,
            filename: "meeting2.docx",
            content: Data("meeting2".utf8),
            metadata: metadata2
        )

        // Query July 2026
        let july = try await service.queryNotes(
            NoteFilter(
                type: .meeting,
                startDate: "2026-07-01T00:00:00Z",
                endDate: "2026-07-31T23:59:59Z"
            )
        )

        XCTAssertEqual(july.count, 2)
    }

    func testBuildUnifiedIndex() async throws {
        // Save notes
        let meetingMetadata = NoteMetadata(
            id: "meeting-1",
            type: .meeting,
            source: "test",
            title: "M",
            date: "2026-07-08T09:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-08T09:05:00Z",
            tags: [],
            participants: nil,
            fileSize: 0
        )

        _ = try await service.saveNote(
            type: .meeting,
            filename: "m.docx",
            content: Data("m".utf8),
            metadata: meetingMetadata
        )

        let emailMetadata = NoteMetadata(
            id: "email-1",
            type: .email,
            source: "test",
            title: "E",
            date: "2026-07-08T10:00:00Z",
            path: "",
            rawFile: nil,
            sourceHash: nil,
            generatedAt: "2026-07-08T10:05:00Z",
            tags: [],
            participants: nil,
            fileSize: 0
        )

        _ = try await service.saveNote(
            type: .email,
            filename: "e.md",
            content: Data("e".utf8),
            metadata: emailMetadata
        )

        // Load index
        let index = try await service.loadIndex()

        XCTAssertEqual(index.notes.count, 2)
        XCTAssertTrue(index.notes.contains(where: { $0.type == .meeting }))
        XCTAssertTrue(index.notes.contains(where: { $0.type == .email }))
    }
}
