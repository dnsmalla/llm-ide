# Desktop core: data location, lifecycle, `claude` discovery

How the Tauri desktop app runs the Node core on a user's machine. Design and test status:
`desktop/PACKAGING.md` ("Production sidecar"). Code: `desktop/src-tauri/src/core_host.rs`.

## Where the data lives

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/llm-ide-desktop` |
| Windows | `%LOCALAPPDATA%\llm-ide-desktop` |
| Linux | `$XDG_DATA_HOME/llm-ide-desktop` (default `~/.local/share/llm-ide-desktop`) |

`LLMIDE_DESKTOP_DATA_DIR=<absolute path>` overrides it (useful for a throwaway profile).
Inside: `core/data.db` (+ `agent.db`, `backups/`), `core.log` (redacted failure log, 0600),
`recent-projects.json`, `tray-settings.json`, `instance.lock`. Secrets are not here: they are in
the OS credential store ([desktop-secret-store.md](desktop-secret-store.md)).

This is **not** the Mac app's `~/Library/Application Support/llm-ide/system`, on purpose: two apps
must not open the same SQLite file or share vault keys (the vault is encrypted with the key in each
app's own credential entry). Until an importer exists the desktop app starts with an empty KB.

### Import path from the Mac app (not built)

A safe import must copy, never move: quit the Mac app, snapshot `data.db` and `agent.db` with
SQLite `VACUUM INTO` into `core/`, and copy nothing from the vault tables (they are encrypted with
the Mac app's key; credentials are re-entered). The server already has a verified snapshot routine
(`extension/kb/data-dir-migration.mjs`) to reuse. Until then do not copy files by hand.

## Lifecycle in one paragraph

Start on launch; supervise (child exit plus `/health` that echoes the launch nonce); restart a
crashed or hung core with backoff 1 s, 2 s, 4 s ... capped at 30 s; five crashes within five
minutes is a fatal state that is shown and not retried; on quit stop the whole process tree
(SIGTERM to the process group, then SIGKILL; a Job Object on Windows) so no Node or `claude`
child is left. An external server already on `:3456` is adopted and never touched.

## `claude` not found

The webview reads `core_status.claude` (`found` / `missing` / `unknown`) and shows
`core_status.claude_notice` when it is `missing`. The host asks the server's own resolver
(`extension/providers/claude-path.mjs`), with a PATH widened to the usual install dirs, because a
GUI app inherits a minimal PATH. Set `LLMIDE_CLAUDE_PATH` in the environment the app is launched with
to point at a specific executable (a broken override does not fall back to PATH). Installing Claude
Code while the app runs is noticed within 30 s.

## Troubleshooting

- `state: "failed"`, `fatal: true`: read `core.log` in the data folder (secrets are redacted),
  fix the cause, restart the app.
- "LLM-IDE is already running": another instance holds `instance.lock` in the same data folder.
- Core never becomes healthy on a Linux box: the Secret Service (gnome-keyring/KWallet) must be
  running; there is no plaintext fallback.
