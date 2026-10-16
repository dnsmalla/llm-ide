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
    /// (a rename would leave the other names on the old contents), and the
    /// file's POSIX permissions are restored (a replaced script must stay
    /// executable).
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
        try data.write(to: target, options: linkCount > 1 ? [] : .atomic)
        if let permissions {
            try? fm.setAttributes([.posixPermissions: permissions], ofItemAtPath: target.path)
        }
    }

    /// `write(_:to:)` for callers that only need success / failure.
    static func writeAtomically(_ text: String, to url: URL) -> Bool {
        (try? write(text, to: url)) != nil
    }
}
