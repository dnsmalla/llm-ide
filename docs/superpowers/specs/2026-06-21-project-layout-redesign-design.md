# Project Folder Layout Redesign — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

The per-project folder layout doesn't match how the app actually works, and the
system/generated data is scattered across hidden dot-directories:

- Visible top level mixes user content with near-dead folders: `meetings/`,
  `plans/`, `notes/`, `assets/`, `code/`, `data/`. `assets/` only ever holds
  images folded into the Data category; `plans/` only holds DocGen exports.
- The things the user cares about as first-class concepts — **faults** and the
  **code graph** — live in hidden dirs (`.understand-anything/memory/`,
  `.code-notes/`), and **settings** live in `.llmide/`. The structure is hard to
  understand and doesn't line up with the Library's own sections.

The Library UI has exactly four user-facing sections: **Sources, Code, Data,
Notes**. The folder layout should mirror that, with all generated/system data in
one clearly-named place.

## Goals

- Top-level folders that **mirror the Library's four sections** 1:1.
- **Faults** and **graph** become legible, grouped folders (not hidden dot-dirs).
- A single, professional layout that's easy to reason about.
- A **single source of truth** for layout paths in code (today ~15 sites
  hardcode folder-name string literals).

## Non-goals

- **No migration.** Existing old-layout projects are not supported (confirmed
  acceptable — projects to date are throwaway dev data). Only the new layout is
  scaffolded/validated.
- No change to *where cloned repos live* (still `effectiveClonesURL`/Clones) or
  how a cloned repo is adopted as a project.

## Target layout

```
<project>/
├── source/      ← Library "Sources": meeting + email transcripts (indexed)
│                  (meeting .md under source/YYYY/MM/…, the FolderIndexer root)
├── code/        ← Library "Code": code files added to the Library + repo code
├── data/        ← Library "Data": documents / customer docs / images
│                  (images fold here, as they do today via ("assets", .data);
│                   DocGen "Review Doc" exports also land here)
├── notes/       ← Library "Notes": notes generated from meetings + email
└── system/      ← all system/generated data, one visible container:
    ├── project.json     project marker + settings (was .llmide/project.json)
    ├── faults/          fault reports + q&a + faults.csv (was .understand-anything/memory/)
    ├── graph/           code graph + per-file notes (was .code-notes/)
    ├── index.sqlite     meeting full-text index (+ -wal/-shm)
    ├── sync.json        last-export info
    └── cache/           runtime cache
```

**Mapping from today:**

| Old | New |
|---|---|
| `meetings/` | `source/` |
| `notes/` | `notes/` (unchanged) |
| `code/` | `code/` (unchanged) |
| `data/` + `assets/` | `data/` (assets folds in) |
| `plans/` | removed as a top-level folder; DocGen exports → `data/` |
| `.llmide/project.json` | `system/project.json` (the project marker) |
| `.llmide/{sync.json,index.sqlite,cache}` | `system/{…}` |
| `.understand-anything/memory/{faults,q&a}` | `system/faults/{faults,q&a}` |
| `.code-notes/` | `system/graph/` |

## Architecture

### `ProjectLayout` — single source of truth (new)

A value type that, given a project root URL, vends every canonical path. All
call sites that currently hardcode folder names go through it, so the layout is
defined in exactly one file.

```swift
struct ProjectLayout {
    let root: URL

    var sourceDir: URL { root.appendingPathComponent("source", isDirectory: true) }
    var codeDir:   URL { root.appendingPathComponent("code", isDirectory: true) }
    var dataDir:   URL { root.appendingPathComponent("data", isDirectory: true) }
    var notesDir:  URL { root.appendingPathComponent("notes", isDirectory: true) }

    var systemDir:   URL { root.appendingPathComponent("system", isDirectory: true) }
    var projectJSON: URL { systemDir.appendingPathComponent("project.json") }
    var faultsDir:   URL { systemDir.appendingPathComponent("faults", isDirectory: true) }
    var graphDir:    URL { systemDir.appendingPathComponent("graph", isDirectory: true) }
    var indexDB:     URL { systemDir.appendingPathComponent("index.sqlite") }
    var syncJSON:    URL { systemDir.appendingPathComponent("sync.json") }
    var cacheDir:    URL { systemDir.appendingPathComponent("cache", isDirectory: true) }

    /// User-content folders that mirror the Library sections, with their
    /// LibraryItem.Category, for the scanner + import router.
    static let userFolders: [(name: String, category: LibraryItem.Category)] = [
        ("source", .meetings), ("code", .code), ("data", .data), ("notes", .notes),
    ]
}
```

