// Email note writer using unified NoteService
// Writes generated email notes to llm-doc/emails/ via NoteService.
// Body layout comes from `<project>/templates/email-note/template.md`.

import Foundation

/// Writes email notes using the unified NoteService.
struct EmailNoteWriter {
    let noteService: NoteService
    let repoRoot: URL

    init(repoRoot: URL) {
        self.repoRoot = repoRoot
        self.noteService = NoteService(repoRoot: repoRoot)
    }

    /// Write a generated email note to the unified notes structure.
    @discardableResult
    func writeNote(
        from: String,
        date: Date,
        subject: String,
        classification c: LlmIdeAPIClient.EmailClassification,
        originalBody: String,
        sourceHash: String,
        rawFile: String
    ) async throws -> URL {
        let md = IngestTemplateRenderer.renderEmailNote(
            projectRoot: repoRoot,
            from: from,
            date: date,
            subject: subject,
            classification: c,
            originalBody: originalBody,
            sourceHash: sourceHash,
            rawFile: rawFile)

        let filename = Self.filename(date: date, subject: subject)

        let metadata = NoteMetadata(
            id: "",
            type: .email,
            source: "email",
            title: subject.isEmpty ? "Email" : subject,
            date: AppDateFormatter.isoString(date),
            path: "",
            rawFile: rawFile,
            sourceHash: sourceHash,
            generatedAt: AppDateFormatter.isoString(Date()),
            tags: [c.category],
            participants: nil,
            fileSize: 0
        )

        let saved = try await noteService.saveNote(
            type: .email,
            filename: filename,
            content: Data(md.utf8),
            metadata: metadata
        )

        return repoRoot.appendingPathComponent(saved.path)
    }

    /// Write a skipped email stub.
    @discardableResult
    func writeSkipped(
        from: String,
        date: Date,
        subject: String,
        category: String,
        originalBody: String,
        sourceHash: String,
        rawFile: String
    ) async throws -> URL {
        let md = IngestTemplateRenderer.renderSkippedEmailNote(
            projectRoot: repoRoot,
            from: from,
            date: date,
            subject: subject,
            category: category,
            originalBody: originalBody,
            sourceHash: sourceHash,
            rawFile: rawFile)

        let filename = Self.filename(date: date, subject: subject)

        let metadata = NoteMetadata(
            id: "",
            type: .email,
            source: "email",
            title: subject.isEmpty ? "Email" : subject,
            date: AppDateFormatter.isoString(date),
            path: "",
            rawFile: rawFile,
            sourceHash: sourceHash,
            generatedAt: AppDateFormatter.isoString(Date()),
            tags: [category],
            participants: nil,
            fileSize: 0
        )

        let saved = try await noteService.saveNote(
            type: .email,
            filename: filename,
            content: Data(md.utf8),
            metadata: metadata
        )

        return repoRoot.appendingPathComponent(saved.path)
    }

    /// Scan existing notes and collect source hashes.
    func existingSourceHashes() async throws -> Set<String> {
        let notes = try await noteService.queryNotes(NoteFilter(type: .email))
        var hashes: Set<String> = []
        for note in notes {
            if let hash = note.sourceHash {
                hashes.insert(hash)
            }
        }
        return hashes
    }

    // MARK: - Helpers

    private static func filename(date: Date, subject: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        f.timeZone = TimeZone(identifier: "UTC")
        let stamp = f.string(from: date)
        let slug = slugify(subject.isEmpty ? "email" : subject)
        return "\(stamp)-\(slug).md"
    }

    private static func slugify(_ s: String) -> String {
        let allowed = CharacterSet.alphanumerics
        let cleaned = s.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(cleaned)
        let collapsed = joined.split(separator: "-").joined(separator: "-")
        return String(collapsed.prefix(60)).isEmpty ? "email" : String(collapsed.prefix(60))
    }
}
