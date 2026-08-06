---
title: Cursor parity (terminal, git header, gutter, diff highlight)
status: draft
date: 2026-06-15
---

# Cursor parity batch — design

## Goal

Make the IDE's git + terminal workflow feel like Cursor: a discoverable
bottom terminal scoped to the active repo, pull/push/sync + branch switching
in Source Control, editor gutter change markers, and syntax-highlighted diffs.

## Features

### A. Terminal: visible toggle + repo-aware cwd

The bottom PTY terminal already exists (`TerminalPanelView` + `TerminalPanelState`,
toggled by `Ctrl+``). Gaps: not discoverable, and its cwd is the project folder,
not the active Source Control repo.

- Add a visible **Terminal toggle button** in `StatusBar` that calls
  `terminalPanelState.toggle(projectDirectory:)`. Reflect open/closed state.
- Change `AppShell.projectDirectory` (the terminal cwd source) to prefer
  `config.activeRepoLocalURL` when set, then the active project folder, then
  home — so `git` in the terminal matches the Source Control panel.

Out: per-selected-file `cd` (the running PTY can't change cwd without a sent
command); MVP scopes new tabs to the repo root.

### B. Git header: pull / push / sync + branch switcher

Extend `SourceControlService` with authenticated remote ops and branch ops.

- **Backend/token resolution:** match `activeRepoLocalURL` against
  `config.gitLabSavedProjects` / `config.gitHubSavedRepos` (by `localPath`)
  to determine `RepoManager.Backend` (.gitlab/.github) and the token
  (`config.gitLabToken` / `config.gitHubToken`). When no match/token →
  remote ops disabled.
- **Service methods:**
  - `pull()` → `RepoManager.pull(at:token:backend:)`.
  - `push()` → `RepoManager.push(at:branch:token:backend:)` with the current
    branch.
  - `fetch()` → new authenticated `RepoManager.fetch(at:token:backend:remote:)`
    (`git fetch <remote>`), then `refresh()` to recompute ahead/behind ("sync"
    = fetch + refresh; no auto-merge).
  - `listBranches()` → `git branch --format=%(refname:short)` (local) → [String].
  - `checkout(branch:)` → `RepoManager.checkoutExisting` or `git checkout <b>`.
- **Header UI** (`SourceControlView` branch header): Pull ↓, Push ↑, Sync
  (fetch) buttons + a branch menu (current branch, list, checkout). Buttons
  show a spinner while running and disable during any op; push/pull disabled
  (with tooltip) when no token is configured for the repo's backend. Errors
  surface in the existing inline banner.

### C. Editor gutter change decorations

Mark changed lines in the file editor.

- `CodeWebView` (in `FileDetailView`) gains an optional `changedLines`
  input: a map of line number → change kind (added/modified). Computed by a
  small helper that runs `git diff -- <file>` (untracked → all lines added)
  through `UnifiedDiffParser` and collects the new-side line numbers per kind.
- The highlight.js HTML gutter rows get a colored left bar via a CSS class
  (`gutter-add` green / `gutter-mod` blue). Deletions are marked with a small
  caret between rows (best-effort; added/modified are the priority).
- Computed when the file view appears and after save; no-op when the file is
  not inside a git repo.

### D. Diff syntax highlighting

Rewrite `UnifiedDiffView` to render through a `WKWebView` using the vendored
highlight.js (same engine as `CodeWebView`), instead of SwiftUI `Text` rows.

- Build an HTML table: per row, a left gutter (old/new line numbers), a
  sign cell (+/−/space), and the highlighted code cell. Row background
  green/red/none by kind. Language picked from the file extension (reuse
  `CodeWebView`'s extension→language map).
- Keeps horizontal scroll (no wrap). Falls back to plain text when no
  language match. Theme (dark/light) follows the app theme like `CodeWebView`.

## Components affected / created

- Modify: `Views/Shell/StatusBar.swift` (terminal toggle), `Views/AppShell.swift`
  (cwd source).
- Modify: `Services/RepoManager.swift` (add authenticated `fetch`; expose a
  branch-list helper if cleaner than raw runGit).
- Modify: `Services/SourceControlService.swift` (backend/token resolution,
  pull/push/fetch/listBranches/checkout, branch state).
- Modify: `Views/SourceControl/SourceControlView.swift` (header buttons +
  branch menu).
- Modify: `Views/SourceControl/UnifiedDiffView.swift` (web-based highlighted
  diff).
- Modify: `Views/Library/FileDetailView.swift` (`CodeWebView` gutter markers)
  + a small `GitGutter` helper (in `Services/` or alongside the view).
- Tests: extend `SCMParsersTests` / add a `GitGutter` line-range test (pure).

## Data flow

- Terminal: toggle → `terminalPanelState.toggle(projectDirectory)`; new tabs
  spawn in `projectDirectory` (now = active repo).
- Git header: button → service method → `RepoManager` (authenticated) →
  `refresh()` → header + lists update. Branch menu → `checkout` → `refresh()`.
- Gutter: file appears → `GitGutter.changedLines(repo:file:)` → `git diff` →
  `UnifiedDiffParser` → line→kind map → injected into `CodeWebView` HTML.
- Diff highlight: selection → `service.diff(root:file:)` → `[DiffHunk]` →
  `UnifiedDiffView` builds highlight.js HTML → `WKWebView`.

## Error handling

- Remote ops: failures (auth, network, non-fast-forward) → inline banner via
  `state.error`; buttons re-enable. No token for backend → disabled + tooltip.
- Branch checkout with a dirty tree may fail → surfaced in the banner; no
  forced checkout.
- Gutter / diff highlight: any git or render failure degrades to no markers /
  plain rows — never blocks the editor.

## Testing & verification

- **Pure:** `GitGutter` line-range extraction tested against diff fixtures;
  branch-list parsing tested. (XCTest doesn't run here — compiled + contract.)
- **Runtime (real repo):** verify the git command sequences (`fetch`, `push`
  dry-run/local bare remote, `branch`, `checkout`, gutter `diff`) against a
  temp repo on disk, as done for the SCM service. Build + launch smoke for
  the UI; full push needs the user's repo + token (noted).

## Risks

- **Auth resolution** (matching localPath → backend/token) is the fiddliest
  part; if no saved-project match, remote ops are cleanly disabled rather than
  guessing.
- **Push is outward-facing** — uses the user's own token against their own
  remote (standard SCM); guarded behind an explicit button.
- **WKWebView diff** rewrite changes the diff view's rendering substrate;
  keep the parsed-hunk input model so the service layer is untouched.
- `git fetch` for ahead/behind needs auth for private repos — the new
  authenticated `fetch` covers it.
