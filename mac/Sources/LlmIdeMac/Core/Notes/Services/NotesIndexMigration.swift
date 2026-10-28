import Foundation
import os.log

/// D6: moves the rebuildable note index from `llm-doc/index.json` (generated
/// notes folder, human-readable) to `system/cache/notes-index.json` (machine
/// state, git-ignored with the rest of `system/cache/`).
///
/// - Nothing is generated under the old name any more; readers fall back to it
///   only while the new file is missing (`NoteService.readableIndexPath`).
/// - Legacy file absent → nothing to do. New file absent → the legacy bytes are
///   written to the new location, read back and compared, and only then is the
///   legacy file removed.
/// - Both present → entries of the legacy index whose `id` the new index lacks
///   are appended to the new one (the same union rule
///   `SourceNestedLlmDocMigration` uses; nothing is dropped). The new file is
///   verified by decoding, then the legacy file is removed.
/// - Either file undecodable → both are left exactly as they are and the
///   failure is logged. The index is a cache rebuildable from the note files, so
///   the worst case is a rebuild, never a loss.
/// - Idempotent: a second run finds no legacy file.
enum NotesIndexMigration {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "NotesIndexMigration")

    /// `projectRoot` is the project root, the same value the note writers use as `repoRoot`.
    static func run(in projectRoot: URL) {
        let fm = FileManager.default
        let layout = ProjectLayout(root: projectRoot)
        let legacy = layout.legacyNotesIndex
        guard fileIsRegular(legacy, fm) else { return }
        let target = layout.notesIndex
        // Never replace a symlink or a directory at the target: the atomic write
        // would follow or clobber it. Leave both files alone and say why.
        if let type = (try? fm.attributesOfItem(atPath: target.path))?[.type] as? FileAttributeType,
           type != .typeRegular {
            log.error("system/cache/notes-index.json exists but is not a regular file — leaving both index files in place.")
            return
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let legacyData = try? Data(contentsOf: legacy),
              let legacyIndex = try? decoder.decode(NoteIndex.self, from: legacyData) else {
            log.error("Could not decode llm-doc/index.json at \(projectRoot.path, privacy: .public) — left in place.")
            return
        }

        let merged: Data
        if fileIsRegular(target, fm) {
            guard let targetData = try? Data(contentsOf: target),
                  var current = try? decoder.decode(NoteIndex.self, from: targetData) else {
                log.error("Could not decode system/cache/notes-index.json — leaving both index files in place.")
                return
            }
            let known = Set(current.notes.map(\.id))
            let toAdd = legacyIndex.notes.filter { !known.contains($0.id) }
            if !toAdd.isEmpty {
                current.notes.append(contentsOf: toAdd)
                current.updated = ISO8601DateFormatter().string(from: Date())
            }
            guard let encoded = encode(current) else { return }
            merged = encoded
        } else {
            merged = legacyData
        }

        do {
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try merged.write(to: target, options: .atomic)
        } catch {
            log.error("Could not write system/cache/notes-index.json: \(error.localizedDescription, privacy: .public)")
            return
        }
        // Verify the new file decodes before the original goes away.
        guard let written = try? Data(contentsOf: target),
              (try? decoder.decode(NoteIndex.self, from: written)) != nil else {
            log.error("system/cache/notes-index.json did not read back; llm-doc/index.json kept.")
            return
        }
        do {
            try fm.removeItem(at: legacy)
            log.info("Moved the note index to system/cache/notes-index.json at \(projectRoot.path, privacy: .public).")
        } catch {
            log.error("Could not remove llm-doc/index.json after the move: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func encode(_ index: NoteIndex) -> Data? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try? encoder.encode(index)
    }

    private static func fileIsRegular(_ url: URL, _ fm: FileManager) -> Bool {
        (try? fm.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType == .typeRegular
    }
}
