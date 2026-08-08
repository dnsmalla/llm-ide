# Source per-type raw layout

**Status:** Approved (design) — 2026-08-08
**Approach:** A — extend `ProjectLayout` + retarget writers + one-time migration.

## Goal

Restructure **raw** source data to live under `<project>/source/<type>/YYYY/MM/`,
with one child folder per source type (`meetings/`, `emails/`, `documents/`, and
per-connector types like `slack/`). This mirrors the existing processed layout
under `llm-doc/<type>/YYYY/MM/`, so the two trees stay symmetric for every type:

```
source/<type>/YYYY/MM/   ← raw inputs
llm-doc/<type>/YYYY/MM/  ← LLM-processed output (already exists, unchanged)
```

## Background — why this is needed

The processed side already matches the intended design. The raw side does not:

| Raw input | Today | Intended |
|---|---|---|
| Meetings | `source/YYYY/MM/<file>.md` (flat) | `source/meetings/YYYY/MM/` |
| Email | `EmailInbox/YYYY-MM/` (separate top-level folder) | `source/emails/YYYY/MM/` |
| Slack / connectors | `<root>/<inboxFolder>/` (connector-defined) | `source/<noteType>/YYYY/MM/` |
| Documents | `data/` (mixed with user files/images) | `source/documents/YYYY/MM/` |

Three load-bearing facts make this a bounded change rather than a deep refactor:

