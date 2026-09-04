import Foundation

/// Surfaced name/fs failures from Explorer file operations. Inline-able in the
/// name sheet; mapped to a user-facing string via `errorDescription`.
enum ExplorerFileError: LocalizedError, Equatable {
    case emptyName
    case invalidName
    /// A name carrying a line break anywhere inside it. Its own case rather
    /// than `invalidName` because that error's sentence names "/" and "." and
    /// would send the user hunting for a slash that isn't there. Reachable by
    /// pasting a wrapped line into the rename field or a name sheet.
    case nameHasLineBreak
    case alreadyExists
    case writeFailed
    /// Dropping/pasting a folder into itself or into one of its own
    /// descendants. `FileManager.moveItem` would either fail with an opaque
    /// Cocoa error or (for a copy) recurse forever, so this is caught first.
    case cannotMoveIntoSelf
    /// A dragged, cut or copied source that no longer exists by the time the
    /// operation is applied — deleted, renamed, or moved by another app
    /// between the ⌘X and the ⌘V. Carries the item's name so the alert can
    /// say WHICH one; `FileManager` would otherwise surface a raw Cocoa
    /// sentence ("… couldn't be moved … because either the former doesn't
    /// exist, or the folder containing the latter doesn't exist") that names
    /// two possible causes and helps with neither.
    case sourceMissing(String)

    var errorDescription: String? {
        switch self {
        case .emptyName: return "Name can't be empty."
        case .invalidName: return "Name can't contain \"/\" or be \".\" or \"..\"."
        case .nameHasLineBreak: return "Names can't contain line breaks."
        case .alreadyExists: return "An item with this name already exists."
        case .writeFailed: return "Couldn't create the item."
        case .cannotMoveIntoSelf: return "Can't move a folder into itself."
        case .sourceMissing(let name): return "“\(name)” no longer exists."
        }
    }
}

