# Design: Show all file types in the Doc Gen source panel

**Date:** 2026-07-22
**Surface:** macOS app — Doc Gen source panel (`mac/Sources/LlmIdeMac/Views/DocGen/DocGenSourcePanel.swift`)
**Status:** Approved (brainstormed); awaiting spec review

## Problem

The user expects the project `data/` folder to show **every** file type they add, and to
be able to edit those files. Two findings reshaped the scope during brainstorming:

1. **Editing already works for every file type.** `FileDetailView`
   (`mac/Sources/LlmIdeMac/Views/Library/FileDetailView.swift`) renders a detail view per
   kind and — on **all** kinds — supplies an "Open in App" toolbar button (line 27,
   `NSWorkspace.shared.open(url)`) plus "Reveal" (line 33). Text/code/markdown are fully
   editable in-app via `EditableTextDetailView`; office/unknown files get a QuickLook
   preview **plus** their own "Open" button (lines 628–642). So "edit them" is already
   satisfied — no change required.

2. **The Library sidebar already lists every file type.** `LibraryItemStore.performScan`
   applies an extension allow-list **only** to `.code`; the `.data` category has no
   filter, so every regular file in `data/` is listed. The "Add file" picker
   (`LibraryView.pickFile`) uses an unrestricted `NSOpenPanel`. So single-file
   "store + see all kinds" already works in the Library.

The **only** place that hides file types is the **Doc Gen source panel**, whose
`textSources(from:)` helper filters the Data, Notes, and Sources sections down to
`["md", "markdown", "txt", "json", "csv"]`. Its empty-state hints even say
"No .md/.txt/.csv data files in Library yet". This is the gap the user is hitting.

## Goal

List **all** files (every extension) in the Doc Gen source panel's Data, Notes, and
Sources sections, while keeping Doc Gen generation correct when a selected source is not
text-readable.

## Non-goals (explicitly out of scope)

- Chat-side document text extraction / vision routing for office docs, PDFs, and images
  (the broader "Approach 1"). The user narrowed scope to "show-all + edit only"; chat
  usage of these files is **not** changed by this work.
- Folder-import into `data/` (currently `LibraryItemStore.addFolder` only accepts `.code`).
  Real bug, but unrelated to "show / edit" — deferred.
- Drag-and-drop import into the Library. Deferred (YAGNI).
- An "Open / edit from Doc Gen row" affordance (double-click or context menu). Optional
  extra, declined for now — editing remains reachable via the Library detail view.
- In-app editing of binary formats (`.xlsx`, `.png`, …). Not feasible; "edit" for those
  means "Open in default app", which already exists.

## Design

### Change 1 — Remove the text-only filter (the entire code change)

In `DocGenSourcePanel.swift`, stop filtering the three source sections through
`textSources(from:)`. List all items returned by `itemStore.items(for:)` directly:

- `notesSection` (line 171): `itemStore.items(for: .notes)` — all notes-folder files.
- `dataSection` (line 191): `itemStore.items(for: .data)` — all data-folder files.
- `sourcesSection` (line 211): `itemStore.items(for: .meetings)` — all meeting files.

Update the three `emptyHint(...)` strings to drop the ".md/.txt/…" specificity
(e.g. "No data files in Library yet").

`iconForExt(_:)` (line 326) already maps several extensions (`pdf`, `csv`, `xlsx`, `xls`,
`json`, …) to icons and falls back to a generic `"doc"`, so newly-shown file types render
with a sensible icon. No new icon mapping required for the common types.

The `textSources(from:)` helper (lines 337–340) becomes unused → delete it.

### Why non-text sources are already safe (no new VM code)

`fileRow` (line 311) already renders a ⚠️ when
`vm.unreadableSourceNames.contains(item.name)`. That set is populated by
`DocGenViewModel.generate` (`mac/Sources/LlmIdeMac/ViewModels/DocGenViewModel.swift`):

```swift
case .file(let url, let name):
    if let content = try? String(contentsOf: url, encoding: .utf8) {   // line 51
        sources.append((name: name, content: content))
    } else {
        skippedSources.append(name)                                     // -> unreadableSourceNames
    }
```

`String(contentsOf:encoding: .utf8)` is **strict**: binary files (`.png`, `.xlsx` zip,
`.pdf`, audio/video, etc.) fail UTF-8 decoding, throw, and fall into `skippedSources`,
which becomes `unreadableSourceNames` (line 59) → the ⚠️ shows on the row, and the file is
excluded from the generated doc. Generation still succeeds as long as at least one
readable source remains (line 60). So removing the filter does **not** let binary garbage
into the prompt — the existing read path already rejects it.

### Edge case (acknowledged, not solved here)

A file that is binary but happens to be **valid UTF-8** (rare) would decode successfully
and be fed as content. Hardening with a NUL-byte / control-char heuristic (mirroring the
chat-attachment check in `CodeAssistant+Attachments.swift`) is a possible follow-up but is
**out of scope** — strict-UTF-8 rejection covers the common binary formats.

## Risks

- **Visual density**: projects with many non-text files in `data/` will now show them all
  in Doc Gen, including files Doc Gen can't consume. Mitigated by the ⚠️ unreadable marker
  and the generic-icon fallback; acceptable per the user's explicit "show all files there
  too".
- **No regression in generation**: binary selection is handled by the existing skip path;
  verified by the design above, to be confirmed by manual drive.

## Verification

The mac app currently has **no active test target** (`swift test` reports "no tests found";
the pre-push hook's mac gate is bypassed for this reason). So verification is:

1. `swift build` — compiles cleanly after removing the helper + call sites.
2. Manual drive in a running app:
   - Add a non-text file (e.g. `.png`, `.xlsx`) and a text file (`.md`) to a project's
     `data/` folder via the Library.
   - Open Doc Gen: confirm **both** files appear in the Data section.
   - Select the binary source and generate: confirm the ⚠️ appears on the binary row and
     the doc still generates from the `.md`.
   - Confirm the empty hint reads generically when `data/` is empty.
3. Regression spot-check: Notes and Sources sections still list their files; selecting
   only readable sources generates normally.

## Future / follow-ups (not in this spec)

- Folder-import into `data/` (fix `LibraryItemStore.addFolder` `.code`-only guard).
- Chat-side extraction + vision so office docs/PDFs/images are actually readable in chat
  (the deferred "Approach 1").
- NUL-byte hardening for valid-UTF-8 binaries on the Doc Gen read path.
- Optional "Open" affordance on Doc Gen rows.
