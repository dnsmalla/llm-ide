# Remote Git read — Specification

## Goal

From the web workspace, see the host project's branch, working-tree changes and diff. No writes in this phase.

## Host API

```text
git.status  { projectId } -> { branch, ahead, behind, clean, entries: [{ path, x, y, status }] }
git.diff    { projectId, path?, staged? } -> { patch, truncated }
```

Rules:

- run with `git -C <project root>`, never through a shell
- `--no-ext-diff`, `--no-color`, `--no-optional-locks`
- status uses `--porcelain=v1 -z` so filenames with spaces survive
- diff is capped at 262,144 bytes; `truncated: true` when cut
- `path` is project-relative and passed after `--`
- both commands are project `self.read`
- no commit, push, checkout, reset or hooks

## Web

A **Changes** view in the Workspace section:

- branch, ahead/behind
- changed files with status letters
- selected file diff
- "No changes" state

## Acceptance

1. clean repo → `clean: true`, no entries
2. modified file appears with `M`
3. diff shows the changed line
4. a path outside the repo is refused
5. a huge diff is truncated, not streamed unbounded
6. a viewer can read; no write command exists
