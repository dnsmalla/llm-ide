# Remote commit — Specification

## Goal

Commit selected working-tree changes from the web workspace. One explicit message, explicit file list, no push yet.

## Host API

```text
git.commit { projectId, message, paths } -> { commit, summary }
```

Rules:

- `message` 1–200 characters, no NUL.
- `paths` 1–100 project-relative paths; absolute paths and `..` refused.
- stage only those paths with `git add -A -- <paths>`.
- commit only those paths with `git commit -m <message> -- <paths>`.
- normal git hooks run; a failing hook fails the commit.
- no push, amend, reset, checkout or force.
- `self.write` project permission; audit project, path count and resulting hash, never the message.
- `GIT_TERMINAL_PROMPT=0`; 30-second timeout.
- a commit that changes nothing returns `nothing_to_commit`.

## Web

In **Changes**:

- checkbox per changed file (default all)
- commit message field
- Commit button, disabled while empty/committing
- after success, refresh status and show the short hash

## Acceptance

1. commit one modified file → `git log -1` shows the message and only that file
2. unselected modified file stays uncommitted
3. empty message refused
4. path outside repo refused
5. no changes → `nothing_to_commit`
6. failing hook → commit refused, working tree retained
