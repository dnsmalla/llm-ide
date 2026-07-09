// Unified note service — Swift mirror of TypeScript NoteService.
//
// Architecture:
// - Raw data stays in source folders (meetings/, EmailInbox/, Documents/)
// - Generated notes go to unified notes/ folder (notes/meetings/, notes/emails/, notes/documents/)
// - Each generated note tracks its source file
//
// This service provides a unified interface for:
// - Saving generated notes
// - Querying notes by type/date
// - Building and maintaining note index
// - Tracking which raw file generated which note

import Foundation
import os.log

// MARK: - Types

/// Note type classification
public enum NoteType: String, Codable, Sendable {
    case meeting
    case email
    case document
}

/// Unified note metadata
public struct NoteMetadata: Codable, Sendable, Identifiable {
    public let id: String                    // Unique note ID
    public let type: NoteType                // meeting, email, or document
    public let source: String                // Source system (email, google-meet, box, etc.)
    public let title: String                 // Note title
    public let date: String                  // ISO date string
    public let path: String                  // Relative path from project root
    public let rawFile: String?              // Path to raw source file
    public let sourceHash: String?           // Hash of raw source file (deduplication)
    public let generatedAt: String           // When note was generated
    public let tags: [String]                // Tags for filtering
    public let participants: [String]?       // For meetings
    public let fileSize: Int64                // File size in bytes

    public init(
        id: String,
        type: NoteType,
        source: String,
        title: String,
        date: String,
        path: String,
        rawFile: String?,
        sourceHash: String?,
        generatedAt: String,
        tags: [String],
        participants: [String]?,
        fileSize: Int64
    ) {
        self.id = id
        self.type = type
        self.source = source
        self.title = title
        self.date = date
        self.path = path
        self.rawFile = rawFile
        self.sourceHash = sourceHash
        self.generatedAt = generatedAt
        self.tags = tags
        self.participants = participants
        self.fileSize = fileSize
    }
}

/// Note filter for queries
public struct NoteFilter: Codable, Sendable {
    public let type: NoteType?
    public let source: String?
    public let startDate: String?
    public let endDate: String?
    public let tags: [String]?
    public let limit: Int?

    public init(
        type: NoteType? = nil,
        source: String? = nil,
        startDate: String? = nil,
        endDate: String? = nil,
        tags: [String]? = nil,
        limit: Int? = nil
    ) {
        self.type = type
        self.source = source
        self.startDate = startDate
        self.endDate = endDate
        self.tags = tags
        self.limit = limit
    }
}

/// Unified note index
public struct NoteIndex: Codable, Sendable {
    public let version: Int
    public var updated: String
    public var notes: [NoteMetadata]

    public init() {
        self.version = 1
        self.updated = ISO8601DateFormatter().string(from: Date())
        self.notes = []
    }

    public init(version: Int, updated: String, notes: [NoteMetadata]) {
        self.version = version
        self.updated = updated
        self.notes = notes
    }
}

// MARK: - Note Service

/// Unified note service for managing generated notes from raw data sources.
public final class NoteService: Sendable {

    private let repoRoot: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let logger = Logger(subsystem: "LlmIdeMac", category: "NoteService")

