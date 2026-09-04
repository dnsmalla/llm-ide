import Foundation

/// Path arithmetic for the Explorer tree — no actor isolation, so every rule
/// here is unit-testable without a real directory.
///
/// Every function here is pure string work EXCEPT `canonical(_:)`, which
/// resolves symlinks and therefore touches the filesystem. That one is
/// boundary-only; see its own doc comment. Don't restore a blanket "no
/// filesystem I/O" claim to this header — it was true before `canonical(_:)`
/// existed, and a reader who trusts it will call `canonical(_:)` in a hot path.
///
/// `key(_:)` is THE normalizer for this subsystem: `ExplorerTreeStore`'s
/// children cache, its expansion set, its persistence, and its refresh path
/// all key on it. A second normalization anywhere would silently split the
/// cache (`/tmp/a` and `/tmp/a/` becoming two entries for one directory).
enum ExplorerPaths {
    /// Canonical dictionary/set key for a file URL: the standardized POSIX
    /// path, with no trailing slash (`URL.path` never emits one except for
    /// "/"), so a directory URL built with or without `isDirectory: true`
    /// produces the same key.
    static func key(_ url: URL) -> String {
        url.standardizedFileURL.path
    }

    /// `url`'s path relative to `root`: `""` when they are the same
    /// directory, `nil` when `url` is not inside `root`.
    ///
    /// The `+ "/"` on the prefix check is load-bearing: without it
    /// "/tmp/projector" reads as being inside "/tmp/proj", which would let a
    /// drag-and-drop move write into a sibling tree.
    static func relativePath(of url: URL, from root: URL) -> String? {
        let rootKey = key(root)
        let urlKey = key(url)
        if urlKey == rootKey { return "" }
        guard urlKey.hasPrefix(rootKey + "/") else { return nil }
        return String(urlKey.dropFirst(rootKey.count + 1))
    }

    /// True when `url` sits strictly inside `ancestor`. A directory is NOT
    /// its own descendant — the move/copy self-nesting guards depend on that
    /// strictness to reject "move a folder into itself" while still allowing
    /// "move a file back into the folder it already lives in" (a no-op).
    static func isDescendant(_ url: URL, of ancestor: URL) -> Bool {
        guard let rel = relativePath(of: url, from: ancestor) else { return false }
        return !rel.isEmpty
    }

    /// The `SearchView` "files to include" glob that scopes a search to
    /// `folder`. `nil` when `folder` is outside `root` — Search walks from
    /// `root`, so a folder outside it can never be reached by narrowing the
    /// glob, and the caller must disable the menu item rather than run a
    /// search that silently returns nothing.
    ///
    /// A bare directory prefix is exactly what `GlobMatch.matches` treats as
    /// a prefix match (it has no `*?[` metacharacters), so "app/job/" scopes
    /// to that subtree without needing `app/job/**`.
    static func includeGlob(for folder: URL, root: URL) -> String? {
        guard let rel = relativePath(of: folder, from: root) else { return nil }
        if rel.isEmpty { return "" }   // the root itself → search everything
        return rel.hasSuffix("/") ? rel : rel + "/"
    }

    /// A single, filesystem-resolved form of `url` that two different-looking
    /// spellings of the same file — e.g. macOS's `/tmp` vs. `/private/tmp`,
    /// or `/var` vs. `/private/var` — both collapse to (verified by probe:
    /// `URL.standardizedFileURL` actually folds toward the shorter symlinked
    /// spelling here, not the other way around — `stringByStandardizingPath`
    /// special-cases exactly this — so treat the EQUALITY across spellings as
    /// the contract, never a specific winning literal). Unlike every other
    /// function in this type, this one touches the filesystem
    /// (`resolvingSymlinksInPath()` is a syscall), so it is for BOUNDARY use
    /// only — normalizing a URL once as it *enters* the store (a path typed
    /// by the user, a persisted bookmark being restored, a reveal-a-file
    /// request) — never for per-render work in a hot path.
    ///
    /// The result is a full `URL` identity, not merely a path match: two
    /// spellings compare `==` AND hash-equal, so the result is safe to put
    /// straight into a `Set<URL>` selection or compare against a row's `URL`.
    /// Getting there needs the directory hint normalized as well as the path.
    /// A `URL` carries a "is this a directory" flag (the trailing slash), and
    /// `resolvingSymlinksInPath`/`standardizedFileURL` PRESERVE whatever the
    /// input had — so a folder URL built by `appendingPathComponent` before
    /// that folder existed stays hint-less, while the same folder listed by
    /// `contentsOfDirectory` comes back hinted, and the two are `==`-unequal
    /// despite identical `.path`. Measured, that is exactly how a
    /// just-created folder fails to select itself. So the hint is re-derived
    /// from the filesystem here. For a path that does NOT exist there is
    /// nothing to ask, so this function leaves the hint alone — but do not read
    /// that as "the hint survives": `standardizedFileURL` may already have
    /// dropped it before this point (it does under `/var/folders`). The
    /// guarantee for a non-existent path is only that the result is exactly
    /// what the previous, hint-preserving `canonical` returned.
    ///
    /// This exists because `FileManager.contentsOfDirectory` returns
    /// symlink-resolved URLs while building a child URL with
    /// `appendingPathComponent` does not, so the same logical file can arrive
    /// as two `URL`s that are `==`- and hash-unequal even though `key(_:)`
    /// says they're the same place. (`key(_:)` reads
    /// `standardizedFileURL.path`, which does NOT chase symlinks in general —
    /// it only applies Foundation's documented `/private` special case — so it
    /// bridges these two spellings without being a general resolver.) `List(selection:)` matches by raw `URL`
    /// hashing, so a selection URL that didn't come straight from a `Row`
    /// would silently fail to select without this.
    ///
    /// Deliberately NOT folded into `key(_:)`: `key(_:)` is the identity that
    /// `flatten` and Task 5's persistence are built against today, and this
    /// function's filesystem I/O would also make every `key(_:)` call sites'
    /// "no I/O" assumption false. Use `canonical(_:)` at the boundary, then
    /// pass the result through `key(_:)`/`relativePath`/`isDescendant` as
    /// usual.
    static func canonical(_ url: URL) -> URL {
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDirectory) else {
            return resolved
        }
        return URL(fileURLWithPath: resolved.path, isDirectory: isDirectory.boolValue)
    }
}
