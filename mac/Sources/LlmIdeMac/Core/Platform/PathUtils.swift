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
    /// - Resolves `.` / `..` components via `URL.standardizedFileURL`.
    ///   This is purely lexical: it does NOT follow symlinks. Use
    ///   `resolvingSymlinks(_:)` when a security decision (containment)
    ///   depends on where the path really lands.
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

    /// `canonicalise` plus symlink resolution, valid for paths that do not
    /// exist yet: the deepest existing ancestor is resolved and the missing
    /// tail re-appended. A dangling symlink is followed manually, because a
    /// write through one would create its target outside the tree.
    ///
    /// WHY: containment checks must compare where a write really lands. A
    /// lexical prefix check passes `repo/link/x` even when `link -> /etc`.
    /// Apply this to BOTH the root and the target — a root under a symlinked
    /// path (`/var` -> `/private/var`) otherwise never matches.
    static func resolvingSymlinks(_ raw: String) -> String {
        var pending = canonicalise(raw)
        // Bounded so a symlink loop cannot spin forever.
        for _ in 0..<40 {
            var existing = URL(fileURLWithPath: pending)
            var tail: [String] = []
            while existing.path != "/", !lexists(existing.path) {
                tail.insert(existing.lastPathComponent, at: 0)
                existing.deleteLastPathComponent()
            }
            let suffix = tail.isEmpty ? "" : "/" + tail.joined(separator: "/")
            if let real = realPath(existing.path) {
                // NOT through `canonicalise`: standardizedFileURL strips `/private`
                // for existing paths but not for missing ones, so the result
                // would depend on whether the file exists yet. `suffix` is already
                // `..`-free (normalised by the lexical pass above).
                return (real == "/" ? "" : real) + suffix
            }
            // realpath failed on something that exists: a dangling symlink.
            guard let dest = try? FileManager.default.destinationOfSymbolicLink(atPath: existing.path),
                  let parent = realPath(existing.deletingLastPathComponent().path) else {
                return pending
            }
            let target = dest.hasPrefix("/") ? dest : parent + "/" + dest
            pending = lexicallyNormalised(target + suffix)
        }
        return pending
    }

    /// Collapses `.` / `..` and duplicate slashes by hand (absolute paths only),
    /// without the `/private` stripping `standardizedFileURL` applies.
    private static func lexicallyNormalised(_ path: String) -> String {
        var parts: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if !parts.isEmpty { parts.removeLast() }
                continue
            }
            parts.append(part)
        }
        return "/" + parts.joined(separator: "/")
    }

    /// `lstat`-based existence: true for a dangling symlink too.
    private static func lexists(_ path: String) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: path)) != nil
    }

    private static func realPath(_ path: String) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(path, &buffer) != nil else { return nil }
        return String(cString: buffer)
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
