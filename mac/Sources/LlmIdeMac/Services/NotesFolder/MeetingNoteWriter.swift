// Meeting note writer using unified NoteService
// Writes generated meeting notes to llm-doc/meetings/ via NoteService.
//   • `.docx` — bundled Word template (existing polished note)
//   • `.md`   — project template at templates/meeting-note/template.md

import Foundation
import os.log

/// Writes meeting notes using the unified NoteService.
struct MeetingNoteWriter {
    let noteService: NoteService
    let repoRoot: URL
    private let logger = Logger(subsystem: "LlmIdeMac", category: "MeetingNoteWriter")

    init(repoRoot: URL) {
        self.repoRoot = repoRoot
        self.noteService = NoteService(repoRoot: repoRoot)
    }

    /// Write a generated meeting note (`.docx` content) to the unified notes structure.
    @discardableResult
    func writeDocxNote(
        docxContent: Data,
        title: String,
        startedAt: Date,
        participants: [String],
        rawFile: String
    ) async throws -> URL {
        try await saveNote(
            content: docxContent,
            filename: Self.docxFilename(startedAt: startedAt, title: title),
            title: title,
            startedAt: startedAt,
            participants: participants,
            rawFile: rawFile)
    }

    /// Write a template-rendered meeting note (`.md` content).
    @discardableResult
    func writeMarkdownNote(
        markdown: String,
        title: String,
        startedAt: Date,
        participants: [String],
        rawFile: String
    ) async throws -> URL {
        try await saveNote(
            content: Data(markdown.utf8),
            filename: Self.markdownFilename(startedAt: startedAt, title: title),
            title: title,
            startedAt: startedAt,
            participants: participants,
            rawFile: rawFile)
    }

    /// Get the output directory for meeting notes.
    func outputDirectory(for date: Date) -> URL {
        noteService.getMonthDir(type: .meeting, date: date)
    }

    // MARK: - Private

    private func saveNote(
        content: Data,
        filename: String,
        title: String,
        startedAt: Date,
        participants: [String],
        rawFile: String
    ) async throws -> URL {
        let metadata = NoteMetadata(
            id: "",
            type: .meeting,
            source: "meeting",
            title: title,
            date: AppDateFormatter.isoString(startedAt),
            path: "",
            rawFile: rawFile,
            sourceHash: nil,
            generatedAt: AppDateFormatter.isoString(Date()),
            tags: ["meeting"],
            participants: participants,
            fileSize: Int64(content.count)
        )

        let saved = try await noteService.saveNote(
            type: .meeting,
            filename: filename,
            content: content,
            metadata: metadata
        )

        logger.info("Meeting note saved: \(saved.path, privacy: .public)")
        return repoRoot.appendingPathComponent(saved.path)
    }

    // MARK: - Filenames

    private static func docxFilename(startedAt: Date, title: String) -> String {
        baseFilename(startedAt: startedAt, title: title, suffix: "meeting-notes.docx")
    }

    private static func markdownFilename(startedAt: Date, title: String) -> String {
        baseFilename(startedAt: startedAt, title: title, suffix: "meeting-notes.md")
    }

    private static func baseFilename(startedAt: Date, title: String, suffix: String) -> String {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd-HHmmss"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")
        let dateSlug = dateFormatter.string(from: startedAt)
        let slug = slugify(title.isEmpty ? "meeting" : title)
        return "\(dateSlug)-\(slug)-\(suffix)"
    }

    private static func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "meeting" : String(collapsed.prefix(60))
    }
}
