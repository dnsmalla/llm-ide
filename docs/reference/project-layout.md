---
title: Project folder layout
source: mac/Sources/LlmIdeMac/Core/Project/ProjectLayout.swift
---

# Project folder layout

> The canonical tree LLM-IDE creates inside every project, with a focus on
> `llm-doc/` — where generated notes land.

When a folder is opened as a project, `ProjectScaffolder.scaffold(at:project:)`
(Mac app) creates the tree below **idempotently on every open** — re-opening an
existing project only fills in whatever is newly missing. `ProjectLayout` is the
single source of truth for the folder-name literals; `ProjectPaths` routes
imported files into the right one. A folder is accepted as a project only when
it already contains `system/project.json` or is completely empty
(`ProjectScaffolder.validate`).

## Placement rule

Two homes, decided 2026-10-28 (D4/D5):

- **`llm-doc/`** holds **human-readable generated content**: notes, plans,
  Loop outputs, and Doc Gen exports. A person reads these, so they are
  tracked in git and browsable from the Library.
- **`system/`** holds **machine-consumed artifacts**: code notes, agent memory,
  fault reports, Q&A, search indexes, and databases. Agents and the app read
  these; a person rarely opens them, and most are git-ignored.

`ProjectLayout` (`Core/Project/ProjectLayout.swift`) is the single source of
truth for these paths; its header comment states the same rule.

## Canonical tree

```text
<project>/
├── source/          raw inputs (your Sources)
│   ├── meetings/    YYYY/MM/<ts>-<slug>.md
│   ├── emails/      YYYY/MM/<ts>-<slug>
│   ├── documents/   YYYY/MM/…
│   └── <noteType>/  YYYY/MM/…   (connectors, e.g. slack/)
├── code/            code files / cloned repos (code/<repo> child git repos)
├── data/            user-added documents, data files, images (not Doc Gen output)
├── llm-doc/         human-readable generated content — detailed below
│   ├── meetings/ emails/ documents/ <noteType>/   YYYY/MM/…  (generated notes)
│   ├── plans/       KB plans exported as Markdown
│   ├── loop/<key>/  Loop outputs (plan/, refactor/, test/, … per loop key)
│   └── generated/   Doc Gen exports (default output folder)
├── templates/       Doc Gen templates, one subfolder each (<slug>/template.md)
├── commands/        Doc Gen commands, one subfolder each (<slug>/command.md)
├── .self-heal/      Self-Heal proposal batch (BATCH.md), relative to the repo root;
│                    created on demand
├── system/          machine-consumed state (mostly git-ignored)
│   ├── project.json     project marker + settings (written by ProjectStore)
│   ├── loop.json        Loop contract — committed, so a fresh clone reloads it
│   ├── loop/<key>/      Loop machine data: test/ledger.json, test/TEST-MAP.json,
│   │                    test/TEST-STRUCTURE.json, refactor/graph/{before,after}.json
│   ├── loop-runs/       Loop run journal (git-ignored)
│   ├── loop-worktrees/  Loop git worktrees (git-ignored)
│   ├── memory/          agent memory artifacts: graph-notes.md, doc-notes.md,
│   │                    chat-memory.md (rewritten in place)
│   ├── q&a/             Q&A store (MemoryStore)
│   ├── faults/          fault log entries (MemoryStore)
│   ├── repo.md          no longer written; the code summary is graph/index.md
│   ├── graph/           knowledge graph + code notes (git-ignored)
│   ├── cache/           runtime cache (git-ignored); notes-index.json = the note index
│   ├── index.sqlite     full-text index (git-ignored)
│   └── sync.json        last export info (git-ignored)
└── .claude/         project-level agent config (project.md, settings.json, skills/...)
```

