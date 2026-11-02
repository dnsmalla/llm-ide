# Library parity triage (verified)

Scope: 60 Mac labels from `mac/Sources/LlmIdeMac/Features/Library/` (notes list and detail, Box/Email/Slack/connector sheets, Settings Connections card) with no literal match in the desktop Library, Settings Connections, shell, ui kit or `notes_fs.rs`/`notes_write.rs`. First pass by Haiku (`g11-out.json`), verified by Opus against the Swift and desktop sources at `4f5a137a`. Per-label results: scratchpad `triage/library-verified.json`.

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REWORDED | 30 | 32 |
| REAL_GAP | 16 (10 features) | 12 (8 features) |
| RUNTIME | 8 | 10 |
| MAC_ONLY | 6 | 6 |
| DEAD_ON_MAC | 0 | 0 |

11 rows changed: 4 REAL_GAP overturned, 1 REWORDED evidence corrected, 6 REAL_GAP rows had their gap, needs or evidence corrected. All 16 REAL_GAP, all 6 MAC_ONLY, all 8 RUNTIME and 19 of 30 REWORDED (63%) were checked at file:line.

## Reclassifications

| Label | Haiku | Verified | Reason |
|---|---|---|---|
| Open Google App Passwords… | REAL_GAP | REWORDED | Desktop Gmail card has "Open your Google Account" next to the App passwords path (`ui/screens/library/sources/SourcePanes.tsx:422-426`). It opens `myaccount.google.com` on purpose, host-validated (`google/easy.ts:29-30,93`). Same control, shallower URL. |
| Transcript available — no summary yet. | REAL_GAP | RUNTIME | A nudge banner. The action is on the desktop toolbar for every meeting ("Re-summarise", `write/NoteWorkspace.tsx:184-188`) and on Cmd/Ctrl+R (`:141-148`). |
| Summarize (backfill button) | REAL_GAP | REWORDED | Same action as "Re-summarise" above. |
| No detailed notes yet. | REAL_GAP | RUNTIME | Empty text inside the "Full LLM Doc" disclosure (`SummarySections.swift:118-131`). Desktop hides the empty card (`MeetingDetail.tsx:98-104`), nothing lost. |
| Re-summarize this meeting (⌘R) | REWORDED | REWORDED | Class kept. Haiku said there was no Cmd+R binding, but `NoteWorkspace.tsx:141-148` binds it. |
| Previously selected — not in the current channel list | REAL_GAP | REAL_GAP | Gap narrowed. Haiku said such channels were "not shown", but they are listed as text in "Chosen: #…" (`SourcePanes.tsx:612-614`). They still cannot be unticked: there is no checkbox, and "Add" is disabled for an id that is already chosen (`:603`). They keep being fetched (`:634`). |
| Remove from List / Remove All | REAL_GAP rust | REAL_GAP core/decision | The tombstone is ONLY `meetings_index.hidden = 1` in the Mac's per-project SQLite `<project>/system/index.sqlite` (`Core/Notes/Services/MeetingIndex.swift:113-116,175-180`; `Core/Platform/AppEnvironment.swift:42-51`). Nothing goes into the `.md`, no sidecar is written and the server stores nothing. The Mac reconciler sends hidden keys to the core as `hidden:true`, which only drops them from search (`extension/kb/note-index.mjs:68-72,150-156`). No `/kb/index` route stores a tombstone (`extension/routes/index-routes.mjs:25-74`). Where the hidden set lives is a decision. |
| Add File | REAL_GAP | REAL_GAP | Needs confirmed and sharpened. `fs_copy` is root-confined on both ends (`fs_ops.rs:1016-1031`), and `attach_pick_files` returns handles only (`attach.rs:236-262`). No command writes picked bytes into the project. The Mac replaces a same-name file (Trash, with a permanent `removeItem` fallback, `LibraryItemStore.swift:424-429`), and the desktop must not copy that. |
| Add Folder | REAL_GAP | REAL_GAP | Confirmed: `addFolder` returns at once unless `category == .code` (`LibraryItemStore.swift:445`), so on the Mac it is a silent no-op outside Code. Under Code it adds an external in-place reference. That would widen the desktop's root-confined file access, so it is a product/security decision. |

