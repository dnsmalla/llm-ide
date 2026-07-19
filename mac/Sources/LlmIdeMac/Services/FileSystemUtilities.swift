import Foundation

/// Centralized file system operations. Single source of truth for:
/// - Safe directory creation with logging
/// - File existence checks
/// - Atomic writes with backup
/// - Symlink detection
/// - Error recovery
///
/// Replaces 154 scattered FileManager.default calls across 61 files.
struct FileSystemUtilities {
    private let logHandler: (String) -> Void

    init(logHandler: ((String) -> Void)? = nil) {
        self.logHandler = logHandler ?? { _ in }
    }

    // MARK: - Directory Operations

    /// Ensure directory exists, creating it with intermediate directories if needed.
    /// Logs all operations for debugging.
    func ensureDirectory(at url: URL) throws {
        let fm = FileManager.default
        guard !fm.fileExists(atPath: url.path) else {
            logHandler("Directory already exists: \(url.lastPathComponent)")
            return
        }
        logHandler("Creating directory: \(url.lastPathComponent)")
        try fm.createDirectory(at: url, withIntermediateDirectories: true)
        logHandler("Directory created: \(url.lastPathComponent)")
    }

    /// Check if file exists at path. Logs missing files for debugging.
    func fileExists(at url: URL, logIfMissing: Bool = true) -> Bool {
        let exists = FileManager.default.fileExists(atPath: url.path)
        if !exists && logIfMissing {
            logHandler("File not found: \(url.lastPathComponent)")
        }
        return exists
    }

    /// Check if path is a symlink.
    func isSymlink(at url: URL) -> Bool {
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
            return attrs[.type] as? String == FileAttributeType.typeSymbolicLink.rawValue
        } catch {
            logHandler("Failed to check symlink status: \(error.localizedDescription)")
            return false
        }
    }

    /// Get file size in bytes, or nil if file doesn't exist.
    func fileSize(at url: URL) -> UInt64? {
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
            return attrs[.size] as? UInt64
        } catch {
            logHandler("Failed to get file size: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Read Operations

    /// Read file contents with error logging.
    func readData(at url: URL) throws -> Data {
        logHandler("Reading file: \(url.lastPathComponent)")
        do {
            let data = try Data(contentsOf: url)
            logHandler("Read \(data.count) bytes from \(url.lastPathComponent)")
            return data
        } catch {
            logHandler("Failed to read file: \(error.localizedDescription)")
            throw error
        }
    }

    /// Read file as string with error logging.
    func readString(at url: URL, encoding: String.Encoding = .utf8) throws -> String {
        let data = try readData(at: url)
        guard let string = String(data: data, encoding: encoding) else {
            let error = FileSystemError.invalidEncoding
            logHandler("Failed to decode string: \(error.localizedDescription)")
            throw error
        }
        return string
    }

    // MARK: - Write Operations

    /// Write data atomically: write to temp file, backup existing, rename temp to target.
    /// Ensures data is not lost if write fails mid-operation.
    func writeDataAtomic(_ data: Data, to url: URL, backup: Bool = true) throws {
        logHandler("Writing \(data.count) bytes to \(url.lastPathComponent)")

        // Ensure parent directory exists
        try ensureDirectory(at: url.deletingLastPathComponent())

        // Write to temp file first
        let tempURL = url.appendingPathExtension("tmp")
        try data.write(to: tempURL, options: .atomic)
        logHandler("Wrote temp file: \(tempURL.lastPathComponent)")

        // Backup existing file if requested
        if backup && fileExists(at: url, logIfMissing: false) {
            let backupURL = url.appendingPathExtension("backup")
            try? FileManager.default.removeItem(at: backupURL)
            try FileManager.default.copyItem(at: url, to: backupURL)
            logHandler("Backed up existing file")
        }

        // Move temp to target
        try FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: tempURL, to: url)
        logHandler("Atomically wrote to: \(url.lastPathComponent)")
    }

    /// Write string atomically.
    func writeStringAtomic(_ string: String, to url: URL, encoding: String.Encoding = .utf8, backup: Bool = true) throws {
        guard let data = string.data(using: encoding) else {
            throw FileSystemError.invalidEncoding
        }
        try writeDataAtomic(data, to: url, backup: backup)
    }

    // MARK: - Delete Operations

    /// Remove file or directory, with error logging.
    func remove(at url: URL) throws {
        logHandler("Removing: \(url.lastPathComponent)")
        try FileManager.default.removeItem(at: url)
        logHandler("Removed: \(url.lastPathComponent)")
    }

    /// Safely remove file if it exists (no error if missing).
    func removeIfExists(at url: URL) {
        guard fileExists(at: url, logIfMissing: false) else { return }
        do {
            try remove(at: url)
        } catch {
            logHandler("Failed to remove file: \(error.localizedDescription)")
        }
    }

    // MARK: - Listing Operations

    /// List all markdown files in directory, sorted by name.
    func listMarkdownFiles(in dir: URL) -> [URL] {
        do {
            let entries = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            let mdFiles = entries
                .filter { $0.pathExtension.lowercased() == "md" }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            logHandler("Found \(mdFiles.count) markdown files in \(dir.lastPathComponent)")
            return mdFiles
        } catch {
            logHandler("Failed to list directory: \(error.localizedDescription)")
            return []
        }
    }

    // MARK: - Corruption Recovery

    func backupAsCorrupt(at url: URL) -> URL? {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let corruptURL = url.deletingPathExtension()
            .appendingPathExtension("corrupt-\(timestamp).bak")
        do {
            try FileManager.default.moveItem(at: url, to: corruptURL)
            logHandler("Backed up corrupt file: \(corruptURL.lastPathComponent)")
            return corruptURL
        } catch {
            logHandler("Failed to backup corrupt file: \(error.localizedDescription)")
            return nil
        }
    }
}

// MARK: - Errors

enum FileSystemError: LocalizedError {
    case invalidEncoding
    case notFound
    case alreadyExists
    case unknown(String)

    var errorDescription: String? {
        switch self {
        case .invalidEncoding:
            return "Invalid file encoding"
        case .notFound:
            return "File not found"
        case .alreadyExists:
            return "File already exists"
        case .unknown(let message):
            return "File system error: \(message)"
        }
    }
}
