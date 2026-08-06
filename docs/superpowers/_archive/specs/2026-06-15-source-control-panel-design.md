---
title: Source Control panel (Phase 1)
status: draft
date: 2026-06-15
---

# Source Control panel (Phase 1, Lean MVP) — design

## Goal

A Cursor-style Source Control panel: see working-tree changes, stage/unstage/
discard per file, view a syntax-aware colored diff, and commit — all on the
active cloned repo, without leaving the IDE.

## Scope (Lean MVP)

In:

- Changed-files list from `git status` (staged / unstaged / untracked).
- Per-file stage, unstage, discard (discard confirmed; destructive).
- Per-file unified diff, colored +/− rows with dual line-number gutters;
  syntax highlighting added as the final step.
- Commit (message box + Commit button). Commit only — **no push**.
- Branch name + ahead/behind indicator. Manual + on-focus refresh.

Out (later phases): push button, filesystem-watcher auto-refresh, history/log,
blame/file-follow, per-hunk staging, side-by-side diff, branch switching,
stash, conflict resolution, multi-repo picker.

## Target repository

The panel operates on `config.activeRepoLocalURL` (the active cloned
GitLab/GitHub repo — already what `RepoManager` targets). When none is active
or the path is not a git repo, the panel shows an empty state directing the
user to activate a repo in Settings.

## Architecture

A thin service over the existing git seam — no new exec path, no git library.

### `SourceControlService` (`@MainActor @Observable`)

Wraps `RepoManager`'s `/usr/bin/git` runner (extended with a stdout-returning
variant if not already present). Methods target a repo `URL`:

- `refresh()` — runs `git status --porcelain=v1 --untracked-files=all` and
  branch/ahead-behind queries; updates the observable `state`.
- `diff(path:staged:)` — `git diff [--cached] -- <path>`; returns the raw
  unified-diff string.
- `stage(path:)` — `git add -- <path>`.
- `unstage(path:)` — `git restore --staged -- <path>`.
- `discard(path:)` — tracked: `git restore -- <path>`; untracked: delete the
  file. Caller confirms first.
- `commit(message:)` — delegates to `RepoManager.commit`.

State shape:

```
struct SCMState {
    var branch: String?         // nil when detached / no repo
    var ahead: Int
    var behind: Int
    var files: [FileChange]
    var isLoading: Bool
    var error: String?
}
```

### Pure helpers (unit-tested directly, no git needed)

- `StatusParser.parse(porcelain: String) -> [FileChange]` — parses
  `git status --porcelain=v1` lines (XY codes, rename `->`, untracked `??`)
  into typed `FileChange`s with staged/unstaged classification.
- `UnifiedDiffParser.parse(_ diff: String) -> [DiffHunk]` — parses git's
  unified diff (`@@` headers, `+`/`-`/context lines, `\ No newline`, binary
  marker) into hunks of typed rows with old/new line numbers.

### Models

```
struct FileChange: Identifiable, Hashable {
    var path: String            // repo-relative
    var displayPath: String
    enum Status { case added, modified, deleted, renamed, untracked, conflicted }
    var status: Status
    var staged: Bool
    var id: String { (staged ? "S:" : "U:") + path }
}

struct DiffRow { enum Kind { case context, insert, delete }
    var kind: Kind; var oldLine: Int?; var newLine: Int?; var text: String }
struct DiffHunk { var header: String; var rows: [DiffRow] }
```

A file modified both in index and working tree appears as two entries (one
staged, one unstaged) — matching git/VS Code behavior.

## UI

### Sidebar wiring

New `ShellState.Section` case `.sourceControl` (icon `arrow.triangle.branch`,
a green-family tint, category "Code"), added to `SidebarView.codeSections`
and routed in `AppShell.sectionView` to `SourceControlView(api:)`. Optional
deep-link key omitted for MVP.

### `SourceControlView` — two-pane (`HSplitView`, mirrors `ReviewView`)

- **Left pane:**
  - Branch header: branch name, `↑ahead ↓behind` chips, Refresh button.
  - **Staged Changes** group and **Changes** group (unstaged + untracked),
    each a list of `FileChangeRow`: status badge (letter + color), display
    path, and hover actions — stage `+` / unstage `−` and discard (trash).
  - Commit box pinned at the bottom: multiline message `TextField` + **Commit**
    button, disabled when no staged files or the message is empty.
- **Right pane:** `UnifiedDiffView` of the selected `FileChange`, fed by
  `service.diff(path:staged:)` → `UnifiedDiffParser`. Empty state when nothing
  selected.

### `UnifiedDiffView`

Lifted from the existing colored-row + dual-gutter renderer in
`Agent/Views/UpdateFileSheet.swift` into a standalone view, but fed by parsed
git hunks (not `CollectionDifference`). Renders insert/delete/context rows with
green/red backgrounds, `+`/`−` signs, old/new line gutters, horizontal scroll
(no wrap), and a `+N −M` summary. **Syntax highlighting** (via the
`CodeWebView` highlight.js engine in `FileDetailView.swift`) is layered on as
the final task; the view ships first with plain monospaced colored rows.

## Data flow

1. Panel appears / window gains focus / Refresh pressed → `service.refresh()`
   → status + branch → `state` → left pane renders.
2. Select a file → `service.diff(path,staged)` → `UnifiedDiffParser` →
   right pane renders.
3. Stage/unstage/discard → run git → `refresh()`.
4. Commit → `RepoManager.commit` → `refresh()` (staged list clears).

## Error handling

- No active repo / not a git dir → empty state, actions hidden.
- Git command failure → inline error banner (RepoManager redacts secrets);
  state otherwise preserved.
- Discard → confirmation dialog naming the file; untracked discard says the
  file will be deleted.
- Commit with nothing staged or empty message → button disabled (no error).

## Components affected / created

- Create: `Services/SourceControlService.swift`, `Services/SCMParsers.swift`
  (StatusParser + UnifiedDiffParser + models), `Views/SourceControl/
  SourceControlView.swift`, `Views/SourceControl/UnifiedDiffView.swift`.
- Modify: `Services/RepoManager.swift` (expose a stdout-returning git runner if
  needed), `Services/ShellState.swift` (section case), `Views/Shell/
  SidebarView.swift` (codeSections), `Views/AppShell.swift` (route).
- Tests: `Tests/.../SCMParsersTests.swift` (status + diff parsers).

## Testing & verification

- **Unit (pure):** `StatusParser` and `UnifiedDiffParser` tested against
  representative `git status`/`git diff` fixtures (added/modified/deleted/
  renamed/untracked, multi-hunk, no-newline, binary). These compile and encode
  the contracts (XCTest does not execute in this environment).
- **Runtime (on a real repo):** point the service at an actual git repo, make
  changes, and confirm status/stage/unstage/discard/commit take effect on disk
  — the same disk-observation method used to verify the scaffold fix. The IDE
  shell gates on login, so verification runs the service logic against a temp
  repo, plus a build + launch smoke test of the panel.

## Risks

- **`status --porcelain` parsing** (rename arrows, quoted paths with spaces/
  unicode, XY-code matrix) is the fiddliest part — covered by parser unit
  tests with real fixtures.
- **Diff rendering reuse:** the `UpdateFileSheet` renderer computes its own
  diff; feeding it parsed git hunks changes its input model — keep the row
  view, replace the source.
- **Syntax highlighting** in a diff context (highlight.js per line) is the most
  uncertain piece; sequenced last so the working core lands regardless.
- `git restore` requires Git ≥ 2.23; acceptable on supported macOS.