Confirmed unchanged (REAL_GAP): Box developer console link, Library file remove (permanent delete confirmed at `LibraryItemStore.swift:571-588`), Reveal Folder in Finder, note-open Retry, save-panel export, Slack Select All / Select None.

## Merged table by feature

| Feature | Final class | Labels | Evidence | Missing / needs / effort / risky / safe now |
|---|---|---|---|---|
| connectors-catalog | REWORDED | 14 | ConnectorsPane: catalog, Add to Library, Shown/Hidden badge, Documentation link, NOT_READY, Remove confirm with CATALOG_SELECTION_NOTE (`SourcePanes.tsx:963-1066`); Settings empty text `sources-model.ts:81` | - |
| connector-detail-pane | MAC_ONLY | 1 | No per-connector detail screen on desktop; cards render in place, so "not found" cannot occur | - |
| box-source-form / email-source-form / slack-source-form | RUNTIME | 7 | Example placeholders; fields mirrored (`SourcePanes.tsx:702,718,300`). Display name is read only by the Mac Slack card subtitle | - |
| box/email/slack-disconnect | REWORDED | 3 | DISCONNECT_TEXT (`source-text.ts:35-39`) in confirm dialogs (`SourcePanes.tsx:380,655,777`); vault key cleared (`:783`) | - |
| email-source-form (Advanced) / google-oauth-client | REWORDED | 2 | Email pane IMAP + app password, Gmail card, Google Advanced OAuth client (`GooglePane.tsx:140-143,752`) | - |
| slack-token-form | REWORDED | 1 | "Slack token (optional)" always shown (`SourcePanes.tsx:544`) | - |
| sources-entry / settings-connections | REWORDED | 2 | Source panes in the Library nav; Settings Connections catalog | - |
| library-empty-states / library-load-error | REWORDED | 5 | "No Meetings Yet" (`NoteList.tsx:336`), "Select an Item" (`LibraryScreen.tsx:262-263`), LoadError + Try again (`States.tsx:28-31`) | - |
| resummarize / summary-progress / meeting-summary-backfill (button) | REWORDED | 4 | Re-summarise + Cmd/Ctrl+R + progress line + Cancel (`NoteWorkspace.tsx:141-195`) | - |
| meeting-summary-backfill (banner), library-row-status, meeting-full-notes | RUNTIME | 3 | State decorations; actions present | Optional polish only |
| gmail-app-passwords link | REWORDED | 1 | "Open your Google Account" (`SourcePanes.tsx:424`) | - |
| meetings-auto-capture | MAC_ONLY | 5 | AX-based AutoCapture run as an Auto Task module, driving Live's caption scraper (`ConnectionsSettingsSection.swift:199-258`). The desktop has no Live screen; this belongs to the per-OS capture track | - |
| source-setup-doc-links (Box) | REAL_GAP | 1 | `BoxSourceSheet.swift:99-103` | Box pane link to `https://app.box.com/developers/console` via `env.openExternal`; ui; S; not risky; safe now |
| library-reveal-folder | REAL_GAP | 1 | `LibraryView.swift:583-599` (Meetings '+' menu only) | Reveal the meetings folder (`llm-doc/source/meetings`, falling back to `llm-doc/source`) through the existing `onRevealPath`/`reveal_in_os` (`index.tsx:108`, `os_open.rs:341-360`); ui; S; not risky; safe now |
| note-open-error-retry | REAL_GAP | 1 | `MeetingDetailView.swift:75-83` | Retry button in the NoteViewer error state (bump `reloadKey`); today only the nav "Refresh notes" re-reads; ui; S; not risky; safe now |
| slack-channel-select | REAL_GAP | 2 | `SlackSourceSheet.swift:195-253` | Select All / Select None, plus a checkbox row for each chosen channel that is missing from the loaded list; ui; S; not risky (edits the pending selection only; Save and Fetch stay explicit); safe now |
| library-file-remove | REAL_GAP | 2 | `LibraryFileRow.swift:25-44` -> `LibraryItemStore.swift:571-588` (permanent `removeItem`) | Library-level remove of a project file. Today it is reachable only through Open in Explorer -> Trash (`ui/screens/explorer/fs.ts`, `fs_delete`). ui (`fs_delete` exists); S; risky (deletes files); HOLD |
| meeting-remove-from-list | REAL_GAP | 2 | `LibraryRow.swift:121-126`, `LibraryView.swift:861-915`, `MeetingIndex.swift:175-180` | Persisted per-project hidden set + list filter + "Show hidden"/undo; core or rust (decision); M; not destructive; not safe now (decision) |
| library-add-files-folders | REAL_GAP | 2 | `LibraryView.swift:571-640`, `LibraryItemStore.swift:398-458` | Add File: Rust import command (pick -> copy into category dir, refuse or suffix on conflict); M; risky (writes into the project). Add Folder: Code-only external reference, widens root confinement; L; product decision |
| save-panel-export | REAL_GAP | 1 | `MeetingDetailView.swift:194-199,282-305` | Rust save-dialog export outside the root; S-M; risky (may overwrite a user-chosen file); HOLD |

