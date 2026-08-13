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

    /// Shorten an absolute path under the user's home directory to a
    /// `~/`-prefixed display form; returns `raw` unchanged otherwise.
    /// The inverse of `canonicalise`'s `~/` expansion.
    static func homeRelative(_ raw: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if raw.hasPrefix(home) { return "~" + raw.dropFirst(home.count) }
        return raw
    }

    /// Rewrites `raw` relative to `root` when it lies under it — e.g. a path
    /// picked via `NSOpenPanel` scoped to a project's root — so what's stored
    /// stays portable: the same project reopened from a different absolute
    /// location, or a saved template applied to a different project, still
    /// resolves the same relative location instead of a frozen, machine-specific
    /// absolute path. Falls back to the canonicalised absolute path when `raw`
    /// does not lie under `root`.
    ///
    /// Both sides are symlink-resolved before comparing — `canonicalise` alone
    /// does not do this (`URL.standardizedFileURL` only collapses `.`/`..`),
    /// so a project rooted at a symlinked path (e.g. macOS's `/tmp` →
    /// `/private/tmp`) would otherwise never match and always fall back to
    /// the absolute path.
    static func relative(_ raw: String, to root: URL) -> String {
        let rootPath = URL(fileURLWithPath: canonicalise(root.path)).resolvingSymlinksInPath().path
        let path = URL(fileURLWithPath: canonicalise(raw)).resolvingSymlinksInPath().path
        if path == rootPath { return "." }
        guard path.hasPrefix(rootPath + "/") else { return path }
        return String(path.dropFirst(rootPath.count + 1))
    }
}
