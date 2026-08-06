---
title: Comprehensive git features (branches, history, stash, merge, blame, tags)
status: draft
date: 2026-06-15
---

# Comprehensive git features — design

## Goal

Bring Source Control to VS Code/Cursor parity: branch management with live
refresh, commit history with per-commit diffs, stash/amend/commit&push/
discard-all, and merge/blame/tags.

## Scope

**In:** branch create/switch/delete/publish + auto-refresh; commit history
(log) + commit diff; stash push/pop/list; amend; commit & push; discard-all;
merge a branch into current; blame gutter; tags (list/create).

**Deferred (own follow-on — too large to do well here):** interactive rebase,
cherry-pick, a 3-way conflict-resolution editor, remote add/remove management.
Merge conflicts are surfaced (status shows conflicted files; the user resolves
in the editor/terminal) but no dedicated merge editor.

All ops target the active repo (`config.activeRepoLocalURL` → project), via
`RepoManager.runGit` (local) or the authenticated `pull/push/fetch` (remote),
resolving credentials as the existing pull/push path does.

## Features

### 1. Branch management + auto-refresh

`SourceControlService`:
- `createBranch(root:name:)` → `git checkout -b <name>` → refresh.
- `deleteBranch(root:name:)` → `git branch -d <name>` (force `-D` only on
  explicit confirm) → refresh.
- `publish(root:)` → push current branch with `--set-upstream` (uses creds);
  shown when the branch has no upstream.
- `listBranches` already exists (local). Add `currentBranch` already via
  `state.branch`.

Auto-refresh fix (the reported bug — terminal `git checkout -b` not reflected):
- Refresh **every time** the Source Control view appears (not only on root
  change) — `.onAppear`/`.task` without the `id` gate, or an explicit
  `onAppear` refresh.
- A lightweight **poll** while the SCM view is visible (e.g. every ~3 s) that
  re-runs `refresh` so external/terminal changes (branch, new files, commits)
  surface without manual action. Cancelled when the view disappears.
- Branch menu: **Create Branch…** (prompt), **Publish Branch** (when no
  upstream), **Delete Branch** (per branch, confirm), plus switch existing.
  The current-branch label and menu list refresh from `state.branch`.

### 2. Commit history (log)

`SourceControlService`:
- `log(root:limit:)` → `git log --pretty=%H%x1f%h%x1f%an%x1f%ar%x1f%s -n <limit>`
  parsed into `Commit { sha, shortSha, author, relativeDate, subject }`.
- `commitDiff(root:sha:)` → `git show --format= <sha>` → `UnifiedDiffParser`.

UI: a **History** affordance in the SCM panel (a toggle/segment between
"Changes" and "History", or a section in the panel) listing recent commits;
clicking a commit shows its diff in the right pane (reuse `UnifiedDiffView`).

### 3. Stash / amend / commit & push / discard-all

`SourceControlService`:
- `stashPush(root:message:)` → `git stash push -u [-m msg]`; `stashList(root:)`
  → `git stash list` parsed to `Stash { index, message }`; `stashPop(root:
  index:)` → `git stash pop stash@{index}`.
- `amend(root:message:)` → `git commit --amend -m <msg>` (or `--no-edit` when
  message empty) → refresh.
- `commitAndPush(root:message:)` → commit (commit-all-aware) then push → refresh.
- `discardAll(root:)` → confirm, then `git checkout -- .` + `git clean -fd`
  (destructive; explicit confirmation dialog naming the consequence).

UI: a stash menu (push/pop/list), an "Amend" toggle next to Commit, a
"Commit & Push" action, and a "Discard All Changes" action (in a … menu) with a
destructive confirmation.

### 4. Merge / blame / tags

`SourceControlService`:
- `merge(root:branch:)` → `git merge <branch>` → refresh; errors (conflicts)
  surface in the banner and the status list shows conflicted files.
- `blame(root:path:)` → `git blame --line-porcelain <path>` parsed to
  `[BlameLine { line, shortSha, author, date }]`.
- `tags(root:)` → `git tag --sort=-creatordate`; `createTag(root:name:)` →
  `git tag <name>` → refresh.

UI: Merge (branch menu → "Merge into current"); blame as an optional gutter in
`FileDetailView` (author/sha per line, toggle); tags in a … menu (list/create).

## Components affected / created

- Modify: `Services/SourceControlService.swift` (all new ops + models Commit,
  Stash, BlameLine), `Views/SourceControl/SourceControlView.swift` (branch menu
  items, History toggle, stash/amend/discard menus, merge), `Services/
  RepoManager.swift` (a `push --set-upstream` helper if not covered).
- Create: `Views/SourceControl/CommitHistoryView.swift` (or inline section),
  `Services/GitLog.swift` (log/blame parsers, pure) — or fold parsers into
  SourceControlService.
- Modify: `Views/Library/FileDetailView.swift` (optional blame gutter).
- Tests: `Tests/.../GitLogTests.swift` (log + blame parsers, pure).

## Data flow

- Branch/stash/merge/tag op → service runs git → refresh → UI updates.
- Auto-refresh poll (visible-only) → refresh → branch/status/ahead-behind
  update without user action.
- History: select commit → `commitDiff` → `UnifiedDiffParser` → diff pane.

## Error handling

- All ops capture git errors into `state.error` (inline banner); destructive
  ops (delete branch force, discard-all) require explicit confirmation.
- Merge conflicts: non-zero exit → banner; status shows conflicted (`U`) files;
  user resolves in editor/terminal (no merge editor in this batch).
- Poll never overlaps a manual op (guard on `isBusy`); cancelled on disappear.

## Testing & verification

- **Pure/unit:** log parser (`%x1f`-delimited fields → Commit) and blame
  parser against fixtures; stash-list parser. (Compile + contract.)
- **Runtime (real repo):** exercise the exact git command sequences
  (`checkout -b`, `branch -d`, `push -u`, `log`, `show`, `stash push/pop`,
  `commit --amend`, `merge`, `blame`, `tag`) against a temp repo with a bare
  remote; confirm outputs/parsing. Build + launch smoke. GUI clicks login-gated.

## Risks

- **Auto-refresh poll** must be cheap (status is fast), visible-only, and not
  fight in-flight ops (`isBusy` guard) — else flicker/races.
- **discard-all is destructive** (`clean -fd` removes untracked) — gated behind
  an explicit, clearly-worded confirmation.
- **Blame** output is large; cap/lazy-load; only compute when the gutter is
  toggled on.
- Deferred advanced ops (rebase/cherry-pick/conflict editor/remotes) are out of
  scope; surfacing conflicts (not resolving them) is the boundary.