## Implementation batches

**Batch A: small pure-UI, safe now**
1. Box pane: "Open Box Developer Console" link (`SourcePanes.tsx` BoxPane, fixed https URL through `env.openExternal`).
2. Library Meetings group: "Reveal folder" action via `onRevealPath` on the meetings raw dir. Show the host error text if the folder does not exist yet.
3. NoteViewer error state: "Retry" that bumps a local reload counter.
4. Slack pane: Select All / Select None over the loaded list, plus checkbox rows (muted, with the "not in the current channel list, may need a broader Slack permission" hint) for chosen ids that are missing from it. No auto-save.
Optional polish, not gaps: a nudge line in `MeetingDetail.tsx` for a meeting that has a transcript but no summary; a "Re-summarise" item in the note row context menu.

**Batch B: UI plus a small host/core change.** None. The only UI-on-existing-host item (Library file remove on `fs_delete`) deletes files and is on HOLD below.

**Batch C: Rust/core/product decision**
- Remove from List / Remove All (decision: where the tombstone lives). Options: (a) read and write the Mac's `<project>/system/index.sqlite` `meetings_index.hidden` from Rust, which gives true cross-app parity but means two processes writing a Mac-owned DB and needs a busy-timeout plus schema-version check; (b) a desktop JSON sidecar under `<project>/system/`, simple but not shared with the Mac; (c) a core per-project hidden table behind a `/kb/index` route (API bump), which the Mac would also have to adopt. Recommendation: (a) only if Mac and desktop must agree; otherwise (c), so both apps converge on one store. It is not destructive, so the store can be built and tested before any UI ships.
- Add File: new Rust command that imports picked handles into `<root>/<category dir>/`, using create-new semantics (refuse or suffix, never replace) and size limits.
- Add Folder (Code external references): product/security decision on widening the root-confined file boundary. Recommend: do not build it until there is a use case; do not mirror the Mac's no-op on other sections.

**HOLD (deletes or overwrites files)**
- library-file-remove: allowed only as Trash through `fs_delete` (no permanent fallback, per desktop policy). The confirm text must say "moved to the Trash", must name the file, and needs an explicit confirm button. Do NOT copy the Mac's permanent `removeItem`. The Mac's behaviour is itself worth flagging: it permanently deletes despite saying "Remove from Library".
- save-panel-export: OS save dialog only (the OS asks before replacing), refuse source == destination after resolving symlinks, write a temp file and rename, never follow a symlink at the destination. Keep the current `llm-doc/export/` export as the default.
- Add File's conflict policy (above): never replace an existing project file.

No item handles tokens or credentials, and none newly ingests external content. The Slack selection change only edits the pending selection.

## Not verified

- GUI behaviour: no app was run; everything here comes from reading the sources.
- Whether `reveal_in_os` on a missing meetings folder returns a friendly error (resolver uses `resolve_existing`, so it errors; the wording was not checked).