> **Generated data lives in the project's `system/`, always.** Graph, memory,
> faults and Q&A output is never written into a cloned repo's own `system/`
> under `code/<repo>/`. The cloned repo is only the input being graphed.
>
> - **Graph:** `system/graph/` when the project graphs one repo (the project root,
>   or its single `code/<repo>`). With two or more `code/<repo>` repos each gets
>   `system/graph/<repo>/`.
> - **Memory, faults, Q&A, repo.md:** `system/memory/`, `system/faults/`,
>   `system/q&a/`, `system/repo.md`, always at the project level.
> - **Migration:** at project open, the app's own generated files under a legacy
>   `code/<repo>/system/` move into the project's `system/`: the graph (only a
>   recognised generator output, with its self-ignore marker), the known memory
>   artifacts, and the fault and Q&A files named by the writers. Anything else
>   stays. `repo.md` is hand-authored and never moves. A repo is skipped and
>   logged when git reports tracked files under `system/`, when git cannot answer,
>   or when `system/` sits in a nested checkout. Nothing already at the new root is
>   overwritten. Until a file is moved, readers fall back to the legacy location (N-1).

## Folders at a glance

| Path | Holds | Tracked in git? | Written by |
|---|---|---|---|
| `source/` | raw inputs — per-type: `meetings/`, `emails/`, `documents/`, `<connector>/` | yes | capture / import |
| `code/` | code files, cloned repos (`code/<repo>` child git repos) | yes | user / import |
| `data/` | user-added documents, data, images | yes | import |
| `llm-doc/` | generated notes (AI output) | yes (`.gitkeep`) | `NoteService` + meeting/email/connector writers |
| `llm-doc/plans/` | KB plans as Markdown | yes | `ProjectExporter.writePlans` |
| `llm-doc/loop/<key>/` | Loop outputs, human-readable (`.md`: plan, refactor, test map, …) | yes | Loop stages |
| `system/loop/<key>/` | Loop machine data (test ledger, test map/structure JSON, refactor graph snapshots) | yes | Loop stages (`LoopDataMigration` moves pre-D6 copies) |

`system/loop/` sits beside `llm-doc/loop/` under the **same root**: the Loop writes both at
its main checkout root (`gitRoot`, the same root `llm-doc/loop` used), not necessarily at the
LLM-IDE project folder. When the repo is cloned under `code/`, both are under that repo.
| `system/cache/notes-index.json` | unified note index (rebuildable) | **no** | `NoteService` |
| `llm-doc/generated/` | Doc Gen markdown exports (default folder) | yes | Doc Gen export |
| `templates/` | Doc Gen templates (`<slug>/template.md`) | yes | `DocTemplateStore`, `ProjectDocTemplatesSeeder` |
| `commands/` | Doc Gen commands (`<slug>/command.md`) | yes | `DocCommandStore`, `ProjectDocCommandsSeeder` |
| `.self-heal/` | Self-Heal proposal batch (`BATCH.md`) | yes | `SelfHealBatch` |
| `system/project.json` | project marker + metadata | yes | `ProjectStore` |
| `system/loop.json` | Loop contract | yes | Loop engine config store |
| `system/loop-runs/` | Loop run journal | **no** | Loop engine |
| `system/loop-worktrees/` | Loop git worktrees | **no** | `LoopWorktreeManager` |
| `system/memory/` | agent memory artifacts | **no** | `KnowledgeGraphService.writeMemoryArtifact` |
| `system/q&a/`, `system/faults/` | Q&A store, fault log entries | yes | `MemoryStore` |
| `system/graph/` (`system/graph/<repo>/` with 2+ code repos) | knowledge graph + code notes | **no** | `GraphAutoUpdater`, `CodeNoteGenerator` |
| `system/cache/` | runtime cache | **no** | various services |
| `system/index.sqlite` | full-text search index | **no** | indexer |
| `system/sync.json` | last export info | **no** | export pipeline |
| `.claude/` | agent config + symlinked skills kit (`skills/`, `rules/` git-ignored) | partial | `ProjectScaffolder`, `ProjectSkillsInstaller` |

The git-ignored entries are written as a managed block in the project-root
`.gitignore` (between the `llmide:auto` markers); user rules above the block are
never touched.

## llm-doc/ — generated notes

`llm-doc/` is the single home for **AI-generated notes** derived from raw
sources. Raw data stays in `source/`; generated output goes here.
`ProjectPaths.subfolder(for: .notes)` routes the `.notes` Library category here,
and the Library UI labels the section "LLM Doc".

### Structure

