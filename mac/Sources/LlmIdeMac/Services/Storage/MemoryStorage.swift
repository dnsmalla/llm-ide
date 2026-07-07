// Memory storage layer: typed file I/O for the `.llm-ide/memory/` directory.
//
// Swift mirror of `extension/graphkit/storage/memory-storage.ts` (Task 3).
//
// - All writes are atomic: write to a unique temp file in the same directory,
//   then swap into place via FileManager. The swap uses `moveItem` for a new
//   file and `replaceItem` for an existing file (moveItem refuses to overwrite).
//   Both are same-filesystem renames, giving the same atomic-overwrite guarantee
//   as the TS layer's `fs.rename`.
// - All failures surface as `MemoryStorageError` with a specific `code` so
//   callers (migration, service layer) can branch on cause.

import Foundation

/// Typed error for memory storage operations.
///
/// `code` mirrors the TS `'NOT_FOUND' | 'PERMISSION_DENIED' | 'CORRUPTED' | 'MIGRATION_FAILED'`
/// discriminator so Swift and TS callers share one error vocabulary. The
/// `MIGRATION_FAILED` case is not raised by storage I/O itself; it is provided
/// for the migration layer (Task 7) which reuses this error type.
public enum MemoryStorageError: Error, LocalizedError, Equatable, Sendable {
    case notFound(path: String)
    case permissionDenied(path: String)
    case corrupted(path: String, underlyingDescription: String)
    case migrationFailed(path: String, reason: String)

    /// Stable string code matching the TS `MemoryStorageError.code` field.
    public var code: String {
        switch self {
        case .notFound: return "NOT_FOUND"
        case .permissionDenied: return "PERMISSION_DENIED"
        case .corrupted: return "CORRUPTED"
        case .migrationFailed: return "MIGRATION_FAILED"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .notFound(let path):
            return "Memory file not found: \(path)"
        case .permissionDenied(let path):
            return "Permission denied accessing: \(path)"
        case .corrupted(let path, let underlyingDescription):
            return "Memory file corrupted: \(path) - \(underlyingDescription)"
        case .migrationFailed(let path, let reason):
            return "Memory migration failed: \(path) - \(reason)"
        }
    }
}

/// File-backed memory storage for a repo's `.llm-ide/memory/` directory.
///
/// Stateless: every operation takes the repo root explicitly, so a single
/// shared instance is safe to use from any actor (hence `Sendable`). Methods
/// are `async` to match the TS contract even though the current bodies are
/// synchronous file I/O; this leaves room for genuinely async I/O later
/// without breaking callers.
public final class MemoryStorage: Sendable {

    public init() {}

    /// The canonical memory directory for a repo: `<repoRoot>/.llm-ide/memory`.
    public func getMemoryDir(repoRoot: URL) -> URL {
        repoRoot.appendingPathComponent(".llm-ide").appendingPathComponent("memory")
    }

    /// Read a memory file as UTF-8 text.
    public func readMemoryFile(repoRoot: URL, filename: String) async throws -> String {
        let fileURL = getMemoryDir(repoRoot: repoRoot).appendingPathComponent(filename)
        do {
            return try String(contentsOf: fileURL, encoding: .utf8)
        } catch let err as CocoaError {
            switch err.code {
            case .fileReadNoSuchFile, .fileNoSuchFile:
                throw MemoryStorageError.notFound(path: fileURL.path)
            case .fileReadNoPermission, .fileWriteNoPermission:
                throw MemoryStorageError.permissionDenied(path: fileURL.path)
            default:
                throw MemoryStorageError.corrupted(
                    path: fileURL.path, underlyingDescription: err.localizedDescription)
            }
        } catch {
            throw MemoryStorageError.corrupted(
                path: fileURL.path, underlyingDescription: error.localizedDescription)
        }
    }

