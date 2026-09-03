import Foundation

/// Pure path arithmetic for the Explorer tree — no filesystem I/O, no actor
/// isolation, so every rule here is unit-testable without a real directory.
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
    /// This exists because `FileManager.contentsOfDirectory` returns
    /// symlink-resolved URLs while building a child URL with
    /// `appendingPathComponent` does not, so the same logical file can arrive
    /// as two `URL`s that are `==`- and hash-unequal even though `key(_:)`
    /// (a plain string on `standardizedFileURL.path`, no symlink resolution)
    /// says they're the same place. `List(selection:)` matches by raw `URL`
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
        url.resolvingSymlinksInPath().standardizedFileURL
    }
}
