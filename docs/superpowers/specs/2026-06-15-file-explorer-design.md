---
title: File Explorer + tabbed editor + gitignore cleanup
status: draft
date: 2026-06-15
---

# File Explorer + tabbed editor + gitignore cleanup — design

## Goal

Make file browsing Cursor-like: a real project file tree (all files/folders,
expandable), files open in closable tabs, and the Source Control list stops
showing auto-generated noise.

## Features

### A. Gitignore cleanup (`ProjectScaffolder`)

Today the scaffolder writes ignore rules to `.llmide/.gitignore` (a nested
gitignore that only governs `.llmide/`), and never ignores `.code-notes/`,
so the Code Graph artifacts at the repo root flood `git status`.

- Write a marker-guarded block to the **project-root `.gitignore`**:
  - If root `.gitignore` is absent → create it with the block.
  - If present but the marker (`# >>> LLM IDE managed`) is absent → append the
    block. Never rewrite/clobber the user's existing rules.
  - If the marker is already present → no-op (idempotent).
- Block contents:
  ```
  # >>> LLM IDE managed (auto-generated / ephemeral) — safe to edit above
  .code-notes/
  .understand-anything/
  .llmide/cache/
  .llmide/sync.json
  .llmide/index.sqlite
  .llmide/index.sqlite-shm
  .llmide/index.sqlite-wal
  *.partial.md
  # <<< LLM IDE managed
  ```
- The existing `.llmide/.gitignore` write is removed (superseded).
- Runs in `scaffold(at:project:)`, so existing projects are cleaned on next
  open. Result: the generated files drop out of the SCM "Changes" list.

### B. Explorer section (live project tree)

A new sidebar section `.explorer` ("Explorer", `folder` icon), routed to
`ExplorerView`, rooted at the **active project folder**
(`projectStore.activeProject.localPath`).

- **`FileSystemTree`** — a model that lazily walks the real directory:
  - `Node { url, name, isDirectory, children: [Node]? (nil = unloaded) }`.
  - `loadChildren(of:)` enumerates one directory level (not recursive),
    sorted **directories first, then files, case-insensitive by name**,
    skipping a noise denylist (reuse `LibraryItemStore.noiseDirectoryNames`
    + hidden dotfiles toggle off by default).
  - Pure, synchronous per-level enumeration (testable against a temp dir).
- **`ExplorerView`** — left pane renders the tree (reuse `RepoFileTreeRow`/
  `FSNode` rendering pattern where it fits, or a dedicated lazy
  `OutlineGroup`-style rows), expand/collapse per folder, lazy child load on
  first expand. Selecting a file opens it in a tab (feature C).
- Empty state when no active project.

### C. Tabbed editor with close

Lift the open-files tab bar out of `ReviewView` into a reusable component, used
by `ExplorerView`.

- Extract `EditorTabBar` / `EditorTab` (close button, active highlight,
  neighbor re-selection on close) from `ReviewView` into
  `Views/Shared/EditorTabBar.swift` as a reusable view taking
  `tabs: Binding<[URL]>` + `activeTab: Binding<URL?>`. Update ReviewView to
  use the extracted component (no behavior change there).
- `ExplorerView` right pane = the tab bar + `FileDetailView` for the active
  tab. Tree selection appends/activates a tab; close removes it. Gutter
  change-markers (already built) appear in opened files.
- Scope: Explorer owns its own `[URL]` tab state (local). A single app-wide
  shared tab strip across SCM/Review is out of scope for this batch.

## Components affected / created

- Create: `Services/FileSystemTree.swift` (model + per-level walk).
- Create: `Views/Explorer/ExplorerView.swift`.
- Create: `Views/Shared/EditorTabBar.swift` (extracted from ReviewView).
- Modify: `Services/ProjectScaffolder.swift` (root gitignore block).
- Modify: `Services/ShellState.swift` (`.explorer` section), `Views/Shell/
  SidebarView.swift` (sidebar entry), `Views/AppShell.swift` (route).
- Modify: `Views/ReviewView.swift` (use extracted `EditorTabBar`).
- Tests: `Tests/.../FileSystemTreeTests.swift`, `ProjectScaffolderTests`
  (gitignore block).

## Data flow

1. Open Explorer → `FileSystemTree(root: activeProject.localPath)` loads the
   top level.
2. Expand a folder → `loadChildren(of:)` enumerates that level (cached).
3. Select a file → append to Explorer's `tabs`, set `activeTab` → tab bar +
   `FileDetailView` render it (with git gutter markers).
4. Close a tab → remove from `tabs`, re-select a neighbor.
5. Scaffold (on project open) → root `.gitignore` block ensured → generated
   files no longer appear in `git status` / the SCM panel.

## Error handling

- Unreadable directory → that node shows no children (no crash).
- Non-existent root / no active project → Explorer empty state.
- `.gitignore` write failure → logged, non-fatal (matches existing scaffold
  best-effort writes).
- A tab whose file was deleted on disk → `FileDetailView` shows its own
  not-found state; closing still works.

## Testing & verification

- **Pure/unit:** `FileSystemTree.loadChildren` against a temp dir (dirs-first
  order, noise skipped, hidden skipped); `ProjectScaffolder` gitignore block
  (created when absent; appended once when marker missing; no-op when present;
  user rules preserved). Compile + contract (XCTest doesn't run here).
- **Runtime (real dir):** point the tree at a real folder on disk and confirm
  the walk yields the right nodes; verify the gitignore block lands at the
  project root and `git status` drops `.code-notes/` (observe on disk, as with
  the scaffold fix). Build + launch smoke for the UI; GUI clicks login-gated.

## Risks

- **Extraction of EditorTabBar** must not regress ReviewView — keep the same
  bindings/behavior; verify ReviewView still builds and opens/closes tabs.
- **Large directories** — per-level lazy loading avoids walking the whole tree
  up front; very large single folders still render many rows (acceptable;
  virtualization is a later concern).
- **Gitignore append** must be marker-guarded and idempotent so repeated opens
  don't duplicate the block or touch user rules.