1. **`ProjectStore.openFolder` binds `NotesFolderConfig` to the project `source/`**
   ([ProjectStore.swift:114-115](mac/Sources/LlmIdeMac/Services/ProjectStore.swift#L114-L115)).
   So in project mode `MeetingFileStore`'s root, the `FolderIndexer` root, and
   `LibraryItemStore`'s scan root all already resolve to `source/`.
2. **The Library treats `source/` as a recursive, multi-type hub.** The `source/`
   category is labeled **"Sources"** ([LibraryItem.swift:57](mac/Sources/LlmIdeMac/Models/LibraryItem.swift#L57));
   `LibraryItemStore.performScan` enumerates `source/` recursively and sub-groups
   items by frontmatter `platform` ([LibraryItemStore.swift:163-184](mac/Sources/LlmIdeMac/Services/LibraryItemStore.swift#L163-L184)).
3. **`NoteType.directoryName` already gives the folder name** for every type
   (`meeting`→`meetings`, `email`→`emails`, `document`→`documents`, else rawValue)
   and is already used under `llm-doc/`. Reusing it under `source/` keeps the two
   trees symmetric for free.

## Target layout

```
<project>/source/
├── meetings/    YYYY/MM/<ts>-<slug>.md        raw transcripts
├── emails/      YYYY/MM/<ts>-<slug>           raw emails
├── documents/   YYYY/MM/...                   raw ingested docs (Box, uploads)
└── <noteType>/  YYYY/MM/...                   connectors, e.g. slack/ (on-demand)
```

`data/` stays for user-added misc files and images. `llm-doc/<type>/YYYY/MM/` is
unchanged. Raw folder names reuse `NoteType.directoryName`, so a new connector's
raw lands at `source/<rawValue>/` and its processed output at `llm-doc/<rawValue>/`
with no extra wiring.

## Component changes

### `ProjectLayout` — single source of truth for raw paths
Add `func sourceRawDir(for type: NoteType) -> URL` returning
`sourceDir/<type.directoryName>/`. Mirrors the existing `notesDir` / `graphDir`
helpers. All raw-path string literals live here.

### `MeetingFileStore.monthFolder` — prepend `meetings/`
Change `root/YYYY/MM/` → `root/meetings/YYYY/MM/`
([MeetingFileStore.swift:185-191](mac/Sources/LlmIdeMac/Services/NotesFolder/MeetingFileStore.swift#L185-L191)).
Because the root is bound to `source/` on project open, meetings land in
`source/meetings/YYYY/MM/`. `createPartial`/finalize both derive from
`monthFolder`, so they move consistently. No-project (standalone sync) mode gets
`<notesRoot>/meetings/YYYY/MM/` — consistent, acceptable.

### `EmailSource` — raw to `source/emails/YYYY/MM/`
Write raw to `source/emails/YYYY/MM/` (via `sourceRawDir(for: .email)`) instead of
`EmailInbox/YYYY-MM/` ([EmailSource.swift:35,118](mac/Sources/LlmIdeMac/Sources/EmailSource.swift#L35)),
and align the month bucket from flat `YYYY-MM` to nested `YYYY/MM/`.

### `SourceConnector` — raw standardized to `source/<noteType>/`
Raw dir becomes `source/<noteType>/`; the per-manifest `inboxFolder` is no longer
used as the raw location ([SourceConnector.swift:42,60](mac/Sources/LlmIdeMac/SourceConnectors/SourceConnector.swift#L42)).
Processed notes still go to `llm-doc/<noteType>/`. This is the agreed sub-decision:
drop the separate `inboxFolder` notion in favor of a uniform `source/<noteType>/`.

### `ProjectScaffolder` — pre-create canonical raw subdirs
Add `source/meetings/`, `source/emails/`, `source/documents/` (+ `.gitkeep`) to
the scaffolded tree for a clean initial layout; connector types (`slack/`…) are
created on connector setup. Update the doc-comment tree, the generated project
README tree, and the agent-entry file table to show `source/<type>/`.

### New: `rawFile` resolver
A `resolveRawFile(_:root:) -> URL?` helper that understands both forms:
- new: `source/<type>/…` → `root/source/<type>/…`
- old: `EmailInbox/…` → `root/source/emails/…` (post-migration) with
  `root/EmailInbox/…` fallback (pre-migration)
- old: `meetings/…` → `root/source/meetings/…`
- old: `<inboxFolder>/…` → `root/source/<noteType>/…`

Used wherever a note opens its raw source, so any unmigrated reference still resolves.

## Migration — `SourceFolderMigration` (new, idempotent, at launch)

Runs in `AppEnvironment.init` alongside `NotesToLlmDocMigration`
([AppEnvironment.swift:27-28](mac/Sources/LlmIdeMac/Services/AppEnvironment.swift#L27)).
**Moves only — never deletes, never clobbers** (skip if dest exists). Retryable:
a failed move is retried next launch.

- `source/<4-digit-year>/…` → `source/meetings/<year>/…`
  (detect flat meeting raw by a top-level numeric year directory).
- `EmailInbox/…` → `source/emails/…` (rebucket to `YYYY/MM/`).
- For each known connector, `<inboxFolder>/…` → `source/<noteType>/…`.
- Rewrite `rawFile` references in `llm-doc/index.json` and note frontmatter:
  `EmailInbox/…`→`source/emails/…`, `meetings/…`→`source/meetings/…`,
  `<inboxFolder>/…`→`source/<noteType>/…`.

**Documents already in `data/` are left in place** — they are mixed with user
files/images and cannot be safely auto-classified as "ingested document sources."
Only newly-ingested documents go to `source/documents/` going forward.

## Scanner / indexer behavior — no structural change

`LibraryItemStore` already scans `source/` recursively and classifies by
`platform`; `FolderIndexer` already indexes `source/` recursively. Files under
`source/<type>/` are picked up and grouped with no code change.

**Visible consequence (intended):** raw emails and Slack messages now appear under
the **Sources** section (grouped as Mail / Slack), where today they do not (their
raw folders aren't scanned). This matches "raw lives under `source/`."

## Error handling

- Migration and `rawFile`-rewrite failures are logged and skipped (non-fatal),
  matching `NotesToLlmDocMigration`'s posture. Idempotent — safe to re-run.
- Writers use `createDirectory(..., withIntermediateDirectories: true)` as today.
- `resolveRawFile` returns `nil` if not found; callers handle a note without raw
  gracefully.

## Testing

- `ProjectLayout.sourceRawDir(for:)` for each `NoteType` (incl. a custom
  connector rawValue).
- `SourceFolderMigration`: seed old layout (`source/2026/05/`, `EmailInbox/2026-05/`,
  a connector inbox), run, assert new layout + rewritten `rawFile`; run twice,
  assert no-op (idempotent, no duplication).
- `resolveRawFile`: old and new forms both resolve.
- Writers: `MeetingFileStore`, `EmailSource`, `SourceConnector` each write to the
  new `source/<type>/YYYY/MM/` path.
- Verify with `swift build` (SourceKit errors in this repo are frequently stale;
  pre-existing `SCMParsers` / `SavedRepoPathReconciler` test failures are not
  introduced by this work).

## Out of scope

- `llm-doc/<type>/` processed layout (already correct, unchanged).
- `data/` for user misc files/images (unchanged).
- iOS / shared wire types — `source/` is Mac on-disk only; no wire type to add.
- No-project / standalone sync mode beyond using a `meetings/` subdir there too.
- A deeper `RawSourceStore` abstraction (Approach B) — deferred; `ProjectLayout`
  already serves as the path single-source-of-truth.

## References

- [ProjectLayout.swift](mac/Sources/LlmIdeMac/Services/ProjectLayout.swift) — path single-source-of-truth
- [NoteService.swift:24-55,149-210](mac/Sources/LlmIdeMac/Services/NoteService.swift#L24) — `NoteType.directoryName`, `notesRoot`, month bucketing
- [ProjectStore.swift:108-115](mac/Sources/LlmIdeMac/Services/ProjectStore.swift#L108) — binds notes folder to `source/`
- [NotesToLlmDocMigration.swift](mac/Sources/LlmIdeMac/Services/NotesFolder/NotesToLlmDocMigration.swift) — migration precedent
- [docs/reference/project-layout.md](docs/reference/project-layout.md) — published layout reference (to update)
