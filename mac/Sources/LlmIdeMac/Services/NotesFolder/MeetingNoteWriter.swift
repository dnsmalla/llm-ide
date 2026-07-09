// Meeting note writer using unified NoteService
// Writes generated meeting notes to notes/meetings/ instead of notes/

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

    /// Write a generated meeting note (.docx content) to the unified notes structure.
    @discardableResult
    func writeNote(
        docxContent: Data,
        title: String,
        startedAt: Date,
        participants: [String],
        rawFile: String
    ) async throws -> URL {
        // Generate filename
        let filename = Self.filename(startedAt: startedAt, title: title)

        // Create note metadata
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
            fileSize: Int64(docxContent.count)
        )

        // Save via NoteService
        let saved = try await noteService.saveNote(
            type: .meeting,
            filename: filename,
            content: docxContent,
            metadata: metadata
        )

        logger.info("Meeting note saved: \(saved.path, privacy: .public)")

        // Return full file URL
        return repoRoot.appendingPathComponent(saved.path)
    }

    /// Get the output directory for meeting notes.
    /// Returns the full path to notes/meetings/YYYY/MM/.
    func outputDirectory(for date: Date) -> URL {
        let monthDir = noteService.getMonthDir(type: .meeting, date: date)
        return repoRoot.appendingPathComponent(monthDir.path)
    }

    // MARK: - Helpers

    private static func filename(startedAt: Date, title: String) -> String {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd-HHmmss"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")
        let dateSlug = dateFormatter.string(from: startedAt)

        let slug = slugify(title.isEmpty ? "meeting" : title)
        return "\(dateSlug)-\(slug)-meeting-notes.docx"
    }

    private static func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "meeting" : String(collapsed.prefix(60))
    }
}
