---
title: Activity bar + workspace Search
status: draft
date: 2026-06-15
---

# Activity bar + workspace Search — design

## Goal

A VS Code / Cursor-style navigation: 3 primary buttons — **Explorer**,
**Search**, **Source Control** — with the app's other sections tucked into a
**⋯ More** overflow; plus a real workspace **Search** (file names + contents).

## Features

### A. Workspace Search (new `.search` section)

- **`SearchService`** (`@MainActor @Observable`): `search(query:root:)` walks the
  workspace root (active repo, same as Explorer/SCM), noise-filtered, and
  matches:
  - **file names / paths** (case-insensitive substring), and
  - **file contents** — line-by-line, text files only (skip when the first 4 KB
    contains NUL bytes or the file exceeds ~1 MB).
  - Returns `[FileMatch]` where `FileMatch { url, displayPath, nameMatched,
    lines: [LineMatch { line: Int, text: String }] }`. Caps total matched lines
    (e.g. 1000) and files; runs the walk off the main thread; cancellable
    (a new query supersedes the previous).
- **`SearchView`**: a query field (debounced ~250 ms) + results grouped by file
  (file header → matching line rows with line numbers and the matched text).
  Clicking a line **opens that file** in a tabbed editor (reuse `EditorTabBar`
  + `FileDetailView`, same as Explorer). Empty state ("Search files by name or
  content"), no-results state, and a result/elapsed count.
- Root = `config.activeRepoLocalURL` (exists) → active project folder → nil
  (empty state) — identical preference to Explorer.

### B. Activity bar (sidebar restructure)

Rework `SidebarView` into an activity bar driving `shell.section`:

- **3 primary buttons** rendered prominently at the top: Explorer
  (`folder`), Search (`magnifyingglass`), Source Control
  (`arrow.triangle.branch`). The active one is highlighted.
- **⋯ More** control (menu or expandable list) holding every other section:
  Library, Live, Doc Gen, Review Code, Review Doc, Review Conflicts, Auto
  Tasks, Code Graph, Regression, Issues, Gantt, Visual. Selecting one switches
  `shell.section` and the active highlight moves there (the More button shows
  the active state when a non-primary section is selected).
- Preserve: the `isVisible` hidden-section filter, the "Live" recording dot,
  and the existing footer (profile/help/permissions; Settings reached there as
  today).
- The selection mechanism stays `shell.section` so `AppShell.sectionView`
  routing is unchanged aside from the new `.search` case.

## Components affected / created

- Create: `Services/SearchService.swift`, `Views/Search/SearchView.swift`.
- Modify: `Services/ShellState.swift` (`.search` case + label/icon/tint/
  category), `Views/AppShell.swift` (route `.search` → `SearchView`), `Views/
  Shell/SidebarView.swift` (activity-bar layout).
- Tests: `Tests/.../SearchServiceTests.swift` (pure matcher over a temp dir).

## Data flow

1. Activity bar button → sets `shell.section` → `AppShell.sectionView` renders
   Explorer / SearchView / SourceControlView; ⋯ More → any other section.
2. Search: type → debounce → `SearchService.search(query:root:)` (cancels the
   prior run) → grouped `[FileMatch]` → results list.
3. Click a result line → append/activate a tab → `FileDetailView` opens the
   file (gutter markers apply).

## Error handling

- Search: unreadable files skipped; binary/oversized skipped; empty query →
  cleared results; no root → empty state. A superseded query's results are
  discarded (cancellation), never overwriting a newer query.
- Activity bar: a hidden/unavailable section simply doesn't appear in ⋯ More.

## Testing & verification

- **Pure/unit:** `SearchService` matcher against a temp dir tree — filename
  match, content line match (with line numbers), binary/oversized skip, noise
  dir skip, cap enforcement. (Compile + contract; XCTest doesn't run here.)
- **Runtime (real dir):** run a search against a real folder and confirm the
  matches/line numbers; build + launch smoke for the activity bar (3 buttons
  switch the panel; ⋯ More reaches other sections). GUI clicks login-gated.

## Risks

- **SidebarView rewrite** must not break the `NavigationSplitView`/selection
  wiring or lose access to any section — keep `shell.section` as the single
  selection source and route everything (primary + More) through it; verify
  every section is still reachable.
- **Search performance** on large repos — cap results + file size, walk off
  the main thread, debounce, and cancel superseded queries. Shelling out to
  ripgrep is a future optimization; the Swift walk is the portable baseline.
- Reuse the Explorer's tabbed-editor pattern for opening results so behavior
  (and gutter markers) stays consistent.
