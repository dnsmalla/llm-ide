# Mac App Phase 1 — IA Redesign, Native Polish, File-Based Notes

**Date:** 2026-05-12
**Scope:** macOS SwiftUI app (`mac/Sources/MeetNotesMac/`) only
**Phase:** 1 of 3 — see "Phasing" below

---

## 1. Summary

Replace the current top-tab shell of the Mac app with a native macOS `NavigationSplitView` three-pane layout, switch from server-DB-backed meeting storage to **plain `.md` files in a user-visible folder** (with a thin local SQLite index for list rendering), and generate multi-level summaries (gist + TL;DR + full structured notes) when a recording ends.

Phase 1 makes the app feel like a shipped, native macOS application and replaces the storage model. Phase 2 adds files/attachments. Phase 3 adds global Cmd+K search and Ask mode. Each phase ships independently.

## 2. Goals & non-goals

### Goals
- App layout and chrome look indistinguishable from a native macOS Sequoia app (Mail / Reminders / Notes family).
- Three-pane Library section: sidebar → meeting list → meeting detail.
- Meetings are stored as portable `.md` files on disk, openable in any markdown editor (Obsidian, VS Code, TextEdit).
- Live transcript streams to disk during recording; survives crashes; user can watch the file grow in Obsidian/etc.
- Multi-level summaries (one-line gist, 3-5 bullet TL;DR, full structured notes) auto-generated when a recording ends.
- User can point the app at an iCloud / Dropbox / Google Drive folder so notes sync across machines.
- Existing meetings in the legacy SQLite DB get a one-time export to `.md` on first launch of the new shell.

### Non-goals (Phase 1)
- File attachments per meeting — Phase 2.
- Linked workspace folders (folder-as-context) — Phase 2.
- Generated-artifacts library (exported docs, codegen patches) — Phase 2.
- Global Cmd+K search across notes — Phase 3.
- Semantic "Ask" mode (RAG over notes) — Phase 3.
- Any change to capture/orchestration, login, permissions, deep-link router, API client.
- Any change to the Chrome extension.
- Multi-vault / multiple notes folders (single folder is enough for Phase 1).
- iCloud conflict *resolution* UI (we detect and side-file; merging is later).

## 3. Approach

**Incremental refactor.** Replace `ContentView`'s tab shell with a new `AppShell` built on `NavigationSplitView`. Existing view bodies (`TranscriptView`, `ReviewView`, `PlanView`, `SettingsView`) are reused inside the new shell with no internal changes. `HistoryView` is superseded by the new `Library*` views but kept for one release as a fallback.

Behind a `FeatureFlags.newShell` static bool: defaults on in dev, off in release for the first PR. Flipped to on in release once Library + Detail are proven against real data. Old shell deleted in the following PR.

## 4. Shell structure

`NavigationSplitView` with three columns. Sidebar lists sections; middle and detail panes change shape depending on the selected section.

```
┌─────────────┬─────────────────────┬────────────────────────────────────┐
│ Sidebar     │ Middle (Library     │ Detail                             │
│             │  only; absent for   │                                    │
│             │  other sections)    │                                    │
│ MEETINGS    │                     │                                    │
│  Library ●  │ [🔎 Filter      ]  │  Q1 Planning · 2026-05-08 14:00    │
│  Live*      │ ─────────────────── │  ──────────────────────────────── │
│             │  ● Q1 Planning      │  Gist                              │
│ ACTIONS     │    May 8 · 42 min   │  Discussed Q1 OKRs and staffing.   │
│  Review (3) │    3 a · 1 d        │                                    │
│  Plans      │                     │  TL;DR                             │
│             │  ○ Standup          │  • Hire 2 backend engineers       │
│  Settings   │    May 7 · 12 min   │  • Move launch to June 15         │
│             │                     │  • Block: vendor SOC2 pending     │
│             │  ○ Customer ABC     │                                    │
│             │    May 6 · 35 min   │  ▼ Full Notes                      │
│             │                     │  ▼ Actions · Decisions · Blockers  │
│ [▶ Record]  │                     │  ▼ Transcript                      │
│ user.menu   │                     │                                    │
│             │                     │  Toolbar: Re-summarize · Export    │
│             │                     │           · Open in Plan           │
└─────────────┴─────────────────────┴────────────────────────────────────┘
* "Live" pseudo-row only shown when capture.isRunning.
```

