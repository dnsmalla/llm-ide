import Foundation

/// D6: the Loop's machine data moves from `llm-doc/loop/` to `system/loop/`.
///
/// `llm-doc/` holds human-readable notes only. The five JSON files below are
/// computed or read back by the loops (the test ledger, the test map and
/// structure, the refactor graph snapshots), so they belong with the other
/// machine state under `system/`. Their `.md` siblings stay in `llm-doc/loop/`.
///
/// **N-1 rules.**
/// - Readers prefer the new file and fall back to the legacy one while the new
///   file is missing (`resolve`), so a project not yet migrated still reads.
/// - Writers always write the new file, then `retireLegacy` removes the legacy
///   copy that the new one supersedes.
/// - `perform` moves a legacy file only when the new one is absent. It writes
///   the new file, reads it back byte for byte, and only then removes the
///   legacy file. It never overwrites an existing new file, never follows a
///   link, and does nothing on a second run (idempotent).
public enum LoopDataMigration {
    public typealias Entry = (legacy: String, current: String)

    /// Every machine-data file, as (legacy path, new path), both relative to the repo root.
    public static let entries: [Entry] = [
        (LoopOutputLayout.Legacy.testLedger, LoopOutputLayout.testLedger),
        (LoopOutputLayout.Legacy.testMapJSON, LoopOutputLayout.testMapJSON),
        (LoopOutputLayout.Legacy.testStructureJSON, LoopOutputLayout.testStructureJSON),
        (LoopOutputLayout.Legacy.refactorGraphBefore, LoopOutputLayout.refactorGraphBefore),
        (LoopOutputLayout.Legacy.refactorGraphAfter, LoopOutputLayout.refactorGraphAfter),
    ]

    public enum Outcome: Equatable {
        case moved
        /// The legacy file is absent: nothing was generated there (or it already moved).
        case nothingToMove
        /// The new file already exists; the legacy copy is left in place.
        case destinationExists
        case refused(String)
        case failed(String)
    }

    /// The file a reader should use. The new location wins when it is a regular
    /// file that `isValid` accepts. When it is present but corrupt and a valid
    /// legacy file exists, the legacy file is used instead and the corrupt new
    /// file is renamed to `<name>.corrupt-<stamp>` (never silently overwritten),
    /// so the legacy history survives. With neither valid, the new location is
    /// returned and the reader reports what it finds.
    public static func resolve(legacy: String, current: String, gitRoot: URL,
                               isValid: (Data) -> Bool = { _ in true },
                               fileManager fm: FileManager = .default) -> URL {
        let newURL = gitRoot.appendingPathComponent(current)
        let legacyURL = gitRoot.appendingPathComponent(legacy)
        let newType = fileType(newURL, fm)
        if newType == .typeRegular {
            if let data = try? Data(contentsOf: newURL), isValid(data) { return newURL }
            guard fileType(legacyURL, fm) == .typeRegular,
                  let legacyData = try? Data(contentsOf: legacyURL), isValid(legacyData) else { return newURL }
            quarantine(newURL, fileManager: fm)
            return legacyURL
        }
        if newType != nil { return newURL }
        return fileType(legacyURL, fm) == .typeRegular ? legacyURL : newURL
    }

    /// Renames a corrupt machine-data file aside as `<name>.corrupt-<stamp>`.
    private static func quarantine(_ url: URL, fileManager fm: FileManager) {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let dest = url.deletingLastPathComponent().appendingPathComponent("\(url.lastPathComponent).corrupt-\(stamp)")
        try? fm.moveItem(at: url, to: dest)
    }

    /// Removes the legacy copy once the new file has been written. Only when the
    /// new file really exists, so a failed write never strands the user's data.
    public static func retireLegacy(legacy: String, current: String, gitRoot: URL,
                                    fileManager fm: FileManager = .default) {
        let newURL = gitRoot.appendingPathComponent(current)
        let legacyURL = gitRoot.appendingPathComponent(legacy)
        guard fileType(newURL, fm) == .typeRegular, fileType(legacyURL, fm) == .typeRegular else { return }
        try? fm.removeItem(at: legacyURL)
        // Drop a directory the move left empty (e.g. `refactor/graph/`); rmdir
        // refuses a non-empty one, so a sibling file is never touched.
        _ = rmdir(legacyURL.deletingLastPathComponent().path)
    }

    /// Moves every legacy machine-data file under `gitRoot`. Never throws.
    public static func perform(gitRoot: URL, fileManager fm: FileManager = .default) -> [(legacy: String, outcome: Outcome)] {
        entries.map { entry in
            (entry.legacy, move(entry, gitRoot: gitRoot, fm: fm))
        }
    }

    private static func move(_ entry: Entry, gitRoot: URL, fm: FileManager) -> Outcome {
        let legacyURL = gitRoot.appendingPathComponent(entry.legacy)
        let newURL = gitRoot.appendingPathComponent(entry.current)
        guard let legacyType = fileType(legacyURL, fm) else { return .nothingToMove }
        if legacyType == .typeSymbolicLink { return .refused("the legacy file is a symbolic link") }
        guard legacyType == .typeRegular else { return .refused("the legacy path is not a regular file") }
        if fileType(newURL, fm) != nil { return .destinationExists }
        do {
            let data = try Data(contentsOf: legacyURL)
            try fm.createDirectory(at: newURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: newURL, options: .atomic)
            // Verify the copy before the original is removed.
            guard let written = try? Data(contentsOf: newURL), written == data else {
                return .failed("the new file did not read back identical; legacy file kept")
            }
            try fm.removeItem(at: legacyURL)
            _ = rmdir(legacyURL.deletingLastPathComponent().path)
            return .moved
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// The item's type WITHOUT following a symbolic link, or nil when it does not exist.
    private static func fileType(_ url: URL, _ fm: FileManager) -> FileAttributeType? {
        (try? fm.attributesOfItem(atPath: url.path))?[.type] as? FileAttributeType
    }
}