```text
<project>/llm-doc/
├── meetings/      <YYYY>/<MM>/<filename>.docx + .md
├── emails/        <YYYY>/<MM>/<filename>.md
├── documents/     <YYYY>/<MM>/<filename>.md
├── <noteType>/    new Source Connectors use their raw type name (e.g. slack/)
├── plans/         KB plans as Markdown (written on export)
├── loop/<key>/    Loop outputs (Markdown only), one folder per loop key (plan/, refactor/, test/, …)
├── generated/     Doc Gen exports (default output folder; see "Not here" below)
```

The unified note index is **not** here: it lives at `<project>/system/cache/notes-index.json`
(D6, machine state). Before D6 it was `llm-doc/index.json`; readers fall back to it
until it is moved.

- One subdirectory per `NoteType`. The legacy three keep their **plural** names
  (`meetings/`, `emails/`, `documents/`) so already-written notes never move; any
  new Source Connector uses its `noteType` raw value as the directory name
  (e.g. `slack/`).
- Notes are bucketed by month: `<type>/<YYYY>/<MM>/`.
- `system/cache/notes-index.json` is the unified index maintained by `NoteService`
  (`version`, `updated`, `notes[]`). It is rebuildable from the note files.

### NoteType → directory

| `NoteType` | Directory | Filename pattern |
|---|---|---|
| `meeting` | `meetings/` | `<YYYY-MM-DD-HHmmss>-<slug>-meeting-notes.md` |
| `email` | `emails/` | `<YYYY-MM-DD-HHmmss>-<slug>.md` |
| `document` | `documents/` | `<YYYY-MM-DD-HHmmss>-<slug>.md` |
| any other (`slack/`, …) | `<rawValue>/` | writer-defined |

### What writes here

| Writer | Produces | Input |
|---|---|---|
| `MeetingNoteWriter` + `IngestTemplateRenderer` | meeting `.md` from `templates/meeting-note/template.md` | same summary (parallel output) |
| `EmailNoteWriter` + `IngestTemplateRenderer` | email `.md` from `templates/email-note/template.md` | classified email |
| `SourceConnectorNoteWriter` | connector notes (e.g. `slack/`) | fetched + classified source items |
| `NoteService.saveNote` | any note + `system/cache/notes-index.json` update | all of the above route through this |

### Not here

- Doc Gen markdown exports (`POST /generate-doc`) default to
  `<project>/llm-doc/generated/` (`ProjectLayout.generatedDocsDir`). This moved
  from `data/` on 2026-10-28. A folder saved before then keeps working, since a
  stored path always wins (no migration). The folder is configurable per project
  in Doc Gen's Setup section (`DocGenOutputStore`).
- Code notes live under `system/graph/`, not `llm-doc/`.
- Raw transcripts live under `source/`.

### History

The folder was renamed `notes/` → `llm-doc/` (one-time, idempotent
`NotesToLlmDocMigration` at launch). Do not reintroduce a `notes/` literal for
generated notes.

## source/ — raw inputs

`source/` is the single home for **raw** inputs, one child folder per source type
(mirroring `llm-doc/` for processed output). `ProjectStore.openFolder` binds the
notes folder to `<project>/source/`, so `MeetingFileStore`, the email/connector
writers, and the Library scanner all resolve here.

### Structure

```text
<project>/source/
├── meetings/    YYYY/MM/<file>.md     raw transcripts (MeetingFileStore)
├── emails/      YYYY/MM/<file>        raw emails (EmailSource via InboxStore)
├── documents/   YYYY/MM/…             raw ingested docs
└── <noteType>/  YYYY/MM/…             connectors, e.g. slack/ (on-demand)
```

A one-time `SourceFolderMigration` (run at launch) moves legacy raw locations
(`source/EmailInbox/`, `<inboxFolder>/`, flat `source/<year>/`) into this layout.
`data/` remains for user-added misc files and images.

## See also

- [macOS app spec](../spec/macos-app.md) — the services behind scaffolding and notes
- [Database schema](database-schema.md) — server-side storage
- [Agent skills](agent-skills.md) — the symlinked skills kit under `.claude/`
