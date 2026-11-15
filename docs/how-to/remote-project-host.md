# Run a remote project host

Phase 1 of remote projects lets a browser open, edit and save a text file in a project that lives on a server. The
project, git, the agent and the model keys stay on that server; the browser receives only the file it opens.

## 1. Prepare the server

```bash
# a project on the server
git clone <repo> /srv/projects/app
cd /srv/projects/app
mkdir -p system
printf '{"name":"app"}\n' > system/project.json

# a data directory owned by the service user
sudo install -d -o llmide -g llmide /var/lib/llmide
```

The core must run with its own data directory, never the repo's `kb/`:

```bash
LLMIDE_DATA_DIR=/var/lib/llmide node /opt/llmide/extension/server.mjs
```

Bind it to loopback and reach it through a tunnel or a TLS reverse proxy. Do not expose port 3456 directly.

## 2. Register the project on the host

The project id must exist in both the canonical registry and the user's project map. Use the authenticated
`POST /kb/projects/register` route (the desktop Settings path calls the same route):

```bash
curl -X POST http://127.0.0.1:3456/kb/projects/register \
  -H "authorization: Bearer $LLMIDE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"root":"/srv/projects/app","name":"app"}'
```

A successful response has `{ "id": "...", "root": "/srv/projects/app", "name": "app" }`.

## 3. Pair a client

1. In the host Settings, enable the Host API and show the pairing PIN.
2. Open the web app, enter the host address and PIN.
3. Pick the project in the project picker.

The browser now has `read`; `files.list` and `files.read` work as before, and the new `files.stat` / `files.write` are
available.

## 4. Use the Workspace tab

1. Open **Workspace**.
2. Choose a file.
3. Edit and press **Save**.

A save sends `expectedHash` from the last stat. If another writer changed the file, the host answers
`conflict` and the client says to reload.

## 5. Review changes

Open **Workspace → Changes**. The host returns:

```text
git.status  branch, ahead/behind, changed files
git.diff    the selected file's unified diff, capped at 256 KiB
```

Click **Open** on a changed file to edit it, then Save.

### Commit

In **Changes**, tick the files to include, write a message and press **Commit**. The host stages exactly those paths,
runs the normal git hooks and commits exactly those paths. A failing hook fails the commit and leaves the working tree
intact.

When the branch is ahead, **Push ↑N** pushes the current branch to its already-configured upstream. There is no force,
no remote/ref argument and no terminal prompt.

## 6. Terminal (allowlisted)

**Workspace → Terminal** runs one command at a time from a fixed allowlist:

```text
git status / diff / log / show / branch / rev-parse / ls-files
ls, pwd, rg
pytest, python3 -m pytest
npm test
cargo test, go test, swift test
```

It is not a shell: argv is executed without a shell, shell metacharacters are refused, paths cannot contain `..` or
start with `/`, and `.git` / `.ssh` / secret paths are refused. The host returns stdout, stderr, exit code, truncation and
timeout.

**Full shell** is a separate, explicitly dangerous mode:

1. start the host core with `LLMIDE_ALLOW_REMOTE_SHELL=1`
2. tick **Full shell** in Terminal
3. confirm the command in the browser dialog

Without the environment flag the host refuses every shell command. The shell runs as `/bin/sh -lc` in the project
root, with a 30-second timeout and 256 KiB output cap. Audit records a command hash, never the full text. This is
remote code execution: enable it only for a single-owner host you control.

### Limits of the path denylist

- **Tracked secrets.** The `.env` / `.ssh` / secret denylist covers path operands only. If a secret was ever committed,
  `git log -p`, `git show <rev>` and `git diff` without a path print it. Keep secrets out of history, and do not grant
  a device access to a repository whose history contains them.
- **`workspace_write` is code execution.** `files.write` can change `package.json` `"test"` (or any test config), and
  `terminal.exec` then runs `npm test`. Once a device holds `workspace_write`, `shell` is not a separate boundary:
  grant `workspace_write` only to a device you would trust with a shell on the host.

## 7. Acceptance checklist

Run each on the server and record the result:

- [ ] open a text file, change one line, Save → `git diff` shows exactly that line
- [ ] open the same file in a second browser, Save from both → second gets `conflict`
- [ ] save a path `../outside` → `invalid_payload`
- [ ] save `.git/config` → `denied`
- [ ] project viewer role → write refused
- [ ] file over 262,144 bytes → `invalid_payload`
- [ ] binary file → not opened as text
- [ ] audit row `file_write` has project, path and size, and no file text
- [ ] no repository clone or sync is created on the client
- [ ] clean repo → Changes says "No changes"
- [ ] edit a file → it appears with M and the diff shows the line
- [ ] a diff over 262,144 bytes is truncated
- [ ] a viewer can read Changes; Commit is refused for a viewer
- [ ] commit one file → `git log -1` shows only that file
- [ ] leave another modified file unticked → it stays uncommitted
- [ ] empty message / empty selection → Commit disabled
- [ ] a failing hook → commit refused, changes kept
- [ ] a committed branch shows Push ↑1 and pushes to its upstream
- [ ] no upstream → push fails with a clear message
- [ ] `git status` in Terminal exits 0
- [ ] `sh -c id` is refused
- [ ] `ls ../` is refused
- [ ] full shell without the env flag → denied
- [ ] full shell with the flag + confirmation → runs

