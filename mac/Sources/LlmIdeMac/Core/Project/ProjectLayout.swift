import Foundation

/// Single source of truth for every canonical path inside a LLM-IDE project.
/// All folder-name string literals live HERE and nowhere else, so the layout
/// can be changed in one place.
///
/// Placement rule (user decision 2026-10-28, D4/D5): human-readable generated
/// content lives in `llm-doc/`; machine-consumed artifacts (code notes, agent
/// memory, faults, Q&A, indexes, databases) stay in `system/`.
///
/// ```
/// <root>/
/// ├── source/   code/   data/   templates/   commands/   ← user content
/// ├── llm-doc/                                ← human-readable generated docs (Markdown only)
/// │   ├── <type>/YYYY/MM/   meetings/ emails/ documents/ (+ connector dirs)
/// │   ├── plans/            KB plans as Markdown
/// │   ├── loop/<key>/       loop Markdown outputs (plan/, refactor/, test/, docs/ …)
/// │   └── generated/        Doc Gen exports (default output folder)
/// ├── system/                                 ← machine-consumed state
/// │   ├── project.json      project marker + settings
/// │   ├── loop.json         Loop contract (committed)
/// │   ├── loop-runs/        Loop run journal (git-ignored)
/// │   ├── loop-worktrees/   Loop git worktrees (git-ignored)
/// │   ├── memory/           agent memory artifacts: graph-notes.md, doc-notes.md, chat-memory.md
/// │   ├── q&a/  faults/     Q&A store, fault reports (MemoryStore container: system/)
/// │   ├── repo.md           no longer written; the code summary is graph/index.md
/// │   ├── graph/            code graph + code notes (git-ignored)
/// │   ├── cache/            runtime cache (git-ignored); notes-index.json = the note index (D6)
/// │   ├── loop/<key>/       Loop machine data: test ledger/map/structure JSON, refactor graph (D6)
/// │   └── index.sqlite  sync.json   search index + export info (git-ignored)
/// ```
///
/// `.self-heal/` (`BATCH.md`, the Self-Heal proposal batch) sits at the repo
/// root beside `source/`, not under `system/`.
///
/// Generated graph, memory, faults and Q&A always live under the PROJECT's
/// `system/` (D1, 2026-10-28), never under a cloned repo's `system/` in `code/`.
/// Writers and readers resolve them through `GeneratedDataLocator`, not by
/// joining `systemDir` onto a repo path. Graph output is `system/graph/` for one
/// repo and `system/graph/<repo>/` for 2+ `code/` repos.
struct ProjectLayout {
    let root: URL

    // User content — mirrors the Library's four sections + doc templates.
    var sourceDir: URL { root.appendingPathComponent("source", isDirectory: true) }
    var codeDir:   URL { root.appendingPathComponent("code", isDirectory: true) }
    var dataDir:   URL { root.appendingPathComponent("data", isDirectory: true) }
    var notesDir:  URL { root.appendingPathComponent("llm-doc", isDirectory: true) }

    /// Doc Gen markdown exports, default output: `<root>/llm-doc/generated/`.
    /// Human-readable, so it sits under `llm-doc/` (D4/D5). A saved per-project
    /// folder (`DocGenOutputConfig.localFolderPath`) still wins over this.
    var generatedDocsDir: URL {
        notesDir.appendingPathComponent("generated", isDirectory: true)
    }

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

    /// `<root>/commands/` — Doc Gen command markdown, one folder per command.
    var commandsDir: URL { root.appendingPathComponent("commands", isDirectory: true) }

    func commandDir(named folderName: String) -> URL {
        commandsDir.appendingPathComponent(folderName, isDirectory: true)
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

    /// The rebuildable note index (`NoteService`'s unified index of every
    /// generated note): `system/cache/notes-index.json`, git-ignored with the
    /// rest of `system/cache/`. Machine state, so it never lives in `llm-doc/`
    /// (D6). Before D6 it was `llm-doc/index.json`; see `legacyNotesIndex`.
    var notesIndex: URL { cacheDir.appendingPathComponent(Self.notesIndexFileName) }

    /// The pre-D6 note index location, `llm-doc/index.json`. Readers fall back
    /// to it while the new file is missing; `NotesIndexMigration` moves it.
    var legacyNotesIndex: URL { notesDir.appendingPathComponent(Self.legacyNotesIndexFileName) }

    static let notesIndexFileName = "notes-index.json"
    /// Pre-D6 file name, kept for the legacy-location fallback and migration.
    static let legacyNotesIndexFileName = "index.json"

    /// Loop machine data (ledger, test map/structure, refactor graph snapshots):
    /// `system/loop/<loop key>/…`, same relative names as the `llm-doc/loop`
    /// files they replace (D6). The Loop's `.md` outputs stay in `llm-doc/loop/`.
    var loopDataDir: URL { systemDir.appendingPathComponent(Self.loopDataDirName, isDirectory: true) }
    static let loopDataDirName = "loop"

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