Folder-name constants (`"source"`, `"system"`, etc.) live ONLY here.

### Consumers updated to use `ProjectLayout`

(From the codebase audit — every site that currently hardcodes a folder name.)

- `Services/ProjectScaffolder.swift` — `requiredDirectories`, `validate()` (marker
  now `system/project.json`; required user dirs `source/code/data/notes`; system
  dirs `system`, `system/faults`, `system/graph`, `system/cache`), README +
  `.gitignore` managed block.
- `Services/ProjectStore.swift` — marker read/write at `system/project.json`.
- `Services/ProjectPaths.swift` — routing: code→`code/`, images+data→`data/`,
  notes→`notes/`; meetings/source handled by the exporter.
- `Services/LibraryItemStore.swift` — `scanFolders` = `ProjectLayout.userFolders`.
- `Services/ProjectExporter.swift` — meetings→`source/`, sync→`system/sync.json`;
  remove the `plans/` export path (or redirect to `data/`).
- `Services/AppEnvironment.swift` — notes output, index at `system/index.sqlite`.
- `CodeGraph/MemoryStore.swift` — `memorySubdir` default → `system/faults`; drop
  the `.understand-anything` convention + the `PathValidator` warning tied to it.
- `Views/CodeGraph/*` (graph), `CodeNoteGenerator` → `system/graph/`.
- `Views/Regression/RegressionView.swift`, `Views/AutoCode/AutoCodeView.swift`,
  `Views/CodeAssistant/ReportFaultSheet.swift` — fault paths via `faultsDir`.
- `Services/IgnoreList.swift`, `Services/SourceControlService.swift` — generated
  artifact dirs (`system/graph`, `system/cache`).
- `Views/Settings/PathsSettingsSection.swift` — display the new tree; **remove**
  the vestigial "UA binary" row + `Config.uaBinaryOverride` (nothing invokes it).
- `Views/Welcome/WelcomeView.swift` README/structure copy.
- `NotesFolderConfig` — the indexer/meetings root becomes `source/`.

### `.gitignore` managed block (new)

```
# >>> LLM IDE managed
system/cache/
system/index.sqlite
system/index.sqlite-shm
system/index.sqlite-wal
system/graph/
system/sync.json
*.partial.md
# <<< LLM IDE managed
```
`system/faults/` and `system/project.json` are **committed** (faults + settings
are durable, shareable knowledge). `system/graph/` is regenerable → ignored.

## Validation (fresh start)

`ProjectScaffolder.validate()` accepts a folder when it (a) has
`system/project.json`, or (b) is empty (new project). The old acceptance paths
(`.llmide/project.json`, the `meetings/notes/plans` heuristic, `.meetnotes`) are
**removed** — old-layout folders no longer validate. New projects scaffold the
target layout.

## Removed

- Top-level `plans/` and `assets/` folders.
- `Config.uaBinaryOverride` + the Paths "UA binary" row (vestigial — no code path
  invokes the `understand-anything` CLI).
- The `.understand-anything/memory` default + the `PathValidator.memorySubdir`
  "skill expects this path" warning.

## Testing

- `ProjectLayoutTests` — every vended URL is under the right parent; `userFolders`
  has the four expected names+categories.
- `ProjectScaffolderTests` — scaffolding a fresh dir creates exactly
  `source/code/data/notes/system{,/faults,/graph,/cache}` + `system/project.json`
  + README + `.gitignore`; `validate()` accepts empty + `system/project.json`,
  rejects an old-layout folder.
- `MemoryStoreTests` — faults/q&a/csv round-trip under `system/faults/`.
- `ProjectPathsTests` — code→code, image→data, data→data, note→notes routing.
- Build + full suite green.

## Risks

- **Breaks existing projects** — intended (fresh start). The app should fail
  cleanly (validate rejects) rather than half-open an old layout.
- Wide edit surface (~15 files) — mitigated by routing everything through
  `ProjectLayout` first, so the actual names change in one place.
