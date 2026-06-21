import Foundation

/// Single source of truth for every canonical path inside a LLM IDE project.
/// All folder-name string literals live HERE and nowhere else, so the layout
/// can be changed in one place.
///
/// ```
/// <root>/
/// ├── source/   code/   data/   notes/     ← user content (= Library sections)
/// └── system/                              ← generated / system data
///     ├── project.json  (marker + settings)
///     ├── faults/   graph/   cache/
///     └── index.sqlite   sync.json
/// ```
struct ProjectLayout {
    let root: URL

    // User content — mirrors the Library's four sections.
    var sourceDir: URL { root.appendingPathComponent("source", isDirectory: true) }
    var codeDir:   URL { root.appendingPathComponent("code", isDirectory: true) }
    var dataDir:   URL { root.appendingPathComponent("data", isDirectory: true) }
    var notesDir:  URL { root.appendingPathComponent("notes", isDirectory: true) }

    // System / generated data — one visible container.
    var systemDir:   URL { root.appendingPathComponent("system", isDirectory: true) }
    var projectJSON: URL { systemDir.appendingPathComponent("project.json") }
    var faultsDir:   URL { systemDir.appendingPathComponent("faults", isDirectory: true) }
    var graphDir:    URL { systemDir.appendingPathComponent("graph", isDirectory: true) }
    var indexDB:     URL { systemDir.appendingPathComponent("index.sqlite") }
    var syncJSON:    URL { systemDir.appendingPathComponent("sync.json") }
    var cacheDir:    URL { systemDir.appendingPathComponent("cache", isDirectory: true) }

    /// Container subdir (relative) used by MemoryStore — it appends
    /// `faults/` and `q&a/` inside it, so this is `system` (yielding
    /// `system/faults`, which equals `faultsDir` above) and NOT
    /// `system/faults` (that would double-nest to `system/faults/faults`).
    static let memorySubdir = "system"

    /// User-content folders mirroring the Library sections, paired with the
    /// LibraryItem.Category the scanner/import-router uses.
    static let userFolders: [(name: String, category: LibraryItem.Category)] = [
        ("source", .meetings),
        ("code",   .code),
        ("data",   .data),
        ("notes",  .notes),
    ]
}
