---
title: Project single-source paths
status: draft
date: 2026-06-15
---

# Project single-source paths — design

## Problem

The macOS app has two parallel, disagreeing path systems:

- **Global `AppConfig` paths** — a `dataRoot` plus named subfolders
  (`notesSubdir` "Notes", `docsSubdir` "Docs", `clonesSubdir`, `infiniteBrainSubdir`),
  surfaced in Settings → Paths.
- **The active project's folder** — a hardcoded structure
  (`meetings/`, `plans/`, `notes/`, `assets/`) created by `ProjectScaffolder`.

Consequences observed in the current build:

1. The Settings panel and the project use **different folder names**
   (Notes/Docs vs notes/plans), so the panel doesn't describe reality.
2. Most writers ignore the Settings subfolders. Live transcripts, notes,
   and `.docx` go through `NotesFolderConfig` (a legacy bookmark);
   DocGen export is **hardcoded to `~/Downloads`**; doc templates live in
   App Support. The Settings "Notes/Docs" fields are effectively dead.
3. `LibraryItemStore` holds a **separately persisted pointer list** that
   can drift from disk, and "Add file/folder" only references files in
   place — it never routes them into a project subfolder.

The user's governing principle: **one canonical home per file, referenced
by every menu/page — no per-menu copies, no stale second versions.**

## Goals

- The active project's folder is the single workspace. Settings → Paths
  shows and manages *that project's* real folders.
- A fixed, auto-created canonical folder set per project.
- One shared index over the project folders feeds **every** menu
  (Library, Review Code/Doc/Conflicts, Visual, Doc Gen, Code Graph).
- Adding an **external file** copies it **once** into the right subfolder;
  files already inside the project are referenced, never duplicated.
  Adding a **folder** references it in place (no copy).
- All generators write into the project's canonical folders, so what a
  menu shows equals what was written.

## Non-goals

- Per-project renaming of subfolders (names are fixed conventions).
- Moving cross-project artifacts into the project: doc *templates*
  (reusable), repo *clones*, and per-repo `memory/` stay where they are.
- Backend/LLM streaming or vision work (tracked separately).

## Design

### 1. Canonical folder set

`ProjectScaffolder.requiredDirectories` becomes the single definition of
the project structure:

| Folder | Purpose | Library category |
| --- | --- | --- |
| `meetings/` | Live captures + exported transcripts | `.meetings` |
| `plans/` | Exported plans + generated documents (.md/.json) | — |
| `notes/` | Free-form + generated meeting notes (.docx) | `.notes` |
| `assets/` | Images, screenshots, diagrams, attachments | (image files) |
| `code/` | Referenced source folders (indexed in place) | `.code` |
| `data/` | Data files (csv, json, datasets) | `.data` |

`code/` and `data/` are **new**. They are added to existing projects on
next open (the scaffold is idempotent). `ProjectScaffolder.validate` is
updated to expect the new set.

### 2. The index is the filesystem

`LibraryItemStore` stops persisting a hand-maintained pointer list and
instead **scans the active project's canonical folders** (plus any
referenced external folders registered for `code/`). The scan result *is*
the index. One file on disk → one entry → shown identically everywhere.
Rename/delete on disk reflects in every menu; no second copy can exist.

Referenced external folders (code repos) are recorded as references
(path + origin), not copied. They remain the single source at their real
location.

### 3. Add behavior

`add(url:category:)`:

- If `url` is **inside** the active project root → index in place.
- If `url` is **outside** → copy once into the destination subfolder.
- **Destination rule:** image files → `assets/`; otherwise the category
  of the section the user added from (`.notes`→`notes/`, `.data`→`data/`,
  `.code`→`code/`).
- **Name conflict:** if a same-named file exists in the destination,
  **replace** it (overwrite). No keep-both, no silent duplicate.

`addFolder(url:category:)`: reference in place, recorded as an external
folder reference; never copied.

### 4. Writers target the project

