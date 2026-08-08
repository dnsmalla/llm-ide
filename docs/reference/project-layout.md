---
title: Project folder layout
source: mac/Sources/LlmIdeMac/Services/ProjectLayout.swift
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

## Canonical tree

```
<project>/
├── source/        raw meeting & email transcripts (your Sources)
├── code/          code files / cloned repos
├── data/          documents, data files, images; Doc Gen markdown exports
├── llm-doc/       generated notes (AI output) — detailed below
├── templates/     Doc Gen templates, one subfolder each (<slug>/template.md)
├── system/        LLM-IDE managed state (mostly git-ignored)
│   ├── project.json   project marker + settings (written by ProjectStore)
│   ├── faults/        fault log entries
│   ├── graph/         knowledge graph + code notes (git-ignored)
│   ├── cache/         runtime cache (git-ignored)
│   ├── index.sqlite   full-text index (git-ignored)
│   └── sync.json      last export info (git-ignored)
└── .claude/       project-level agent config (project.md, settings.json, skills/...)
```

## Folders at a glance

| Path | Holds | Tracked in git? | Written by |
|---|---|---|---|
| `source/` | raw transcripts (meetings, email inboxes, doc sources) | yes | capture / import |
| `code/` | code files, cloned repos (`code/<repo>` child git repos) | yes | user / import |
| `data/` | documents, data, images; Doc Gen markdown export | yes | import / Doc Gen export |
| `llm-doc/` | generated notes (AI output) | yes (`.gitkeep`) | `NoteService` + meeting/email/connector writers |
| `templates/` | Doc Gen templates (`<slug>/template.md`) | yes | `DocTemplateStore`, `ProjectDocTemplatesSeeder` |
| `system/project.json` | project marker + metadata | yes | `ProjectStore` |
| `system/faults/` | fault log entries | yes | `MemoryStore` |
| `system/graph/` | knowledge graph + code notes | **no** | `GraphAutoUpdater`, `CodeNoteService` |
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

```
<project>/llm-doc/
├── meetings/      <YYYY>/<MM>/<filename>.docx
├── emails/        <YYYY>/<MM>/<filename>.md
├── documents/     <YYYY>/<MM>/<filename>.md
├── <noteType>/    new Source Connectors use their raw type name (e.g. slack/)
└── index.json     unified note index (maintained by NoteService)
```

- One subdirectory per `NoteType`. The legacy three keep their **plural** names
  (`meetings/`, `emails/`, `documents/`) so already-written notes never move; any
  new Source Connector uses its `noteType` raw value as the directory name
  (e.g. `slack/`).
- Notes are bucketed by month: `<type>/<YYYY>/<MM>/`.
- `index.json` is the unified index maintained by `NoteService`
  (`version`, `updated`, `notes[]`).

### NoteType → directory

| `NoteType` | Directory | Filename pattern |
|---|---|---|
| `meeting` | `meetings/` | `<YYYY-MM-DD-HHmmss>-<slug>-meeting-notes.docx` |
| `email` | `emails/` | `<YYYY-MM-DD-HHmmss>-<slug>.md` |
| `document` | `documents/` | `<YYYY-MM-DD-HHmmss>-<slug>.md` |
| any other (`slack/`, …) | `<rawValue>/` | writer-defined |

### What writes here

| Writer | Produces | Input |
|---|---|---|
| `MeetingNoteGenerator` + `MeetingNoteWriter` | meeting `.docx` via bundled Python (`generate_meeting_note.py`) | transcript + AI summary (`POST /kb/summarize`) |
| `EmailNoteWriter` | email `.md` with YAML frontmatter (todos, `sourceHash`) | classified email |
| `SourceConnectorNoteWriter` | connector notes (e.g. `slack/`) | fetched + classified source items |
| `NoteService.saveNote` | any note + `index.json` update | all of the above route through this |

### Not here

- Doc Gen markdown exports (`POST /generate-doc`) write to `<project>/data/`,
  not `llm-doc/`.
- Code notes live under `system/graph/`, not `llm-doc/`.
- Raw transcripts live under `source/`.

### History

The folder was renamed `notes/` → `llm-doc/` (one-time, idempotent
`NotesToLlmDocMigration` at launch). Do not reintroduce a `notes/` literal for
generated notes.

## See also

- [macOS app spec](../spec/macos-app.md) — the services behind scaffolding and notes
- [Database schema](database-schema.md) — server-side storage
- [Agent skills](agent-skills.md) — the symlinked skills kit under `.claude/`
