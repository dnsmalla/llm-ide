import Foundation
import Observation

@MainActor
@Observable
final class AppEnvironment {
    let notesConfig: NotesFolderConfig
    let index: MeetingIndex
    let indexer: FolderIndexer
    /// The active project root, if any.  Stored at init time so that
    /// `notesOutputFolder` can return `<projectRoot>/notes/` when a project
    /// is open instead of deriving the path from `meetingsFolder`.
    public let projectRoot: URL?

    /// - Parameter indexRootURL: Directory that contains (or will contain)
    ///   the `system/index.sqlite` file.  Pass the **project root** when
    ///   a project is open so the index lands in `project/system/` (the
    ///   canonical, scaffolded location) instead of inside `meetings/system/`.
    ///   Pass `nil` when no project is active — the notes folder itself is
    ///   used as the root (legacy behaviour for standalone/no-project mode).
    init(indexRootURL: URL? = nil) throws {
        let config = NotesFolderConfig()
        let folder = config.currentFolder
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Place the SQLite index at <indexRoot>/system/index.sqlite.
        // When a project is open indexRootURL is the project root, so the
        // index lives in the scaffolded system/ dir alongside project.json
        // and sync.json — not buried inside meetings/system/.
        let idxRoot = indexRootURL ?? folder
        let idxLayout = ProjectLayout(root: idxRoot)
        try FileManager.default.createDirectory(
            at: idxLayout.systemDir,
            withIntermediateDirectories: true)
        let idx = try MeetingIndex(url: idxLayout.indexDB)
        let indexer = FolderIndexer(root: folder, index: idx)
        self.notesConfig = config
        self.index = idx
        self.indexer = indexer
        self.projectRoot = indexRootURL?.standardizedFileURL
        // Spec §11: auto-rebuild when the on-disk file count diverges
        // from the index by more than max(5, 5%) — covers the case
        // where the user pasted files in via Finder while the app was
        // closed, or restored from a sync conflict.  Small libraries
        // always rebuild on launch (the heuristic floor is 5).
        //
        // Defer the recursive folder walk + potential fullScan off the
        // main actor so launch isn't blocked on libraries of 1k+ files.
        // FolderIndexer + MeetingIndex are internally serialized; the
        // FSEvents watcher (started later via startWatching) is the only
        // other writer and is set up after the UI is alive.
        let indexerRef = indexer
        let folderRef = folder
        DispatchQueue.global(qos: .userInitiated).async {
            let onDisk = Self.countMarkdownFiles(in: folderRef)
            let indexed = (try? idx.count()) ?? 0
            let diff = abs(onDisk - indexed)
            let threshold = max(5, indexed / 20)
            if diff >= threshold {
                try? indexerRef.fullScan()
            }
        }
    }

    // Pure filesystem helper — no main-actor state, so callable off the main actor
    // (it runs on a background queue).
    private nonisolated static func countMarkdownFiles(in root: URL) -> Int {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root,
                                             includingPropertiesForKeys: nil,
                                             options: [.skipsHiddenFiles]) else { return 0 }
        var count = 0
        for case let url as URL in enumerator {
            let name = url.lastPathComponent
            if name.hasSuffix(".md") && !name.hasSuffix(".partial.md") { count += 1 }
        }
        return count
    }

    /// The folder where formatted meeting notes (NOTES section) are written.
    ///
    /// - When a project is active this is `<projectRoot>/notes/` — the
    ///   canonical, scaffolded location that the Library's NOTES scan covers.
    /// - When no project is active it falls back to a `notes/` folder under
    ///   the notes-config default root. In practice `AppEnvironment` is only
    ///   constructed with an active project (the shell shows WelcomeView
    ///   otherwise), so this branch is purely defensive.
    var notesOutputFolder: URL {
        if let root = projectRoot {
            return ProjectLayout(root: root).notesDir
        }
        return ProjectLayout(root: notesConfig.defaultFolder()).notesDir
    }

    /// The `meetings/` folder — contains raw `.md` transcripts organised
    /// into month sub-directories (e.g. `2026-05/`).  Used by the
    /// Meetings section in the Library sidebar.
    var meetingsFolder: URL {
        notesConfig.currentFolder          // e.g. …/project/meetings
    }

    func startWatching(onChange: @escaping () -> Void) {
        indexer.startWatching { [weak self] in
            try? self?.indexer.fullScan()
            onChange()
        }
    }
}
