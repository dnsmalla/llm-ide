# Remote Project MVP — Specification

## Problem

Some repositories cannot be copied to a developer laptop: license terms, IP rules or data residency keep them on a
server. LLM-IDE currently treats the desktop as the only host. Web and iPhone can read and chat against that desktop,
but no client can open, edit or run a project that lives on another machine.

## Model

The remote machine runs an **LLM-IDE Host**. The host owns the project folder, git, the agent and the Loop runner.
Clients are thin: they open files, edit buffers, review diffs and send intents.

```text
VPS / licensed server
  core (server.mjs) + Host API over pinned WSS
  project registry: project id -> absolute folder
  files, git, agent, later Loop

clients
  web       file tree, editor, save, diff
  desktop   same workspace in the app window (later)
  iPhone    read, diff review, approve (later)
```

This is the same execution model as VS Code Remote-SSH. SSH is not the product protocol; the existing Host API is.

## Phase 1 scope

In scope:

- register a project on the host (existing project routes)
- list a project's files
- read one text file
- write one existing or new text file, with optimistic concurrency
- create missing parent directories
- refuse writes outside the project root, through symlinks, to denied paths, or above the size limit
- audit every write
- a web workspace screen that opens a file, edits it and saves it
- conflict detection when the file changed since it was opened

Out of scope for Phase 1:

- git commit/push UI
- terminal exec
- Loop on the host
- desktop app as a remote client
- iPhone editing
- multi-user presence
- file rename/delete
- binary files

## Host API additions (v1)

```text
files.stat
  { projectId, path }
  -> { hash, size, mtimeMs } | not_found

files.write
  { projectId, path, text, expectedHash?, create? }
  -> { hash, size }
```

Rules:

- `text` is UTF-8, at most 262,144 bytes.
- `path` is project-root-relative, POSIX separators, no `..`, no absolute path.
- `expectedHash` is a lowercase SHA-256 hex string. When supplied:
  - current hash must match, else `conflict`
  - `expectedHash: null` means "the file must not exist yet"
- `create: true` allows creating missing parent directories; without it a missing parent is `not_found`.
- a NUL byte in `text` is `invalid_payload`.
- every write is atomic: write a sibling temp file, fsync, rename.
- the response hash is SHA-256 of the exact bytes written.

## Permissions

`files.write` is project-scoped and requires `self.write` on that project. A viewer is refused. The host API's
existing per-frame project authority is reused; no new role model is introduced.

## Security

- resolve the parent directory with `realpath`; it must be inside the project root
- reject denied paths and any path whose real parent escapes the root
- refuse `.git`, `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker` components via the existing denied-path helper
- do not follow a final symlink: replace the link path itself? Phase 1 refuses writing through a symlink
- cap request body at 1 MiB (existing frame limit) and text at 262,144 bytes
- audit `file_write` with project, path, size, outcome; never the text
- rate-limit writes per device

## Acceptance

1. `files.write` creates a new file in a registered project and returns its hash.
2. Re-saving with the returned hash succeeds.
3. Re-saving with an old hash returns `conflict`.
4. A write with `path: "../outside"` is refused.
5. A write through a symlink that points outside the project is refused.
6. A viewer cannot write.
7. `web` opens a file, edits it, saves it, and shows a conflict if the host file changed.
8. The source never leaves the host except the one requested file; no bulk clone or sync is added.