| Artifact | Today | New destination |
| --- | --- | --- |
| Meeting transcripts/captions | `NotesFolderConfig` → `<project>/meetings` | unchanged (kept) |
| Meeting notes (.docx) | `currentFolder/../notes` | `<project>/notes` (aligned) |
| DocGen export | hardcoded `~/Downloads` | `<project>/plans` |
| Project plans export | `<project>/plans` | unchanged (correct) |

Exceptions that stay put (not project documents): doc templates
(App Support, reusable across projects), repo clones (global clones
location), per-repo `memory/` (repo-relative).

### 5. Settings → Paths panel

When a project is open, the panel shows the **project's canonical
folders** with reveal / rebuild-missing / validate actions — no more
name mismatch. The redundant global subfolder fields (Notes/Docs/
InfiniteBrain) are removed. `dataRoot` is repurposed and relabelled as
**"Default location for new projects."** Clones location, UA binary
override, and per-repo memory subdir remain as global settings.

### Migration / cleanup

- Existing projects: `code/` + `data/` created on next open (idempotent).
- `LibraryItemStore`: the old `library_items.json` pointer list is
  replaced by the live scan. One-time migration: each previously-added
  **out-of-project file** is copied once into its matching canonical
  subfolder (same rule as add), so nothing silently disappears;
  out-of-project **folders** become external references (migrated from
  `config.localCodeFolders` and the old list). After migration the
  pointer list is discarded.
- Persisted `defaultModelId`/path settings unaffected.

## Components affected

- `Services/ProjectScaffolder.swift` — canonical set + validate.
- `Services/LibraryItemStore.swift` — scan-based index, copy-on-add,
  external-folder references, replace-on-conflict.
- `Views/Settings/PathsSettingsSection.swift` — project-folder view,
  remove dead global subfolder rows, relabel `dataRoot`.
- `Models/Config.swift` — repurpose `dataRoot`; remove/retire
  `notesSubdir`/`docsSubdir`/`infiniteBrainSubdir` resolvers.
- `Services/API/LlmIdeAPIClient+Export.swift` + `DocGenViewModel` —
  DocGen export destination → `plans/`.
- `AppEnvironment` / `MeetingSummarizationService` — `.docx` notes →
  `<project>/notes`.
- Add-file/folder call sites (LibraryView, PathsSettingsSection).

## Data flow

1. User opens/creates a project → `ProjectScaffolder.scaffold` ensures the
   canonical folders exist.
2. `LibraryItemStore` scans those folders → single index.
3. Every menu reads the index by category; the same path is referenced
   everywhere.
4. User adds an external file → copied once into its subfolder → next scan
   surfaces it in the relevant menus.
5. A generator writes into a canonical folder → the scan surfaces the
   output in the matching menu — same file, no copy.

## Error handling

- Copy-on-add failure (permissions, disk) → surfaced inline, file not
  indexed; no partial state.
- Missing canonical folder at scan time → rebuilt via scaffold
  (idempotent); scan degrades to whatever exists.
- No active project → panel shows the "create/open a project" state;
  add actions are disabled.

## Testing

- `ProjectScaffolder`: canonical set created; idempotent re-open adds
  `code/`+`data/` to a legacy project; validate accepts the new set.
- `LibraryItemStore`: scan reflects on-disk files; copy-on-add for an
  external file lands in the right subfolder; in-project file is indexed
  without copy; replace-on-conflict overwrites; folder add references
  without copy.
- Destination rule: image → `assets/`, else by category.
- (Writer redirection verified at runtime against the app once a backend
  is available; unit-level where possible.)

## Risks

- **Meeting-notes rewiring** (`NotesFolderConfig` → `<project>/notes`) is
  the central, highest-risk change; keep the meetings bookmark path as-is
  and only align the notes sibling.
- Discarding the persisted library index changes startup behaviour for
  users with manually-added out-of-project files; the one-time migration
  copies those into the project (files) or keeps them as external
  references (folders) so nothing is lost.
- `XCTest` does not run in the current environment; tests are written and
  compiled but validated by build + manual run.
