---
title: Explorer file ops (create/rename/delete) + Source Control stage/unstage-all
status: draft
date: 2026-08-06
---

# Explorer file ops + Source Control stage/unstage-all — design

## Goal

Bring the macOS Explorer and Source Control panels up to Cursor parity in two
spots that are currently missing or broken:

1. **Explorer file operations** — the tree is read-only today (only Open +
   Reveal in Finder). Add Cursor-style create / rename / delete.
2. **Source Control "all" actions** — single-file stage/unstage work; **Stage
   All** exists but is reported broken, and **Unstage All** is missing entirely.

## Scope

In:

- Explorer: New File, New Folder, Rename, Delete (to Trash). Toolbar buttons +
  context menu. Name via a small sheet. Tab + tree refresh after each op.
- Source Control: add **Unstage All** (`git reset`); render it symmetric to the
  existing Stage All. **Verify** Stage All actually works at runtime and fix the
  real cause only if one is found.
- swift-testing cases for stage-all / unstage-all against a temp git repo.

Out (later): drag-and-drop move, Duplicate, filesystem-watch (FSEvents)
auto-refresh, inline Finder-style rename, per-hunk staging, push.

## Part 1 — Explorer file operations

### UX (Cursor-like)

- **Toolbar** atop the tree pane (next to the existing tree/chat toggles): New
  File (`doc.badge.plus`), New Folder (`folder.badge.plus`), Refresh. Acts on
  the current selection: a selected folder creates inside it; a selected file
  (or nothing) creates in its parent.
- **Context menu** on a node (folder or file), appended before "Reveal in
  Finder" with a divider: New File, New Folder, Rename, Delete.
- **Delete** → confirm alert ("Move '<name>' to the Trash?") → `FileManager`
  `trashItem` (Finder-undoable, **not** `removeItem`). For a folder, the whole
  subtree is trashed. Any open editor tab under the deleted path is closed.
- **Rename** → name sheet prefilled with the current name (and extension
  selected for files where practical) → `FileManager.moveItem` to a sibling
  with the new name. Open tabs pointing at the old URL are repointed to the new
  one (and `activeTab` follows if it was active).
- **New File / New Folder** → name sheet → create empty file / directory. New
  files open in a new tab immediately (Cursor behavior). Name collisions and
  empty names are rejected with an inline error in the sheet.

### Implementation

A new stateless helper `ExplorerFileOps` (an `enum`, mirroring `FileSystemTree`)
so the view stays declarative and the side-effects are testable without UI:

```swift
@MainActor enum ExplorerFileOps {
    static func createFile(in dir: URL, name: String) throws -> URL
    static func createFolder(in dir: URL, name: String) throws -> URL
    static func rename(_ url: URL, to newName: String) throws -> URL   // returns new URL
    static func trash(_ url: URL) throws                               // trashes recursively
}
```

- All use `FileManager`; `trash` uses `trashItem(at:resultingItemURL:)`.
- Validation (non-empty name, no path separators, no overwrite) lives here and
  throws a surfacable `ExplorerFileError` (`duplicateName`, `invalidName`,
  `fileManagerFailed(underlying)`).
- The **view** owns the post-op side-effects (it already owns `expanded`,
  `childrenCache`, `tabs`, `activeTab`):
  - Refresh: re-run `FileSystemTree.children(of: parentURL)` and overwrite
    `childrenCache[parentKey]`; for rename/delete also refresh the old parent.
  - Tabs: on rename, `tabs = tabs.map { $0 == old ? new : $0 }` and repoint
    `activeTab`; on delete, `tabs.removeAll { $0 == url || $0.path.hasPrefix(url.path + "/") }`.
  - Git decorations: call the existing `GitStatusStore` refresh so a new file
    shows as untracked (`U`) and a deletion drops off — same hook the panel
    already uses on appear / project change / window key-regain.

A small reusable `FileNamePromptSheet` (TextField + Create/Rename/Cancel +
inline error line) backs all three create/rename prompts so the UX is uniform.

### Refresh notes

No FSEvents watch in this round (explicitly out of scope). Refresh is
opportunistic: after every successful op the affected parent node is re-read.
This is consistent with the panel's existing pull-on-event refresh model and
avoids a background watcher's lifecycle complexity.