Sections:
- **Library** — three-pane (sidebar + meeting list + meeting detail). Default landing surface.
- **Live** — only present when a recording is active. Detail pane = existing `TranscriptView`, unchanged.
- **Review** — detail-only. Existing `ReviewView`.
- **Plans** — detail-only. Existing `PlanView`.
- **Settings** — detail-only. Existing `SettingsView`, plus a new `NotesFolderSection`.

Keyboard:
- ⌘1 / ⌘2 / ⌘3 / ⌘4 / ⌘5 — sidebar sections in order.
- ⌘N — start recording (also: bottom-of-sidebar Record button).
- ⌘F — focus the Library filter field.
- ⌘E — Export selected meeting.
- ⌘R — Re-summarize selected meeting.

Global recording-state UI (currently lives in `ContentView`'s header):
- Record button → sidebar footer (visible regardless of section).
- Meeting title field + ingest status → top of the Library detail pane during/after recording; collapses when idle.
- User menu → sidebar footer next to Record button.

## 5. Visual style — native macOS

Stop fighting SwiftUI defaults. Concrete swaps in the shell (existing per-view custom theming stays untouched for Phase 1):

| Element | Current | New |
|---|---|---|
| Sidebar background | `theme.current.surface` | `NavigationSplitView` material (automatic) |
| Window background | `theme.current.body` | system default |
| Sidebar selection highlight | custom accent pill | system automatic |
| Middle pane background | custom | `.background(.regularMaterial)` |
| Detail pane background | custom | system default |
| Section dividers | `Rectangle` of `theme.current.border` | `Divider()` |
| Accent color | mixed hardcoded values | `Color.accentColor` (system tint) |
| Typography (shell only) | custom `Typography.*` tokens | `.font(.headline)`, `.body`, `.callout`, `.caption` |
| Icons | mixed | SF Symbols only |
| Control sizes | mixed `.small` and `.regular` | `.regular` everywhere in shell chrome |
| Toolbar | custom HStack | SwiftUI `.toolbar { ... }` with `ToolbarItem`s |
| Window style | default | `.windowToolbarStyle(.unified)` so titlebar blends with sidebar |

`ThemeStore`, `Strings.swift` (`L.*`), `Spacing.*`, `Radius.*` all stay — existing views still depend on them. The custom `RecordingButton` stays as a brand element.

Net effect: structurally the app looks like Mail.app / Reminders.app / Notes.app. Transcript/Plan/Review view *bodies* retain their existing visual identity; we revisit per-view polish opportunistically, never as a blocker.

## 6. File-based notes storage

### 6.1 On-disk layout

```
<NotesFolder>/                                ← default ~/Documents/MeetNotes/,
│                                                 configurable in Settings
├── 2026/
│   └── 05/
│       ├── 2026-05-08-q1-planning.md
│       ├── 2026-05-07-standup.md
│       └── 2026-05-12-1430-untitled.partial.md   ← active recording
└── .meetnotes/                               ← app-managed, hidden
    ├── index.sqlite                          ← thin index (see 6.4)
    └── recovery/                             ← crash-recovery records
        └── 01HXYABC….json
```

The notes folder is user-visible and chosen by the user. The `.meetnotes/` subdirectory inside it holds the index and recovery state. We deliberately co-locate the index with the notes folder so a user moving their folder to a new machine (via cloud sync or USB) gets a re-indexable bundle.

### 6.2 File format

```markdown
---
id: 01HXY8ABCDEF1234567890ABCD          # ULID, stable across renames
title: Q1 Planning
started_at: 2026-05-08T14:00:00Z
ended_at:   2026-05-08T14:42:00Z
duration_seconds: 2520
participants: ["alice", "bob", "carol"]
platform: meet                           # meet | teams | zoom | mic
language: en
gist: Discussed Q1 OKRs and staffing decisions.
tldr:
  - Hire 2 backend engineers by end of May
  - Launch moves from May 30 to June 15
  - Vendor SOC2 review is blocking integration work
summary_generated_at: 2026-05-08T14:43:11Z
summary_model: claude-opus-4-7
---

## Summary

Discussed Q1 OKRs… *(full markdown notes)*

## Actions
- [ ] **alice** — hire 2 backend engineers (due 2026-05-31)
- [ ] **bob** — vendor SOC2 follow-up

## Decisions
- Launch moved from 2026-05-30 to 2026-06-15

## Blockers
- Vendor SOC2 review

## Transcript

[14:00:12] **alice**: Let's start with OKRs…
[14:00:34] **bob**: I think we should…
```

Compatible with Obsidian (frontmatter, headings, `- [ ]` tasks). Renders cleanly in any markdown viewer.

### 6.3 Live writing — `.partial.md` lifecycle

1. **On record start.** `MeetingFileStore` creates `<folder>/<YYYY>/<MM>/<YYYY-MM-DD-HHmm>-<slug>.partial.md` with frontmatter containing `id`, `started_at`, `platform`, `language`. Writes a `## Transcript` heading and nothing else yet. Writes a recovery record at `.meetnotes/recovery/<id>.json` containing `{id, path, pid, started_at}`.
2. **On each caption arriving.** Append `[HH:MM:SS] **speaker**: text\n` to the file. A `FileHandle` opened with append mode stays open for the duration of the recording. Writes are buffered in a 1-second flush window to keep iCloud sync overhead bounded.
3. **On Stop & Save.**
   - Update frontmatter (`ended_at`, `duration_seconds`, `participants`, final `title`).
   - Background: call `POST /kb/summarize` with the transcript + metadata.
   - On summary response: insert `## Summary`, `## Actions`, `## Decisions`, `## Blockers` sections **above** the Transcript, update frontmatter (`gist`, `tldr`, `summary_generated_at`, `summary_model`).
   - Atomic rename `.partial.md` → final filename via `FileManager.replaceItemAt`. Atomic on APFS. Remove the recovery record.
4. **On crash recovery (next app launch).** `PartialRecovery` scans `.meetnotes/recovery/`. For each orphan whose `pid` is not alive (or doesn't match a fresh app launch), prompt: *"Found unfinished recording from 2026-05-12 14:30 (42 captions). Recover and finalize?"* — yes runs the Stop & Save flow against the existing partial; dismiss leaves the `.partial.md` in place untouched.

### 6.4 Index (thin SQLite)

```sql
-- <NotesFolder>/.meetnotes/index.sqlite
CREATE TABLE meetings_index (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL,         -- relative to notes folder
  title           TEXT,
  started_at      INTEGER NOT NULL,      -- epoch ms
  ended_at        INTEGER,
  duration_sec    INTEGER,
  gist            TEXT,
  tldr_json       TEXT,                  -- raw JSON of bullets
  actions_count   INTEGER DEFAULT 0,
  decisions_count INTEGER DEFAULT 0,
  blockers_count  INTEGER DEFAULT 0,
  file_mtime      INTEGER NOT NULL,      -- detect external edits
  file_size       INTEGER NOT NULL,
  indexed_at      INTEGER NOT NULL
);
CREATE INDEX meetings_index_started_at ON meetings_index(started_at DESC);
```

Index contains no transcript bodies, no full notes, no entities — only what's needed to render the list pane fast. The `.md` file is canonical for everything else.

### 6.5 Folder watcher → index sync

`FolderIndexer` actor watches the notes folder via `DispatchSource.makeFileSystemObjectSource` (kqueue). On any change:
- Changed `.md` files where on-disk `mtime > file_mtime` in index → re-parse frontmatter, upsert the index row.
- Deleted files → remove the index row.
- Initial launch and Settings → "Rebuild index" command perform a full scan.

External edits (user changes a note in Obsidian) reflect in the Library list within seconds. The file is the source of truth; the index is always derived.

### 6.6 Linked-space picker

`SettingsView` gets a new "Notes folder" row showing the current absolute path with a *Change…* button. The picker is `NSOpenPanel` configured with `canChooseDirectories=true`, `allowsMultipleSelection=false`. When the chosen path is under one of the known cloud-sync roots:

| Path prefix | Badge |
|---|---|
| `~/Library/Mobile Documents/com~apple~CloudDocs/` | "Synced via iCloud Drive" |
| `~/Dropbox/` or `~/Library/CloudStorage/Dropbox/` | "Synced via Dropbox" |
| `~/Library/CloudStorage/GoogleDrive-*/` | "Synced via Google Drive" |
| `~/Library/CloudStorage/OneDrive-*/` | "Synced via OneDrive" |
| other | (no badge) |

No syncing logic on our side — cloud providers handle it. We display the badge so users know what to expect. Changing the folder triggers a full re-index against the new path.

We store the selection as a security-scoped bookmark (`URL.bookmarkData(options: .withSecurityScope)`) so the app can keep accessing it across launches under macOS sandboxing.

## 7. Server changes

Minimal — the server's role for meeting notes shrinks to stateless summarization.

### 7.1 New endpoint — `POST /kb/summarize`

Stateless. In: transcript + metadata. Out: structured summary.

Request body:
```json
{
  "transcript": "[14:00:12] alice: …\n[14:00:34] bob: …",
  "title": "Q1 Planning",
  "started_at": "2026-05-08T14:00:00Z",
  "duration_seconds": 2520,
  "participants": ["alice", "bob", "carol"],
  "language": "en"
}
```

Response:
```json
{
  "gist": "Discussed Q1 OKRs and staffing decisions.",
  "tldr": ["…", "…", "…"],
  "full": "## Summary\n…",
  "actions":   [{"owner": "alice", "text": "hire 2 backend engineers", "due": "2026-05-31"}],
  "decisions": [{"text": "Launch moved from 2026-05-30 to 2026-06-15"}],
  "blockers":  [{"text": "Vendor SOC2 review"}],
  "model": "claude-opus-4-7",
  "generated_at": 1715587391000
}
```

Single LLM call producing all layers (the model reasons better with shared context than three separate calls). Same prompt-injection wrapping (`<<<BEGIN>>>…<<<END>>>`) as existing endpoints. Same rate-limit family as `/generate-notes`.

Error code `SUMMARIZE_FAILED` added to the stable code list. Same retry-with-stricter-prompt pattern as the planner uses for malformed JSON.

### 7.2 New endpoint — `GET /kb/export-all`

Read-only NDJSON stream of all of the authenticated user's meetings + their entities. Cursor-paginated via `?cursor=<id>&limit=<n>`. Used exclusively by `LegacyExporter` (§8) — no other consumer. Same auth + rate-limit family as other read endpoints.

### 7.3 Existing endpoints — unchanged

`/kb/live/append`, `/kb/live/finalize`, `/kb/ingest`, `/generate-notes`, `/kb/search`, `/kb/plans*`, `/kb/review/*`, `/kb/agent/*`, plus auth and vault — all unchanged. The Chrome extension keeps using them. The Mac app stops calling `/kb/live/*` and `/kb/ingest` for new meetings (Mac-side storage handles persistence now), but does not call any removal/cleanup.

Plans, review queue, outcomes, agent feedback — these stay in server-side SQLite. They need relational structure and cross-meeting joins; they're not meeting notes.

## 8. Legacy data — one-time export

On first launch of the new shell after upgrade, `LegacyExporter` runs:

1. Probe legacy data via a new helper endpoint `GET /kb/export-all` that streams meeting records (NDJSON, one meeting + its entities per line). Pagination via `?cursor=`. The existing `/kb/search` returns ranked snippets, not full records, so it's a poor fit for export.
2. If count > 0, present a modal:
   *"You have N meetings stored from before the new file-based system. Export them to your Notes folder as `.md` files?"* — buttons: **Export now** / **Skip for now** / **Don't ask again**.
3. **Export now.** Stream meetings; for each, build the markdown with full frontmatter, summary sections, transcript, and write to `<folder>/<YYYY>/<MM>/<slug>.md`. Progress bar. Idempotent — skip when the `id` already exists in the index.
4. After export, legacy meetings remain in the server DB (never auto-deleted). Manual cleanup is a future Settings → Storage feature, not in Phase 1.
5. **Skip for now.** Re-prompt at next launch. **Don't ask again** sets a user-default flag and never re-prompts.

New meetings go only to files. The Library reads only the index. Legacy DB meetings stay invisible to the new Library unless exported.

## 9. Multi-level summary trigger points

1. **Auto on Stop & Save.** After the partial-rename completes, fire `/kb/summarize` in the background, then rewrite the file with summary sections inserted above the transcript. Meeting appears in Library immediately with a "Summarizing…" badge; resolves to gist+TL;DR when ready.
2. **Manual re-summarize.** Toolbar `Re-summarize` button (⌘R) on the detail pane. Same endpoint, overwrites summary frontmatter + sections.
3. **Backfill on first view.** Opening a `.md` that has a transcript but no `gist`/`tldr` (e.g. one created by a third-party tool, or an old export) shows a one-time "Generate gist & TL;DR" button. Doesn't auto-run — avoids surprise LLM costs on a large imported library.

Loading state: skeleton placeholders in detail pane while summarizing. Gist + TL;DR always expanded; Full Notes expanded by default for the newest meeting only; Transcript collapsed by default.

## 10. Code organization

### 10.1 New files (client)

```
mac/Sources/MeetNotesMac/
├── Views/
│   ├── ContentView.swift                       MODIFIED: hosts AppShell when flag on
│   ├── AppShell.swift                          NEW NavigationSplitView root
│   ├── Library/
│   │   ├── LibraryView.swift                   NEW middle pane (list)
│   │   ├── LibraryRow.swift                    NEW list row
│   │   ├── MeetingDetailView.swift             NEW detail pane
│   │   └── SummarySections.swift               NEW disclosure groups
│   ├── Shell/
│   │   ├── SidebarView.swift                   NEW sections + record footer
│   │   └── ShellToolbar.swift                  NEW unified toolbar
│   └── Settings/
│       └── NotesFolderSection.swift            NEW picker + sync badge
├── ViewModels/
│   ├── LibraryViewModel.swift                  NEW queries MeetingIndex
│   └── MeetingDetailViewModel.swift            NEW loads .md + re-summarize
├── Models/
│   ├── MeetingFrontmatter.swift                NEW Codable for YAML header
│   └── MeetingSummary.swift                    NEW Codable for /kb/summarize
└── Services/
    ├── NotesFolder/
    │   ├── NotesFolderConfig.swift             NEW chosen path + bookmark
    │   ├── MeetingFileStore.swift              NEW create/append/finalize
    │   ├── FrontmatterCoder.swift              NEW YAML ⇄ Codable
    │   ├── FolderIndexer.swift                 NEW kqueue + sqlite upsert
    │   ├── MeetingIndex.swift                  NEW SQLite wrapper
    │   └── PartialRecovery.swift               NEW orphan recovery
    ├── LegacyExporter.swift                    NEW one-time DB → files dump
    └── LiveSessionMirror.swift                 MODIFIED writes through
                                                 MeetingFileStore now
```

### 10.2 Server files

```
extension/kb/router.mjs                         MODIFIED add POST /kb/summarize
extension/agents/summarize.mjs                  NEW prompt + retry orchestration
                                                 (or extend agents/notes-prompt.mjs)
```

No new migrations on the server side — `/kb/summarize` is stateless.

### 10.3 Shell state

```swift
@Observable final class ShellState {
    enum Section: Hashable { case library, live, review, plans, settings }
    var section: Section = .library
    var selectedMeetingId: String? = nil
    var libraryFilter: String = ""
}
```

Lives at `AppShell` level, injected as `@Environment` into descendants. `DeepLinkRouter`'s existing `pendingTab` string maps to `Section` via a thin adapter (`"transcript"` → `.live`, `"history"` → `.library`, others unchanged). Router itself is not modified.

## 11. Error handling

| Failure | UX |
|---|---|
| Notes folder unreadable / permissions revoked | Blocking banner in Library, "Choose folder…" button. Recording disabled until resolved. |
| Disk full while appending caption | Buffer in memory, non-blocking toast every 30s while space stays low. Recording continues — losing captions on disk is worse than losing them in RAM. |
| External edit during recording (mtime collision) | Detect via mtime check before each flush; if external mtime > our last-write mtime, write to `*.conflict-<timestamp>.md` and surface a banner. Do not merge. |
| Index out of sync with files | "Rebuild index" command in Settings → Storage. Also auto-runs on app launch when the count of `.md` files in the folder differs from the index row count by more than 5, or by more than 5% — whichever is larger. |
| Crash mid-recording | `PartialRecovery` prompt on next launch (§6.3). |
| `/kb/summarize` fails | `.md` already on disk with full transcript. Detail pane shows "Summarize" button + error banner. User keeps their data. |
| Server offline | Existing banner pattern from `SessionStore`. Recording continues to disk; summarize fails gracefully (above). |
| Auth expired mid-fetch | Existing JWT refresh path. Hard failure → `SessionStore.clear()` → `LoginView`. Unchanged. |
| Legacy export fails partway | Idempotent retry on next prompt — already-exported meetings skipped via index. |
| Deep link arrives while signed out | Existing `DeepLinkRouter` pending-link logic replays after login. Unchanged. |

New error code: `SUMMARIZE_FAILED`. No other additions to the stable code list.

## 12. Testing

| Test | Framework | Covers |
|---|---|---|
| `AppShellTests` | XCTest | Section switching, deep-link section mapping, ⌘1–5 shortcuts |
| `LibraryViewModelTests` | XCTest | Filter behavior, sort order, selection persistence |
| `MeetingDetailViewModelTests` | XCTest | Load states, re-summarize transitions, error recovery |
| `MeetingFileStoreTests` | XCTest | Partial creation, caption append, finalize-and-rename atomicity |
| `FrontmatterCoderTests` | XCTest | YAML round-trips: unicode, multi-line, lists, missing fields |
| `FolderIndexerTests` | XCTest | External edit detection, deletion, full rescan |
| `PartialRecoveryTests` | XCTest | Orphan detection, replay against existing partial |
| `LegacyExporterTests` | XCTest | Idempotency, partial-failure resume |
| `extension/tests/summarize.test.mjs` | `node:test` | `/kb/summarize` happy path, malformed-JSON retry, prompt-injection wrapping |
| Manual checklist | — | iCloud folder, Dropbox folder, very large transcript, rapid start/stop, external edit during meeting, deep link arrival, dark + increased-contrast modes, reduce-transparency |

No UI snapshot tests — brittle on SwiftUI and Phase 1 is about feel, which snapshots don't capture meaningfully.

## 13. Migration & rollout

1. **PR 1:** Add `MeetingFileStore`, `FrontmatterCoder`, `MeetingIndex`, `FolderIndexer`, `PartialRecovery`, `NotesFolderConfig`. No UI changes — flag-gated, dev-only paths. Tests for each.
2. **PR 2:** Add `/kb/summarize` server endpoint + tests. Mac app calls it but doesn't yet use the result anywhere visible.
3. **PR 3:** Add `AppShell`, `SidebarView`, `Library*` views. `FeatureFlags.newShell = true` in dev; `false` in release. Existing `ContentView` tab path still default in release.
4. **PR 4:** `LegacyExporter` + Settings → Notes folder picker + sync-badge detection. Recovery prompt wired up.
5. **PR 5:** Flip `FeatureFlags.newShell` default to `true` in release. Old tab shell remains as fallback for one release cycle.
6. **PR 6:** Delete `HistoryView`, old tab shell, and the `LiveSessionMirror` server-write codepath.

Each PR is shippable on its own. Reverting any PR rolls back cleanly because of the flag gate.

## 14. Open questions

None blocking. Things we'll decide during implementation rather than now:
- Exact slug strategy for filenames when the meeting has no title yet (current placeholder: `untitled` → renamed on Stop & Save when title is known).
- Whether the recovery prompt should default-focus *Recover* or *Dismiss* (current bias: *Recover*, since accidentally finalizing is reversible — the file is still on disk — but accidentally dismissing leaves an orphan).
- Whether to fsync per-flush or rely on macOS's `F_FULLFSYNC` only on finalize (current bias: per-flush fsync; the iCloud-sync cost is bounded by the 1s buffer).

## 15. Phasing

| Phase | Scope | Status |
|---|---|---|
| **1 (this spec)** | IA redesign, native polish, file-based notes, multi-level summaries on stop | This document |
| 2 | File attachments per meeting, linked workspace folders, generated-artifacts library | Future spec |
| 3 | Global Cmd+K search across `.md` files; "Ask" mode (RAG over notes) | Future spec |

Each phase ships independently with its own design doc and implementation plan.