    /// Write a memory file atomically (temp file + rename in the same directory).
    public func writeMemoryFile(repoRoot: URL, filename: String, content: String) async throws {
        let memDir = getMemoryDir(repoRoot: repoRoot)
        try FileManager.default.createDirectory(at: memDir, withIntermediateDirectories: true)

        let fileURL = memDir.appendingPathComponent(filename)
        // Unique temp name in the SAME directory (same filesystem => atomic rename).
        let tempURL = memDir.appendingPathComponent(".\(filename).tmp.\(UUID().uuidString)")

        do {
            // Plain write to temp; the swap below is the atomicity guarantee
            // (mirrors TS `fs.writeFile(tempPath)` + `fs.rename(tempPath, final)`).
            try content.write(to: tempURL, atomically: false, encoding: .utf8)

            // `moveItem` refuses to overwrite an existing file; use `replaceItem`
            // when one exists so re-writes are atomic too (matches `fs.rename`).
            if FileManager.default.fileExists(atPath: fileURL.path) {
                // `resultingItemURL` is required by this SDK's signature; pass nil
                // (we don't need the backup/replaced URL back).
                _ = try FileManager.default.replaceItem(
                    at: fileURL, withItemAt: tempURL, backupItemName: nil,
                    options: [], resultingItemURL: nil)
            } else {
                try FileManager.default.moveItem(at: tempURL, to: fileURL)
            }
        } catch let err as CocoaError {
            try? FileManager.default.removeItem(at: tempURL)
            switch err.code {
            case .fileWriteNoPermission, .fileReadNoPermission:
                throw MemoryStorageError.permissionDenied(path: fileURL.path)
            default:
                throw MemoryStorageError.corrupted(
                    path: fileURL.path, underlyingDescription: err.localizedDescription)
            }
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            throw MemoryStorageError.corrupted(
                path: fileURL.path, underlyingDescription: error.localizedDescription)
        }
    }

    /// Read `repo.md`. Returns an empty string when the file does not yet exist
    /// (fresh repo) instead of throwing, mirroring the TS layer's graceful
    /// degradation for user-facing facts.
    public func readRepoMD(repoRoot: URL) async throws -> String {
        do {
            return try await readMemoryFile(repoRoot: repoRoot, filename: "repo.md")
        } catch MemoryStorageError.notFound {
            return ""
        }
    }

    /// Parse `chat-memory.md` into facts. Returns `[]` when the file does not
    /// yet exist (fresh repo). The parser is the MVP line-by-line one from the
    /// TS layer: every line starting with `- ` becomes a fact (category
    /// `.convention`, source `.agent`); the header lines are naturally skipped
    /// because none of them start with `- `.
    ///
    /// Note (parity quirk inherited from the TS MVP): timestamps are not
    /// persisted in the file, so each fact's `timestamp` is synthesized at
    /// read time as "now", not the original capture time.
    public func readChatMemory(repoRoot: URL) async throws -> [ChatMemoryFact] {
        do {
            let content = try await readMemoryFile(repoRoot: repoRoot, filename: "chat-memory.md")
            let nowMs = Int(Date().timeIntervalSince1970 * 1000)
            return content
                .split(separator: "\n", omittingEmptySubsequences: false)
                .compactMap { line -> ChatMemoryFact? in
                    let line = String(line)
                    guard line.hasPrefix("- ") else { return nil }
                    return ChatMemoryFact(
                        text: String(line.dropFirst(2)),
                        category: .convention,
                        timestamp: nowMs,
                        source: .agent
                    )
                }
        } catch MemoryStorageError.notFound {
            return []
        }
    }

    /// Write facts to `chat-memory.md` with the standard header. Overwrites any
    /// existing file atomically.
    public func writeChatMemory(repoRoot: URL, facts: [ChatMemoryFact]) async throws {
        // Byte-for-byte identical to the TS header (newlines explicit to avoid
        // any multiline-string-literal ambiguity).
        let header = "# Chat memory\n"
            + "_Auto-captured by the Code Assistant from prior chats about this project._\n"
            + "_Recalled automatically next session. View or clear these in the app._\n"
            + "\n"
        let body = facts.map { "- \($0.text)" }.joined(separator: "\n")
        let content = header + body + "\n"
        try await writeMemoryFile(repoRoot: repoRoot, filename: "chat-memory.md", content: content)
    }
}