    public init(repoRoot: URL) {
        self.repoRoot = repoRoot

        // Configure encoder/decoder for ISO8601 dates
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        self.encoder = JSONEncoder()
        self.encoder.dateEncodingStrategy = .iso8601

        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    // MARK: - Paths

    /// Root directory for all generated notes: <repoRoot>/notes/
    public var notesRoot: URL {
        repoRoot.appendingPathComponent("notes", isDirectory: true)
    }

    /// Directory for generated meeting notes: notesRoot/meetings/
    public var meetingsDir: URL {
        notesRoot.appendingPathComponent("meetings", isDirectory: true)
    }

    /// Directory for generated email notes: notesRoot/emails/
    public var emailsDir: URL {
        notesRoot.appendingPathComponent("emails", isDirectory: true)
    }

    /// Directory for generated document notes: notesRoot/documents/
    public var documentsDir: URL {
        notesRoot.appendingPathComponent("documents", isDirectory: true)
    }

    /// Path to unified note index: notesRoot/index.json
    public var indexPath: URL {
        notesRoot.appendingPathComponent("index.json")
    }

    /// Get the appropriate subdirectory for a note type
    public func getDirForType(_ type: NoteType) -> URL {
        switch type {
        case .meeting:
            return meetingsDir
        case .email:
            return emailsDir
        case .document:
            return documentsDir
        }
    }

    /// Get month folder path (YYYY/MM/) for a given date
    public func monthFolder(for date: Date) -> String {
        let calendar = Calendar.current
        let components = calendar.dateComponents([.year, .month], from: date)
        let year = String(format: "%04d", components.year ?? 0)
        let month = String(format: "%02d", components.month ?? 0)
        return "\(year)/\(month)/"
    }

    /// Get full month directory URL for a note type and date
    public func getMonthDir(type: NoteType, date: Date) -> URL {
        let typeDir = getDirForType(type)
        let monthPath = monthFolder(for: date)
        return typeDir.appendingPathComponent(monthPath, isDirectory: true)
    }

    // MARK: - Save operations

    /// Save a generated note to the appropriate location.
    ///
    /// - Parameters:
    ///   - type: Note type (meeting, email, document)
    ///   - filename: Filename (without path)
    ///   - content: Note content
    ///   - metadata: Note metadata
    /// - Returns: The saved note metadata with path
    public func saveNote(
        type: NoteType,
        filename: String,
        content: Data,
        metadata: NoteMetadata
    ) async throws -> NoteMetadata {
        let dateFormatter = ISO8601DateFormatter()
        let date = dateFormatter.date(from: metadata.date) ?? Date()
        let dir = getMonthDir(type: type, date: date)

        // Ensure directory exists
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Write file atomically
        let filePath = dir.appendingPathComponent(filename)
        try content.write(to: filePath, options: .atomic)

        // Generate metadata
        let relativePath = filePath.pathComponents.suffix(from: repoRoot.pathComponents.count).joined(separator: "/")

        var noteMetadata = metadata
        noteMetadata = NoteMetadata(
            id: generateId(type: type, filename: filename, date: metadata.date),
            type: type,
            source: metadata.source,
            title: metadata.title,
            date: metadata.date,
            path: relativePath,
            rawFile: metadata.rawFile,
            sourceHash: metadata.sourceHash,
            generatedAt: dateFormatter.string(from: Date()),
            tags: metadata.tags,
            participants: metadata.participants,
            fileSize: Int64(content.count)
        )

        // Update index
        try await addToIndex(noteMetadata)

        return noteMetadata
    }

    // MARK: - Query operations

    /// Query notes with optional filtering.
    public func queryNotes(_ filter: NoteFilter = NoteFilter()) async throws -> [NoteMetadata] {
        let index = try await loadIndex()
        var notes = index.notes

        // Filter by type
        if let type = filter.type {
            notes = notes.filter { $0.type == type }
        }

        // Filter by source
        if let source = filter.source {
            notes = notes.filter { $0.source == source }
        }

        // Filter by date range
        if let startDate = filter.startDate {
            notes = notes.filter { $0.date >= startDate }
        }
        if let endDate = filter.endDate {
            notes = notes.filter { $0.date <= endDate }
        }

        // Filter by tags (any match)
        if let tags = filter.tags, !tags.isEmpty {
            notes = notes.filter { note in
                tags.contains { note.tags.contains($0) }
            }
        }

        // Sort by date descending
        notes.sort { $0.date > $1.date }

        // Apply limit
        if let limit = filter.limit {
            notes = Array(notes.prefix(limit))
        }

        return notes
    }

    // MARK: - Index operations

    /// Load the unified note index.
    public func loadIndex() async throws -> NoteIndex {
        do {
            let data = try Data(contentsOf: indexPath)
            return try decoder.decode(NoteIndex.self, from: data)
        } catch {
            // Index doesn't exist yet, return empty
            logger.info("Creating new note index")
            return NoteIndex()
        }
    }

    /// Save the unified note index.
    private func saveIndex(_ index: NoteIndex) throws {
        var mutableIndex = index
        mutableIndex.updated = ISO8601DateFormatter().string(from: Date())
        let data = try encoder.encode(mutableIndex)
        try data.write(to: indexPath, options: .atomic)
    }

    /// Add a note to the index.
    private func addToIndex(_ metadata: NoteMetadata) async throws {
        var index = try await loadIndex()

        // Remove existing note with same ID (if any)
        index.notes.removeAll(where: { $0.id == metadata.id })

        // Add new note
        index.notes.append(metadata)

        try saveIndex(index)
    }

    /// Rebuild the entire index by scanning the notes directory.
    public func rebuildIndex() async throws -> NoteIndex {
        var notes: [NoteMetadata] = []

        // Scan all note types
        for type in [NoteType.meeting, .email, .document] {
            let typeDir = getDirForType(type)
            let typeNotes = try await scanTypeDirectory(type: type, dir: typeDir)
            notes.append(contentsOf: typeNotes)
        }

        let index = NoteIndex(
            version: 1,
            updated: ISO8601DateFormatter().string(from: Date()),
            notes: notes
        )

        try saveIndex(index)
        return index
    }

    /// Scan a specific type directory for notes.
    private func scanTypeDirectory(type: NoteType, dir: URL) async throws -> [NoteMetadata] {
        var notes: [NoteMetadata] = []

        guard let enumerator = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else {
            return notes
        }

        // Collect all URLs first to avoid iterator issues in async contexts (Swift 6)
        var allFiles: [URL] = []
        while let file = enumerator.nextObject() as? URL {
            allFiles.append(file)
        }

        for file in allFiles {
            let filename = file.lastPathComponent

            // Skip index.json and directories
            if filename == "index.json" {
                continue
            }

            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory),
                  !isDirectory.boolValue else {
                continue
            }

            let relativePath = file.pathComponents.suffix(from: notesRoot.pathComponents.count).joined(separator: "/")

            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            let fileSize = attributes[.size] as? Int64 ?? 0
            let modificationDate = attributes[.modificationDate] as? Date ?? Date()

            let dateFormatter = ISO8601DateFormatter()

            let metadata = NoteMetadata(
                id: generateId(type: type, filename: filename, date: dateFormatter.string(from: modificationDate)),
                type: type,
                source: "unknown",
                title: filename,
                date: dateFormatter.string(from: modificationDate),
                path: relativePath,
                rawFile: nil,
                sourceHash: nil,
                generatedAt: dateFormatter.string(from: modificationDate),
                tags: [],
                participants: nil,
                fileSize: fileSize
            )

            notes.append(metadata)
        }

        return notes
    }

    // MARK: - ID generation

    /// Generate a unique note ID.
    private func generateId(type: NoteType, filename: String, date: String) -> String {
        let slug = (filename as NSString).deletingPathExtension
        let dateStr = date.replacingOccurrences(of: "[^0-9T]", with: "", options: .regularExpression)
        let truncatedDate = String(dateStr.prefix(15))
        let truncatedSlug = String(slug.prefix(20))
        return "\(type.rawValue)-\(truncatedDate)-\(truncatedSlug)"
    }
}

// MARK: - Errors

enum NoteError: LocalizedError {
    case noteNotFound(String)

    var errorDescription: String? {
        switch self {
        case .noteNotFound(let id):
            return "Note not found: \(id)"
        }
    }
}
