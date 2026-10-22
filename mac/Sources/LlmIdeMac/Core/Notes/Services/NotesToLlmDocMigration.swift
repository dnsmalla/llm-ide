import Foundation
import os.log

/// One-time, idempotent rename of the legacy `notes/` folder to `llm-doc/`
/// under a given root. The generated-notes folder was renamed from `notes` to
/// `llm-doc`; this moves existing on-disk data so users keep their notes.
///
/// Run at launch for every root that may contain a generated-notes `notes/`
/// folder — the notes/meetings root (`NotesFolderConfig.currentFolder`) and
/// the active project root. Safe to call every launch: it is a no-op once
/// `llm-doc/` exists or when neither folder is present.
enum NotesToLlmDocMigration {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "NotesToLlmDocMigration")

    /// If `<root>/notes` exists and `<root>/llm-doc` does not, rename it.
    /// If both exist, leave `notes/` in place rather than risk clobbering a
    /// newer `llm-doc/`. No-op when neither exists.
    @MainActor
    static func run(in root: URL) {
        let fm = FileManager.default
        let old = root.appendingPathComponent("notes", isDirectory: true)
        let new = root.appendingPathComponent("llm-doc", isDirectory: true)
        guard fm.fileExists(atPath: old.path) else { return }
        if fm.fileExists(atPath: new.path) {
            log.info("Skipping notes→llm-doc migration at \(root.path, privacy: .public): llm-doc/ already exists.")
            return
        }
        do {
            try fm.moveItem(at: old, to: new)
            log.info("Migrated notes/ → llm-doc/ at \(root.path, privacy: .public).")
        } catch {
            log.error("notes→llm-doc migration failed at \(root.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }
}