/// Stateless mutating file operations for the Explorer tree. All paths are
/// validated and existence-checked here so the view can stay declarative and
/// the logic is testable without UI. Delete uses `trashItem` (Finder Trash,
/// undoable) — never `removeItem`.
enum ExplorerFileOps {
    /// Throws if `name` is empty/whitespace, carries a line break, contains
    /// "/", or is "." / "..".
    ///
    /// The line-break rule is not covered by the trim above it: trimming takes
    /// whitespace and newlines off the ENDS, so an interior one ("x⏎y.txt",
    /// reachable by pasting a wrapped line into a name sheet) survives it and
    /// reaches `createFile`/`moveItem`, producing a filename that tears in two
    /// everywhere this project treats one line as one record.
    ///
    /// Tested with `\.isNewline` rather than `contains("\n")`: Swift treats
    /// "\r\n" as ONE Character, so a literal check misses CRLF outright, along
    /// with a lone CR and U+2028.
    private static func validate(_ name: String) throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ExplorerFileError.emptyName }
        guard !trimmed.contains(where: \.isNewline) else {
            throw ExplorerFileError.nameHasLineBreak
        }
        guard trimmed != ".", trimmed != "..", !trimmed.contains("/") else {
            throw ExplorerFileError.invalidName
        }
        return trimmed
    }

    @discardableResult
    static func createFile(in dir: URL, name: String) throws -> URL {
        let trimmed = try validate(name)
        let url = dir.appendingPathComponent(trimmed)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw ExplorerFileError.alreadyExists }
        guard FileManager.default.createFile(atPath: url.path, contents: Data(), attributes: nil) else {
            throw ExplorerFileError.writeFailed
        }
        return url
    }

    @discardableResult
    static func createFolder(in dir: URL, name: String) throws -> URL {
        let trimmed = try validate(name)
        let url = dir.appendingPathComponent(trimmed)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw ExplorerFileError.alreadyExists }
        do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) }
        catch { throw ExplorerFileError.writeFailed }
        return url
    }

    /// Rename `url` to `newName` (same parent). Returns the new URL. No-op
    /// (returns the original) when the name is unchanged.
    ///
    /// A CASE-ONLY rename (`Foo.swift` → `foo.swift`) is routed through a
    /// two-step move. On the default case-insensitive APFS volume the source
    /// and the destination are the SAME directory entry, so the `fileExists`
    /// collision check below sees the file's own self and throws
    /// `.alreadyExists` — "An item with this name already exists.", which is
    /// flatly wrong when the only item in the way is the file being renamed.
    /// Case-fixing a filename is routine (and F2 makes it one keystroke), so
    /// this cannot be left to the user to work around by renaming twice.
    ///
    /// The same-place test is `realWorldKey`, the fs-aware key the move/copy
    /// guards already use — not a raw `lowercased()` comparison — so the
    /// question asked is the one that matters: "do these two names denote the
    /// same entry on THIS volume?" On a genuinely case-sensitive volume
    /// `isCaseInsensitiveVolume` is false, the branch is skipped, and the
    /// ordinary path handles it correctly (there `foo.swift` really is a
    /// different, free name).
    ///
    /// Everything else still goes down the ordinary path, so a rename onto a
    /// DIFFERENT existing name is still refused with the victim intact —
    /// including `Foo.swift` → `Bar.swift` where `bar.swift` exists, which
    /// differs from the case-only shape precisely because the destination
    /// resolves somewhere the source does not.
    @discardableResult
    static func rename(_ url: URL, to newName: String) throws -> URL {
        let trimmed = try validate(newName)
        let parent = url.deletingLastPathComponent()
        let dest = parent.appendingPathComponent(trimmed)
        if dest == url { return url }

        if isCaseInsensitiveVolume(url),
           realWorldKey(url, caseInsensitive: true) == realWorldKey(dest, caseInsensitive: true) {
            return try renameChangingCaseOnly(url, to: dest, in: parent)
        }

        guard !FileManager.default.fileExists(atPath: dest.path) else { throw ExplorerFileError.alreadyExists }
        try FileManager.default.moveItem(at: url, to: dest)
        return dest
    }

    /// The two-step half of `rename` for a case-only change: move the item to
    /// a unique staging name in its OWN directory, then move it to the final
    /// name, which is now genuinely free. Same-directory moves are `rename(2)`
    /// — atomic, no copy, and no risk of a partially-written file.
    ///
    /// Staging is dot-prefixed and UUID-named so it is both hidden and
    /// collision-proof; `uniqueDestination` covers the astronomically
    /// unlikely rest. If the second move fails the first is undone, so a
    /// failure leaves the item under its ORIGINAL name rather than stranded
    /// under a hidden UUID the user would never find. The underlying error is
    /// then rethrown as-is: at this point it is a real filesystem failure, and
    /// `.writeFailed` ("Couldn't create the item.") would misdescribe it.
    private static func renameChangingCaseOnly(_ url: URL, to dest: URL, in parent: URL) throws -> URL {
        let fm = FileManager.default
        let staging = uniqueDestination(in: parent, name: "." + UUID().uuidString)
        try fm.moveItem(at: url, to: staging)
        do {
            try fm.moveItem(at: staging, to: dest)
        } catch {
            try? fm.moveItem(at: staging, to: url)
            throw error
        }
        return dest
    }

    /// Move `url` (file or folder, recursively) to the Trash.
    static func trash(_ url: URL) throws {
        var result: NSURL?
        try FileManager.default.trashItem(at: url, resultingItemURL: &result)
    }

    /// True when the volume containing `url` cannot tell two differently-cased
    /// names apart — the default for every macOS/APFS system volume. Fails
    /// SAFE (returns `true`, the more paranoid answer) when the resource
    /// value can't be read, e.g. `url` doesn't exist yet: folding case
    /// unnecessarily costs nothing here, but failing to fold it on an
    /// actually-case-insensitive volume is how F2 (below) slips through.
    private static func isCaseInsensitiveVolume(_ url: URL) -> Bool {
        guard let supportsCaseSensitiveNames = try? url.resourceValues(
            forKeys: [.volumeSupportsCaseSensitiveNamesKey]
        ).volumeSupportsCaseSensitiveNames else {
            return true
        }
        return !supportsCaseSensitiveNames
    }

    /// A filesystem-AWARE identity key, used ONLY by the move/copy
    /// destructive-operation guards below — deliberately separate from
    /// `ExplorerPaths.key`, which stays a pure string on purpose:
    /// `ExplorerTreeStore`'s caches and Task 5's on-disk persistence are keyed
    /// on `ExplorerPaths.key`'s exact current semantics, and changing what it
    /// considers "the same path" would silently reshuffle that state out from
    /// under code being built against it right now.
    ///
    /// This key resolves symlinks (`.resolvingSymlinksInPath()`) and, on a
    /// case-insensitive volume, folds case — two real ways a destination that
    /// *looks* different from the source is actually the very same directory
    /// or one of its descendants on disk. Do not merge this back into
    /// `ExplorerPaths.key`: the two answer different questions ("same string
    /// identity for cache/persistence purposes" vs. "same real place on disk
    /// for a destructive-operation safety check") and conflating them would
    /// re-open the gap this fixes.
    private static func realWorldKey(_ url: URL, caseInsensitive: Bool) -> String {
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
        return caseInsensitive ? resolved.lowercased() : resolved
    }

    /// `isDescendant`, but on `realWorldKey`s — see that function's doc for
    /// why this can't just call `ExplorerPaths.isDescendant`. Strict like its
    /// counterpart: a directory is not its own descendant.
    private static func isReallyDescendant(_ url: URL, of ancestor: URL, caseInsensitive: Bool) -> Bool {
        let ancestorKey = realWorldKey(ancestor, caseInsensitive: caseInsensitive)
        let urlKey = realWorldKey(url, caseInsensitive: caseInsensitive)
        if urlKey == ancestorKey { return false }
        return urlKey.hasPrefix(ancestorKey + "/")
    }

    /// True when `url` names something on disk — a file, a folder, or a
    /// BROKEN SYMLINK.
    ///
    /// `attributesOfItem` lstats, so unlike `FileManager.fileExists(atPath:)`
    /// it does not answer false for a symlink whose target has gone. Such a
    /// link is a real item the user can see in the tree and is entitled to
    /// move; treating it as "already vanished" would silently skip it and
    /// leave it behind after a cut.
    static func itemExists(_ url: URL) -> Bool {
        (try? FileManager.default.attributesOfItem(atPath: url.path)) != nil
    }

    /// Guard shared by `move` and `copy`: rejects "into itself" and "into my
    /// own descendant" before any filesystem call.
    ///
    /// Compares `realWorldKey`s, not `ExplorerPaths.key`s: a naive string
    /// comparison is bypassed by a symlinked `destinationDir` that resolves
    /// inside `source`, or by a differently-cased path to the same directory
    /// on the default case-insensitive APFS volume — both let a self-nesting
    /// move/copy slip past this check and reach `FileManager`, which either
    /// surfaces a raw `EINVAL` (same-volume `rename(2)`) instead of this
    /// type's friendly error, or — cross-volume, where `FileManager` falls
    /// back to a recursive copy+delete instead of `rename(2)` — has no kernel
    /// backstop at all, so the copy can recurse straight into the very
    /// subtree it's deleting out from under itself.
    ///
    /// Folds case whenever EITHER `source`'s or `destinationDir`'s volume is
    /// case-insensitive, not just one — a paranoid-but-correct choice: two
    /// paths can only be a containment risk for each other if they name the
    /// same underlying location, and case-folding when either side *could*
    /// treat that case difference as identical is strictly safer than
    /// case-folding only when both agree.
    private static func assertNotSelfNesting(source: URL, destinationDir: URL) throws {
        let caseInsensitive = isCaseInsensitiveVolume(source) || isCaseInsensitiveVolume(destinationDir)
        if realWorldKey(source, caseInsensitive: caseInsensitive)
            == realWorldKey(destinationDir, caseInsensitive: caseInsensitive) {
            throw ExplorerFileError.cannotMoveIntoSelf
        }
        if isReallyDescendant(destinationDir, of: source, caseInsensitive: caseInsensitive) {
            throw ExplorerFileError.cannotMoveIntoSelf
        }
    }

    /// Move `source` INTO the directory `destinationDir`, keeping its name.
    /// Returns the new URL.
    ///
    /// Never overwrites: a name collision throws `.alreadyExists` rather than
    /// silently destroying the destination file (unlike copy, which
    /// auto-uniquifies — a drag that clobbers a file is a data-loss bug, a
    /// drag that produces "x copy.txt" is Finder behavior).
    ///
    /// Moving into the directory the item already lives in is a no-op that
    /// returns the original URL — a drag that lands where it started must not
    /// throw at the user. Compared via `realWorldKey`, same as the
    /// self-nesting guard above: without that, referencing the same parent
    /// through a differently-cased path falls through to the `fileExists`
    /// check below and throws `.alreadyExists` for what is really a no-op.
    @discardableResult
    static func move(from source: URL, to destinationDir: URL) throws -> URL {
        guard itemExists(source) else {
            throw ExplorerFileError.sourceMissing(source.lastPathComponent)
        }
        try assertNotSelfNesting(source: source, destinationDir: destinationDir)
        let dest = destinationDir.appendingPathComponent(source.lastPathComponent)
        let caseInsensitive = isCaseInsensitiveVolume(source) || isCaseInsensitiveVolume(destinationDir)
        if realWorldKey(dest, caseInsensitive: caseInsensitive)
            == realWorldKey(source, caseInsensitive: caseInsensitive) {
            return source
        }
        guard !FileManager.default.fileExists(atPath: dest.path) else {
            throw ExplorerFileError.alreadyExists
        }
        try FileManager.default.moveItem(at: source, to: dest)
        return dest
    }

    /// Copy `source` INTO the directory `destinationDir`, auto-uniquifying the
    /// name Finder-style on collision. Returns the new URL.
    @discardableResult
    static func copy(from source: URL, to destinationDir: URL) throws -> URL {
        guard itemExists(source) else {
            throw ExplorerFileError.sourceMissing(source.lastPathComponent)
        }
        try assertNotSelfNesting(source: source, destinationDir: destinationDir)
        let dest = uniqueDestination(in: destinationDir, name: source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: dest)
        return dest
    }

    /// Apply a clipboard paste into `dir`: move each item when `shouldMove`
    /// (a cut), copy it otherwise. Returns the resulting URLs in input order.
    ///
    /// Adds NO containment check of its own — `move`/`copy` already reject
    /// self-nesting through `assertNotSelfNesting`, and a second, weaker
    /// string-level check here would only be able to disagree with them.
    ///
    /// A source that VANISHED between the cut/copy and the paste (deleted, or
    /// moved by another app) is skipped and the loop continues. One stale
    /// clipboard entry must not block every valid item behind it — otherwise
    /// the clipboard wedges: the paste fails, so nothing is consumed, so the
    /// next ⌘V fails identically, forever, until the user re-selects.
    ///
    /// Any OTHER failure — a name collision, a self-nesting drop — stops at
    /// the first one and rethrows; the items already processed stay processed.
    /// That is deliberate: rolling back a partially-applied move is itself a
    /// destructive operation, and the caller remaps per item so a partial
    /// result is never hidden.
    ///
    /// Vanished sources are fatal only when NOTHING could be applied — the
    /// single-item case, where silently doing nothing would look like a broken
    /// ⌘V. Then the throw names the missing item.
    @discardableResult
    static func paste(_ urls: [URL], into dir: URL, move shouldMove: Bool) throws -> [URL] {
        var results: [URL] = []
        var missing: [String] = []
        for url in urls {
            guard itemExists(url) else {
                missing.append(url.lastPathComponent)
                continue
            }
            if shouldMove {
                results.append(try move(from: url, to: dir))
            } else {
                results.append(try copy(from: url, to: dir))
            }
        }
        if results.isEmpty, let first = missing.first {
            throw ExplorerFileError.sourceMissing(first)
        }
        return results
    }

    /// A free URL for `name` inside `dir`, following Finder's naming:
    /// `a.txt` → `a copy.txt` → `a copy 2.txt` → `a copy 3.txt`. The base name
    /// and extension are split with `deletingPathExtension`/`pathExtension`
    /// so a dotted directory name (`my.notes`) keeps its suffix intact.
    ///
    /// The loop is bounded: after 1000 attempts it falls back to a UUID
    /// suffix rather than spinning forever on a pathological directory.
    static func uniqueDestination(in dir: URL, name: String) -> URL {
        let fm = FileManager.default
        let first = dir.appendingPathComponent(name)
        guard fm.fileExists(atPath: first.path) else { return first }

        let asURL = URL(fileURLWithPath: name)
        let ext = asURL.pathExtension
        let base = asURL.deletingPathExtension().lastPathComponent

        func candidate(_ suffix: String) -> URL {
            let stem = base + suffix
            return ext.isEmpty
                ? dir.appendingPathComponent(stem)
                : dir.appendingPathComponent(stem + "." + ext)
        }

        let plainCopy = candidate(" copy")
        if !fm.fileExists(atPath: plainCopy.path) { return plainCopy }
        for n in 2...1000 {
            let url = candidate(" copy \(n)")
            if !fm.fileExists(atPath: url.path) { return url }
        }
        return candidate(" copy \(UUID().uuidString)")
    }
}