## Limits

- Text files only; no binary, rename, delete or mkdir UI.
- Git commit and push are available; both use the host repository's configured identity and upstream.
- Terminal is allowlisted by default; full shell requires `LLMIDE_ALLOW_REMOTE_SHELL=1` and per-command confirmation.
- No Loop on the host yet.
- Desktop and iPhone are later phases; the web client is the first remote client.
- The model provider still receives the code sent to it; for licensed code use a self-hosted model or a no-training
  enterprise agreement.

## Desktop access

The desktop app's **Window → Remote Workspace in Browser…** opens `https://llm-ide.com/app/` in the system browser. The
desktop does not embed the remote app: its `frame-ancestors 'none'` policy blocks embedding, and a native Host API client
inside the desktop is still a separate phase. Use the browser window as the desktop remote client until then.

## Native desktop client

The **Welcome** page has a **Remote host** card:

1. add the SSH host, port, user and private-key path, then **Test SSH**
2. enter `wss://llm-ide.com/host-api/v1`. The workspace socket is opened by the webview, so the app's CSP (`connect-src` in `desktop/src-tauri/tauri.conf.json`) only allows `wss://llm-ide.com`; any other origin is refused with an error in the card. Reaching other hosts would need the socket routed through the Rust host (follow-up)
3. enter the host's pairing PIN and **Connect workspace**
4. choose a remote project

The section reuses the web workspace UI — files, save, Changes, commit/push, allowlisted terminal and gated full shell —
over a desktop-side Host API WebSocket. The local project and the remote project are separate: the Remote section never
touches the local core.

## Open SSH project (VPS reference host)

The reference deployment runs a core on the VPS:

```text
Node 22                     /opt/llmide-node
core                        /opt/llmide-remote/extension (systemd: llmide-remote)
data                        /var/lib/llmide-remote
projects                    /srv/llmide/projects
core port                   3457
Host API TLS                3017
public path                 wss://llm-ide.com/remote/host-api/v1
bootstrap CLI               /usr/local/bin/llmide-remote-project
```

The SSH host entry stores a **remote project path** such as `/srv/llmide/projects/demo`. **Open SSH** runs:

```text
/usr/local/bin/llmide-remote-project open <path>
```

which logs in as the operator, registers the folder, mints a one-use pairing PIN and returns:

```json
{ "root": "...", "projectId": "...", "url": "wss://...", "pin": "......", "fingerprint": "sha256:..." }
```

The desktop then pairs and opens the workspace. The SSH key is only the bootstrap channel; the workspace uses the pinned
Host API.

## Host Loop

`/usr/local/bin/llmide-remote-loop <project-root> [loop-name]` runs a project's `system/loop.json` on the host:

- `shellCommand` stages run with the project root as cwd
- `skill` stages call the core's `/kb/loop/agent-run` with the Claude Agent SDK
- `codeGraph` runs the bundled GraphKit CLI (`/opt/llmide-remote/graph-kit.js`) into `system/loop-runs/host/graph`
- `testMap` `structure`, `map` and `ledger` reuse the desktop's pure TypeScript logic through `host-testmap.mjs`
- `map` uses the host graph when present
- `artifactCheck` runs the desktop's deterministic checks through `host-artifact.mjs`
- `testPrune` writes its report through `host-testmap.mjs prune`
- `regressionSweep` re-verifies fixed faults through `host-regression.mjs`
- a git project runs in `.llmide-loop-worktrees/run-<timestamp>` (a detached worktree from HEAD), not in the live folder
- the run record is written to `llm-doc/loop/host/<timestamp>/run.json` **inside that worktree**
- the worktree is left for review; add `.llmide-loop-worktrees/` to the project's `.gitignore`

The desktop Remote workspace exposes **Run loop**: it asks for a loop name (blank = primary), runs this CLI over SSH,
and prints the result. A skipped blocking stage fails the run (`partial: true`), so a host run cannot claim success for
desktop-only map/graph stages it did not execute. The VPS needs Claude credentials (or an Anthropic key) for skill stages; shell stages need only the
host core.

## iPhone review

With the `read` capability, the iPhone shows a **Changes** tab for the selected project:

- branch, ahead/behind, clean/dirty
- changed-file list from `git.status`
- one unified diff from `git.diff`

The same screen can commit the listed files (with a message) and push the current branch. Both actions ask for confirmation;
the commit path only includes the files shown by `git.status`.

### Worktree lifecycle

The Remote workspace **Worktrees** panel lists host Loop worktrees and offers:

```text
Diff     show the worktree's staged-vs-HEAD stat and patch before merging
Merge    commit the worktree, create llmide/loop-<run>, merge with --no-ff into the live branch
Remove   delete a clean worktree (refused when it has uncommitted changes)
Prune    delete clean worktrees older than seven days; dirty ones are always kept
```

CLI equivalent:

```bash
llmide-remote-worktree list   <project>
llmide-remote-worktree diff   <project> <run-name>
llmide-remote-worktree merge  <project> <run-name>
llmide-remote-worktree remove <project> <run-name>
llmide-remote-worktree prune  <project>
```

A merge is refused if its branch already exists; a conflict is reported and left for manual resolution.
