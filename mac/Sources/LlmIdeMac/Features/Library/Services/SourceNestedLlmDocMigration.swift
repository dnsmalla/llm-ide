import Foundation
import os.log

/// One-time, idempotent move of generated notes that ended up nested at
/// `<root>/source/llm-doc/` back to the canonical `<root>/llm-doc/`.
///
/// Cause: `EmailSource.fetchAndIngest` used to construct `EmailNoteWriter`
/// with `ctx.root` (the project's `source/` folder) as its `repoRoot`, so
/// `NoteService` computed `notesRoot` as `source/llm-doc/` instead of the
/// project-level `llm-doc/`. Fixed at the call site, but existing on-disk
/// notes need moving so the raw/processed split (`source/` = raw,
/// `llm-doc/` = generated) actually holds for data written before the fix.
///
/// Unlike `SourceFolderMigration.mergeMove` (one directory level, whole-entry
/// skip-if-exists), this recurses: both `source/llm-doc/<type>/YYYY/MM/` and
/// the canonical `llm-doc/<type>/YYYY/MM/` may already contain files (e.g. a
/// type other than email that was never affected, or new correctly-placed
/// notes written after the fix but before this migration runs), so a
/// whole-folder skip would leave old files stranded.
enum SourceNestedLlmDocMigration {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "SourceNestedLlmDocMigration")

    /// `projectRoot` is the project root (NOT `source/`) — the same value
    /// passed to `MeetingNoteWriter`/`EmailNoteWriter` as `repoRoot`.
    @MainActor
    static func run(in projectRoot: URL) {
        let fm = FileManager.default
        let misplaced = projectRoot
            .appendingPathComponent("source", isDirectory: true)
            .appendingPathComponent("llm-doc", isDirectory: true)
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: misplaced.path, isDirectory: &isDir), isDir.boolValue else { return }

        let canonical = projectRoot.appendingPathComponent("llm-doc", isDirectory: true)
        try? fm.createDirectory(at: canonical, withIntermediateDirectories: true)
        mergeRecursive(fm, from: misplaced, to: canonical)

        // Merge (and, on success, remove) index.json BEFORE the final
        // empty-check below — index.json is a top-level regular file sibling
        // to the type folders, so mergeRecursive's own no-clobber rule always
        // leaves it behind (the canonical index.json already exists in the
        // common case). Without this, source/llm-doc/ would never be judged
        // empty and would linger forever, logging a false "collision" below
        // on every launch even when every note file moved successfully.
        let misplacedIndex = misplaced.appendingPathComponent("index.json")
        if mergeIndexes(fm, from: misplacedIndex, into: canonical.appendingPathComponent("index.json")) {
            try? fm.removeItem(at: misplacedIndex)
        }

        // Only remove the misplaced tree if the recursive merge fully
        // drained it (every file moved, no name collisions left behind).
        if isEmptyOfFiles(fm, at: misplaced) {
            try? fm.removeItem(at: misplaced)
            log.info("Migrated source/llm-doc/ → llm-doc/ at \(projectRoot.path, privacy: .public).")
        } else {
            log.info("Partially migrated source/llm-doc/ → llm-doc/ at \(projectRoot.path, privacy: .public); some files left behind due to name collisions.")
        }
    }

    /// Move every entry under `src` into the matching path under `dest`,
    /// recursing into subdirectories that exist on both sides instead of
    /// skipping the whole subtree. A file whose destination already exists
    /// is left in place under `src` (never overwritten, never deleted) —
    /// `index.json` is the expected recurring case, merged separately by
    /// `mergeIndexes` after this returns.
    private static func mergeRecursive(_ fm: FileManager, from src: URL, to dest: URL) {
        let entries = (try? fm.contentsOfDirectory(atPath: src.path)) ?? []
        for name in entries {
            let s = src.appendingPathComponent(name)
            let d = dest.appendingPathComponent(name)
            var sIsDir: ObjCBool = false
            guard fm.fileExists(atPath: s.path, isDirectory: &sIsDir) else { continue }
            if sIsDir.boolValue {
                var dIsDir: ObjCBool = false
                if fm.fileExists(atPath: d.path, isDirectory: &dIsDir), dIsDir.boolValue {
                    mergeRecursive(fm, from: s, to: d)
                    if isEmptyOfFiles(fm, at: s) { try? fm.removeItem(at: s) }
                } else if fm.fileExists(atPath: d.path) {
                    // Destination exists but isn't a directory — leave the
                    // source subtree in place rather than guess.
                    continue
                } else {
                    do {
                        try fm.moveItem(at: s, to: d)
                    } catch {
                        log.error("merge move failed \(s.path, privacy: .public) → \(d.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    }
                }
            } else {
                guard !fm.fileExists(atPath: d.path) else { continue }  // no clobber
                do {
                    try fm.moveItem(at: s, to: d)
                } catch {
                    log.error("merge move failed \(s.path, privacy: .public) → \(d.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    /// True when `dir` contains no regular files anywhere in its subtree
    /// (empty subdirectories don't block cleanup).
    private static func isEmptyOfFiles(_ fm: FileManager, at dir: URL) -> Bool {
        guard let enumerator = fm.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey]) else { return true }
        for case let url as URL in enumerator {
            if (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true { return false }
        }
        return true
    }

    /// Union the misplaced index's note entries into the canonical index,
    /// keyed by `id` (canonical wins on conflict). Both sides store `path`
    /// relative to their OWN repoRoot — `source/llm-doc/…` relative to
    /// `<project>/source/` and `llm-doc/…` relative to `<project>/` both
    /// serialize to the identical string (e.g. "llm-doc/emails/2026/08/x.md"),
    /// since `NoteService.notesRoot` always appends "llm-doc" as the first
    /// component after whatever repoRoot it was given — so no path rewrite
    /// is needed, only a plain union.
    ///
    /// Returns whether it's safe for the caller to delete `misplacedIndex`:
    /// true when there was nothing to merge or the merge was written
    /// successfully; false — leaving the file in place — when the misplaced
    /// index couldn't be decoded, or critically, when a canonical index
    /// EXISTS but failed to decode: overwriting it with a fresh index built
    /// only from the misplaced entries would silently discard every
    /// already-indexed note (sourceHash dedup history included).
    @discardableResult
    private static func mergeIndexes(_ fm: FileManager, from misplacedIndex: URL, into canonicalIndex: URL) -> Bool {
        guard fm.fileExists(atPath: misplacedIndex.path) else { return true }
        guard let misplacedData = try? Data(contentsOf: misplacedIndex) else { return false }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let misplaced = try? decoder.decode(NoteIndex.self, from: misplacedData) else {
            log.error("Could not decode source/llm-doc/index.json — leaving it in place unmerged.")
            return false
        }

        var canonical: NoteIndex
        if fm.fileExists(atPath: canonicalIndex.path) {
            guard let canonicalData = try? Data(contentsOf: canonicalIndex),
                  let decoded = try? decoder.decode(NoteIndex.self, from: canonicalData) else {
                log.error("Could not decode canonical llm-doc/index.json — refusing to merge (would discard its existing entries).")
                return false
            }
            canonical = decoded
        } else {
            canonical = NoteIndex()
        }

        let knownIds = Set(canonical.notes.map(\.id))
        let toAdd = misplaced.notes.filter { !knownIds.contains($0.id) }
        guard !toAdd.isEmpty else { return true }
        canonical.notes.append(contentsOf: toAdd)
        canonical.updated = ISO8601DateFormatter().string(from: Date())

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let merged = try? encoder.encode(canonical) else {
            log.error("Failed to encode merged note index — leaving source/llm-doc/index.json in place.")
            return false
        }
        do {
            try merged.write(to: canonicalIndex, options: .atomic)
        } catch {
            log.error("Failed to write merged note index: \(error.localizedDescription, privacy: .public)")
            return false
        }
        log.info("Merged \(toAdd.count) note-index entries from source/llm-doc/index.json.")
        return true
    }
}
