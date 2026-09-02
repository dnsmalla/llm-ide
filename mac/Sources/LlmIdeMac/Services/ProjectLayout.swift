import Foundation

/// Single source of truth for every canonical path inside a LLM-IDE project.
/// All folder-name string literals live HERE and nowhere else, so the layout
/// can be changed in one place.
///
/// ```
/// <root>/
/// ├── source/   code/   data/   llm-doc/   templates/   ← user content
/// └── system/                              ← generated / system data
///     ├── project.json  (marker + settings)
///     ├── faults/   graph/   cache/
///     └── index.sqlite   sync.json
/// ```
struct ProjectLayout {
    let root: URL

    // User content — mirrors the Library's four sections + doc templates.
    var sourceDir: URL { root.appendingPathComponent("source", isDirectory: true) }
    var codeDir:   URL { root.appendingPathComponent("code", isDirectory: true) }
    var dataDir:   URL { root.appendingPathComponent("data", isDirectory: true) }
    var notesDir:  URL { root.appendingPathComponent("llm-doc", isDirectory: true) }

    /// Raw source directory for a note type: `<root>/source/<type.directoryName>/`.
    /// Mirrors `notesDir` so raw and processed trees stay symmetric for every
    /// type: `source/<type>/YYYY/MM/` (raw) ↔ `llm-doc/<type>/YYYY/MM/` (processed).
    /// Callers that already hold `source/` as their root (the raw writers) append
    /// `type.directoryName` directly instead — using this helper on `source/`
    /// would double the `source/` segment.
    func sourceRawDir(for type: NoteType) -> URL {
        sourceDir.appendingPathComponent(type.directoryName, isDirectory: true)
    }

    /// KB plans exported as Markdown: `<root>/llm-doc/plans/` — plural, like
    /// its sibling generated-note type dirs (meetings/, emails/, documents/).
    /// Written by `ProjectExporter.writePlans(...)`; auto-generated on demand
    /// (withIntermediates) like NoteService type dirs, plus by the scaffolder.
    var plansDir: URL {
        notesDir.appendingPathComponent("plans", isDirectory: true)
    }

    /// Doc Gen templates — one subfolder per template (`templates/<slug>/template.md`).
    var templatesDir: URL { root.appendingPathComponent("templates", isDirectory: true) }

    /// Folder for a named template slug, e.g. `meeting-summary`.
    func templateDir(named folderName: String) -> URL {
        templatesDir.appendingPathComponent(folderName, isDirectory: true)
    }

    /// Auto Task prompt templates — a FLAT folder of `<slug>.md` files, not
    /// the one-folder-per-template shape Doc Gen uses next door. A different
    /// product with a different unit (a single prompt, not a sectioned
    /// document), so it gets its own reserved subfolder rather than competing
    /// for slugs in `templates/`. `DocTemplateStore` skips this name when it
    /// scans, which is the one place the two conventions touch.
    var autoTaskTemplatesDir: URL {
        templatesDir.appendingPathComponent(Self.autoTaskTemplatesFolderName, isDirectory: true)
    }

    /// Reserved subfolder name inside `templates/` — see `autoTaskTemplatesDir`.
    static let autoTaskTemplatesFolderName = "auto_task"

    // System / generated data — one visible container.
    var systemDir:   URL { root.appendingPathComponent("system", isDirectory: true) }
    var projectJSON: URL { systemDir.appendingPathComponent("project.json") }
    var faultsDir:   URL { systemDir.appendingPathComponent("faults", isDirectory: true) }
    var graphDir:    URL { systemDir.appendingPathComponent("graph", isDirectory: true) }
    // Code notes are written directly to graph/ (not graph/notes/) - graph OF notes
    var graphNotesDir: URL { graphDir }
    /// Agent-facing memory artifacts (`graph-notes.md`, `doc-notes.md`, and the
    /// extension-written `chat-memory.md`). Mirrors `graphkit/paths.mjs` on the
    /// server side — one directory, one file per artifact, rewritten in place.
    ///
    /// NOT to be confused with `memorySubdir` below: that is the CONTAINER
    /// (`system`) MemoryStore appends `faults/` and `q&a/` to. This is a
    /// sibling of those, i.e. `system/memory`.
    ///
    /// Previously these files lived in `<repo>/graphify-out/memory/` — a
    /// directory owned by the separate `/graphify` skill, which writes its own
    /// `graphify-out/graph.json` there. Two producers in one tree; now one.
    var memoryDir:   URL { systemDir.appendingPathComponent("memory", isDirectory: true) }
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
        ("llm-doc",  .notes),
    ]
}
