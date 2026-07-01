import Foundation

/// Shared path normalisation used by every site that compares or
/// resolves a filesystem path the user supplied (settings, attachments,
/// repo manager, etc.). One canonical form so the agent's emitted
/// `/Users/.../README.md` matches the chat's stored `~/Developer/.../README.md`
/// matches the file tree's resolved-symlink form.
enum PathUtils {
    /// Normalise a path string for comparison.
    /// - Strips a leading `file://` scheme (and percent-decodes the rest).
    /// - Expands a leading `~/` to the current user's home directory.
    /// - Drops trailing slashes (except when the path IS `/`).
    /// - Resolves `.` / `..` components and follows symlinks via
    ///   `URL.standardizedFileURL`.
    ///
    /// Case is intentionally preserved: APFS can be case-sensitive
    /// (rare but real) so lower-casing would create false collisions.
    static func canonicalise(_ raw: String) -> String {
        var p = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.hasPrefix("file://") {
            p = String(p.dropFirst("file://".count))
            p = p.removingPercentEncoding ?? p
        }
        if p.hasPrefix("~/") {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            p = home + String(p.dropFirst(1))
        } else if p == "~" {
            p = FileManager.default.homeDirectoryForCurrentUser.path
        }
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        let url = URL(fileURLWithPath: p).standardizedFileURL
        return url.path
    }
}
