import Foundation
import os.log

/// One-time, idempotent move of legacy raw-source folders into the canonical
/// `source/<type>/` layout. Runs at launch on the source root (which
/// `ProjectStore.openFolder` binds to `<project>/source/`). Move-only — never
/// clobbers an existing destination entry; on conflict the legacy entry is left
/// in place rather than overwritten or deleted.
///
/// Moves:
///   <root>/EmailInbox/            → <root>/emails/
///   <root>/<inboxFolder>/         → <root>/<noteType.directoryName>/   (per connector)
///   <root>/<4-digit-year>/        → <root>/meetings/<year>/            (flat meeting raw)
enum SourceFolderMigration {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "SourceFolderMigration")

    /// Merge-move every legacy raw folder under `sourceRoot` into its canonical
    /// `source/<type>/` location. `connectors` is injected so tests can drive the
    /// connector mapping without bundled resources; production passes
    /// `SourceConnectorManifest.loadBundled()`.
    @MainActor
    static func run(in sourceRoot: URL,
                    connectors: [SourceConnectorManifest] = SourceConnectorManifest.loadBundled()) {
        let fm = FileManager.default

        // 1. Email
        mergeMove(fm,
                  from: sourceRoot.appendingPathComponent("EmailInbox", isDirectory: true),
                  to:   sourceRoot.appendingPathComponent(NoteType.email.directoryName, isDirectory: true))

        // 2. Each connector: <inboxFolder>/ → <noteType.directoryName>/
        for m in connectors {
            mergeMove(fm,
                      from: sourceRoot.appendingPathComponent(m.inboxFolder, isDirectory: true),
                      to:   sourceRoot.appendingPathComponent(NoteType(m.noteType).directoryName, isDirectory: true))
        }

        // 3. Flat meeting raw: top-level 4-digit year dirs → meetings/<year>/
        let meetings = sourceRoot.appendingPathComponent("meetings", isDirectory: true)
        let entries = (try? fm.contentsOfDirectory(atPath: sourceRoot.path)) ?? []
        for name in entries {
            if name.count == 4, name.allSatisfy(\.isNumber) {
                mergeMove(fm,
                          from: sourceRoot.appendingPathComponent(name, isDirectory: true),
                          to:   meetings.appendingPathComponent(name, isDirectory: true))
            }
        }
    }

    /// Move the contents of `src` into `dest` (creating `dest` if needed),
    /// skipping any entry that already exists under `dest` (no clobber). If
    /// every entry moved (i.e. `src` is empty afterwards), remove `src`; if any
    /// entry was skipped or failed to move, leave `src` in place so legacy data
    /// is preserved rather than deleted. No-op if `src` does not exist.
    private static func mergeMove(_ fm: FileManager, from src: URL, to dest: URL) {
        guard fm.fileExists(atPath: src.path) else { return }
        // `run`'s flat-meeting path matches any 4-digit top-level entry; a user
        // could keep a regular file (e.g. an extensionless `2026`) at the source
        // root. Treat a non-directory `src` as a no-op so it is never deleted —
        // `contentsOfDirectory` would throw, the move loop would skip, and the
        // empty `remaining` check below would otherwise `removeItem` the file.
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: src.path, isDirectory: &isDir), isDir.boolValue else { return }
        try? fm.createDirectory(at: dest, withIntermediateDirectories: true)
        let entries = (try? fm.contentsOfDirectory(atPath: src.path)) ?? []
        for e in entries {
            let s = src.appendingPathComponent(e)
            let d = dest.appendingPathComponent(e)
            guard !fm.fileExists(atPath: d.path) else { continue }   // idempotent, no clobber
            do {
                try fm.moveItem(at: s, to: d)
            } catch {
                log.error("source migration move failed \(s.lastPathComponent, privacy: .public) → \(d.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        // Only remove the legacy folder when every top-level entry moved. If
        // any entry survived — skipped because its destination already existed,
        // or left behind by a failed move — leave `src` in place so legacy data
        // is preserved rather than deleted.
        let remaining = (try? fm.contentsOfDirectory(atPath: src.path)) ?? []
        if remaining.isEmpty {
            try? fm.removeItem(at: src)
        }
    }
}
