import Foundation

/// The one way the app writes a user's text file back to disk — shared by
/// the editor's Save (`EditableTextDetailView`) and Search's replace
/// (`SearchService`), so both keep the same guarantees instead of two
/// writers drifting apart (the editor's `String.write(atomically:)` used to
/// overwrite read-only files and split hard links).
enum TextFileWriter {

    /// Above this size a file is not loaded into the editor at all. Monaco
    /// holds the whole buffer in its web view and re-tokenizes it, so a large
    /// log (hundreds of MB) froze the pane; 5 MB stays responsive while still
    /// covering any hand-edited source file. Search reads far less
    /// (`SearchEngine.maxFileBytes`, 1 MB) because it scans every file.
    static let maxEditableBytes = 5 * 1024 * 1024

    enum WriteError: LocalizedError {
        case notUTF8
        case notWritable

        var errorDescription: String? {
            switch self {
            case .notUTF8: return "The text could not be encoded as UTF-8."
            case .notWritable: return "The file is read-only."
            }
        }
    }

    /// Write `text` as UTF-8 via a temp file + rename, so a crash, a full
    /// disk or a concurrent reader never sees a half-written source file.
    ///
    /// A rename replaces the inode, so three things a plain in-place write kept
    /// for free are kept explicitly: a symlink is written THROUGH (its target
    /// is replaced, the link survives), a hard-linked file is written in place
    /// (a rename would leave the other names on the old contents — see
    /// `writeInPlace`), and the file's POSIX permissions are restored (a
    /// replaced script must stay executable).
    ///
    /// Throws `WriteError.notWritable` for a file the user cannot write: a
    /// rename only needs the FOLDER writable, so it would silently rewrite a
    /// read-only (0444) file.
    static func write(_ text: String, to url: URL) throws {
        guard let data = text.data(using: .utf8) else { throw WriteError.notUTF8 }
        let target = url.resolvingSymlinksInPath()
        let fm = FileManager.default
        // Only an EXISTING file can be read-only; a new file is governed by
        // its folder, which the write itself checks.
        if fm.fileExists(atPath: target.path), !fm.isWritableFile(atPath: target.path) {
            throw WriteError.notWritable
        }
        let attrs = try? fm.attributesOfItem(atPath: target.path)
        let permissions = attrs?[.posixPermissions]
        let linkCount = (attrs?[.referenceCount] as? NSNumber)?.intValue ?? 1
        if linkCount > 1 {
            try writeInPlace(data, to: target)
        } else {
            try data.write(to: target, options: .atomic)
        }
        if let permissions {
            try? fm.setAttributes([.posixPermissions: permissions], ofItemAtPath: target.path)
        }
    }

    /// In-place write for a hard-linked file, which cannot be renamed over.
    ///
    /// A plain `Data.write(options: [])` truncates FIRST, so a full disk or a
    /// crash mid-write left the file empty or cut short. Instead:
    /// 1. the new bytes go to a temp file beside the target and are fsynced —
    ///    proving the volume can hold the whole new content before the
    ///    original is touched (a failure here leaves it byte-for-byte intact);
    /// 2. the temp file is removed, handing that space back for step 3 (APFS
    ///    is copy-on-write, so overwriting the original needs fresh blocks too);
    /// 3. the original is overwritten from offset 0, THEN truncated to the new
    ///    length and fsynced — it is never shorter than it should be mid-way.
    /// If step 3 still fails, the original bytes are written back best-effort.
    static func writeInPlace(_ data: Data, to target: URL) throws {
        let fm = FileManager.default
        let staging = target.deletingLastPathComponent()
            .appendingPathComponent(".\(target.lastPathComponent).llmide-\(UUID().uuidString).tmp")
        do {
            try data.write(to: staging, options: .withoutOverwriting)
            let handle = try FileHandle(forWritingTo: staging)
            defer { try? handle.close() }
            try handle.synchronize()
        } catch {
            try? fm.removeItem(at: staging)
            throw error
        }
        try? fm.removeItem(at: staging)

        let original = try? Data(contentsOf: target)
        do {
            try overwrite(target, with: data)
        } catch {
            if let original { try? overwrite(target, with: original) }
            throw error
        }
    }

    /// Write `data` over `url` from offset 0, then cut it to `data.count` and
    /// flush to disk. Keeps the inode, so every hard link sees the result.
    private static func overwrite(_ url: URL, with data: Data) throws {
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: data)
        try handle.truncate(atOffset: UInt64(data.count))
        try handle.synchronize()
    }

    /// `write(_:to:)` for callers that only need success / failure.
    static func writeAtomically(_ text: String, to url: URL) -> Bool {
        (try? write(text, to: url)) != nil
    }
}