## Part 2 — Source Control stage-all / unstage-all

### Unstage All (new)

Add to `SourceControlService` (mirrors the existing `stageAll`):

```swift
/// Unstage everything (mixed reset to HEAD — working tree untouched),
/// then refresh. Cursor-style "Unstage All".
func unstageAll(root: URL) async { await run(["reset"], root) }
```

`git reset` (no flags = `--mixed HEAD`) is the canonical repo-wide unstage and
is exactly what VS Code/Cursor run for "Unstage All". It reuses the existing
private chokepoint `run(_:root:)` → `repo.runGit` → `refresh(root:)`, so error
handling and the `isBusy` guard are identical to stage/unstage.

### UI symmetry

Generalize `fileGroup` so the "Staged Changes" header gets the mirror button:

```swift
private func fileGroup(_ title: String, _ files: [FileChange], _ root: URL,
                       showStageAll: Bool = false,
                       showUnstageAll: Bool = false) -> some View
```

- `showUnstageAll` renders a `−` (minus) header button → `scm.unstageAll(root:)`,
  disabled while `scm.isBusy`, help text "Unstage All".
- Wire calls:
  - `fileGroup("Staged Changes", scm.stagedFiles, root, showUnstageAll: true)`
  - `fileGroup("Changes", scm.unstagedFiles, root, showStageAll: true)` (unchanged)

### Stage All — verify, don't assume

`stageAll` (`run(["add", "-A"], root)`) is already implemented and shares the
exact code path of the working single-file `stage`. There is no code-level
defect, so the plan is to **verify** it at runtime, not rewrite it:

- After implementing unstage-all, manually exercise Stage All / Unstage All on a
  real repo and confirm files move between groups and the diff pane updates.
- If Stage All truly misbehaves, the likely real causes (in priority order):
  (a) stale build (old binary without `stageAll`) → rebuild; (b) the row `+`
  and header `+` are identical icons → disambiguate via distinct help text / a
  "Stage All Changes" glyph; (c) `refresh(root:)` not re-rendering → check
  `@Observable` state mutation. Fix the verified root cause; do not change the
  git command.

## Error handling

- File ops: errors throw `ExplorerFileError`; the view surfaces them as an
  inline line in the name sheet (for create/rename) or an alert (for delete
  failures). Never a silent no-op.
- Git: existing `SourceControlService` already funnels non-zero exits through
  `errorMessage`/`errorBanner()`; unstage-all inherits this for free.

## Testing

- `mac/Tests/LlmIdeMacTests/SourceControlStageAllTests.swift` (swift-testing):
  in a temp dir, `git init`, write a file, `stageAll` → assert `git status`
  shows it staged; `unstageAll` → assert it is unstaged. Runs real `git` via
  `RepoManager` (already used elsewhere; local-only, no network).
- `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift`: against a temp dir,
  `createFile`/`createFolder`/`rename`/`trash` → assert filesystem state +
  `duplicateName`/`invalidName` thrown on bad input. (Pure FileManager, no UI.)

## Files touched

- `mac/Sources/LlmIdeMac/Services/ExplorerFileOps.swift` (new) + a small
  `ExplorerFileError`.
- `mac/Sources/LlmIdeMac/Views/Explorer/ExplorerView.swift` — toolbar buttons,
  context-menu items, name sheet, post-op refresh + tab sync.
- `mac/Sources/LlmIdeMac/Views/Explorer/FileNamePromptSheet.swift` (new).
- `mac/Sources/LlmIdeMac/Services/SourceControlService.swift` — `unstageAll`.
- `mac/Sources/LlmIdeMac/Views/SourceControl/SourceControlView.swift` —
  `fileGroup(showUnstageAll:)` + the `−` button + wiring.
- `mac/Tests/LlmIdeMacTests/SourceControlStageAllTests.swift` (new).
- `mac/Tests/LlmIdeMacTests/ExplorerFileOpsTests.swift` (new).

## Future

Drag-drop move + Duplicate (drop handling + conflict resolution); FSEvents
auto-refresh; inline Finder-style rename; per-hunk staging; Push from the panel.
