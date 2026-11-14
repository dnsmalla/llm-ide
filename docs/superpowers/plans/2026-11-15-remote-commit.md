# Remote commit Implementation Plan

**Goal:** Add a safe, explicit remote commit to the web Changes view.

**Architecture:** `git.commit` Host API write backed by a shell-free git helper; the Changes pane selects files and sends one message.

**Spec:** `docs/superpowers/specs/2026-11-15-remote-commit.md`

## Global Constraints

- `execFileSync('git', args)` only; no shell.
- Explicit paths; no `git add -A .`.
- No push in this phase.
- `self.write`; audit no message.
- Generated files must pass `--check`.

### Task 1: commit helper

**Files:** Create `extension/routes/host-api/git-commit.mjs`; test `extension/tests/host-api-git-commit.test.mjs`.

- [ ] Failing tests: one file commit, unselected stays, empty message refused, outside path refused, nothing-to-commit.
- [ ] Implement `gitCommit(root,{message,paths})`; `git add -A -- paths`, `git commit -m message -- paths`, `rev-parse --short HEAD`.
- [ ] Run tests, commit.

### Task 2: command and gateway

- [ ] `git.commit` schema, `v2Tag:null`, fixtures, counts 38→39, README, five generated outputs.
- [ ] `COMMAND_CLASS`/`PROJECT_FRAME_CLASS` `self.write`.
- [ ] Gateway case: rate.write, scoped root, audit `git_commit` with path count/hash, map invalid/nothing_to_commit.
- [ ] Contract/scopes/gateway tests, commit.

### Task 3: web commit form

- [ ] `commitFiles(link, projectId, message, paths)` in api.ts.
- [ ] Changes pane: checkboxes, message, Commit button, success hash, refresh.
- [ ] Tests for `commitReady` pure helper; tsc/build; commit.

### Task 4: docs

- [ ] Runbook commit section and limits; commit.

## Later

Push, terminal, desktop client, Loop, iPhone.
