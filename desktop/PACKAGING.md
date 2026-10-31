# Packaging the Node core (Phase 0 measurements, T6 production sidecar)

Measured 2026-10-26 on macOS arm64, Node 22.23.1, release build
(`npm run tauri build -- --bundles app,dmg`).

## Result

The core ships as Tauri resources: an official, stripped, ad-hoc-signed `node`
binary plus a pruned copy of `extension/` (`scripts/stage-core.mjs` →
`resources/core`, mapped to `Contents/Resources/core`). `core_host.rs`
(`resolve_runtime`) uses it when running from a `.app` or with
`LLMIDE_POC_BUNDLED=1`, otherwise the repo checkout.

Verified with the release `.app` launched through Launch Services and
`LLMIDE_POC_FORCE_SPAWN=1`: the bundled server answered `/health` on :3457 in
**604 ms** (`core_ms_to_healthy`, `adopted:false`) and was gone after the app
quit.

## Sizes

| Build | `.app` | `.dmg` (UDZO) |
|---|---|---|
| Self-contained (bundled node + server + the Agent SDK's `claude` binary) | 386 MB | **160 MB** |
| Same, without the SDK's bundled `claude` binary | 147 MB | **67 MB** |
| Swift app today (`mac/LlmIdeMac.app`, no node/server inside) | 37 MB | — |

Breakdown of the self-contained `.app`: `@anthropic-ai/claude-agent-sdk-darwin-arm64`
(the bundled `claude` CLI) 239 MB, `node` 86 MB, rest of `node_modules`
~45 MB (better-sqlite3 27 MB with all-platform prebuilds, @anthropic-ai/sdk
10 MB, @modelcontextprotocol/sdk 8 MB, …), server code 2.7 MB, Rust binary
12 MB, frontend assets included in the binary.

Plan §6 target is ≤ 150 MB per installer: the self-contained build misses it
(160 MB); the build that uses the user's installed `claude` meets it (67 MB).

## Node single-executable (SEA) — works, small win

`scripts/sea-spike.mjs`: esbuild bundles `server.mjs` to one CommonJS file,
`postject` injects it into the official node binary, ad-hoc signed. The server
answered `/health` and prewarmed the engine. Blockers worked around:

- SEA accepts CommonJS only; ESM entry rejected.
- Top-level `await` (server.mjs:1118 and three handler self-test guards) must
  be rewritten in the build copy.
- `zod` must stay external (bundled copy fails: "Class2 is not a constructor").
- `better-sqlite3` (native addon), the Agent SDK and `zod` load from disk via
  `createRequire` on the runtime root.
- Homebrew `node` cannot be used (links `libnode.dylib`); use the official
  tarball.

The bundle is 6.4 MB, but node (86 MB) and the SDK's `claude` binary still
ship, so SEA saves little. Not recommended for Phase 1.

## Recommendation for Phase 1

1. Ship node + pruned server as resources (this PoC's approach).
2. Do not bundle the SDK's platform `claude` binary; point the Agent SDK at
   the user's installed CLI (`pathToClaudeCodeExecutable`), which users have
   anyway for `claude login`. Fall back to downloading it on first run if
   missing. Installer ≈ 67 MB.
3. Prune `better-sqlite3` prebuilds to the target platform at staging time.

## Risks

- Developer ID signing + notarization of every nested executable (node,
  `better_sqlite3.node`, and the `claude` binary if bundled); hardened runtime
  entitlements for node (JIT).
- Per-arch builds (arm64 / x64) and a universal build double the size.
- Windows/Linux: same layout with `node.exe` / ELF node (staging and the Job Object / process-group code exist, see below); no measurements and no real packaged run yet.
- The `.skills` submodule is not staged; skill files the server reads at
  runtime must be added to `stage-core.mjs`.
- Updating the core means shipping a new app (no separate core updater yet).
- The `node_modules` prune in `stage-core.mjs` deletes docs/tests/`.md`/`.ts`
  files by name; only `/health` was smoke-tested here. T7 runs a real chat
  stream against the bundled core; Phase 1 should prune by allowlist.

## Enforcement of "do not bundle the SDK `claude` binary"

`scripts/stage-core.mjs` removes `@anthropic-ai/claude-agent-sdk-<platform>` after
`npm ci` and fails if any such package or a `claude` executable remains;
`scripts/check-core-deps.mjs` re-verifies the staged tree. Spike builds that still
need the bundled binary opt out with `LLMIDE_STAGE_ALLOW_SDK_BINARY=1` (never for a
release). The server finds the user's `claude` itself: `extension/providers/claude-path.mjs`
resolves it (`LLMIDE_CLAUDE_PATH`, the SDK's bundled binary if present, then PATH and
well-known per-OS install dirs, each validated with a `--version` probe) and the SDK engine
passes it as `pathToClaudeCodeExecutable`. When nothing is found the turn fails with an
`ENGINE_ERROR` telling the user to install Claude Code and run `claude login`. Still open:
a real packaged-app run on Windows and Linux (see "Production sidecar" below).

## Production sidecar (T6)

What the host guarantees about the Node core. Code: `src-tauri/src/core_host.rs`
(lifecycle), `proc_tree.rs` (tree stop), `core_env.rs` (environment), `fsutil.rs`
(data dir); staging: `scripts/stage-core.mjs`, `node-runtime.mjs`, `node-pin.json`.

**Lifecycle.** The core starts on launch (a healthy `:3456` is adopted, never supervised or
killed). A supervisor thread watches the spawned core: child exit, and `/health` every 5 s
that must echo the launch nonce (3 consecutive failures = hung: the tree is killed). A crash or
hang restarts the core with exponential backoff (1 s doubling, cap 30 s, fresh nonce, first
free port of 3457..3459). `RestartPolicy`: 5 crashes inside 5 minutes is a **fatal** state
(`state: "failed"`, `fatal: true`); there is no restart loop and old crashes age out. A first
start that fails is reported as is, with no retry. Quit (`ExitRequested`/`Exit`, Ctrl-C, panic
hook, `Drop`) calls `shutdown()`: it cancels a pending restart, and a spawn racing the quit is
killed as soon as it lands (`closing` flag). Double launch is refused by the data-dir lock
(`flock` on unix, an exclusive open on Windows).

**Whole-tree stop.** The core is spawned as the leader of its own process group (unix) and
stopping sends SIGTERM to the group, waits 3 s for the leader, then SIGKILLs the group (also when
the leader exited but a member survives, e.g. after a crash). On Windows the child is put in a
Job Object with `KILL_ON_JOB_CLOSE`, so terminating it, or the host dying, kills Node and every
`claude`/git/MCP child. Limits: a grandchild that calls `setsid` leaves the group; a Windows
grandchild spawned in the milliseconds before the job assignment (std cannot spawn suspended) is
not in the job. Both are out of reach of node's own startup in practice. Tested with a fake
server that spawns grandchildren (`cargo test --lib`: quit, crash, hang, stubborn SIGTERM
ignorer, leader-already-gone).

**`core_status` (additive, no existing field changed).** New `state` value `restarting`; new
fields `restarts` (count), `restart_in_ms` (while restarting), `fatal` (bool), `claude`
(`unknown` | `found` | `missing`), `claude_source` (`env` | `bundled` | `installed`, never a
path) and `claude_notice` (the server's own install message when `missing`). A consumer that
switches on `state` must handle `restarting`.

**Data dir.** `llm-ide-desktop` under `~/Library/Application Support` (macOS),
`%LOCALAPPDATA%` (Windows) or `$XDG_DATA_HOME`/`~/.local/share` (Linux); override with an
absolute `LLMIDE_DESKTOP_DATA_DIR`. It deliberately does not follow the bundle identifier
(`app_data_dir()` would move when the PoC identifier changes) and does not collide with the Mac
app's `llm-ide/system`. The core runs with `LLMIDE_DATA_DIR` and `LLMIDE_DB_PATH` both set to
`<data>/core` / `<data>/core/data.db`; the explicit DB path makes the server's repo-kb to
data-dir boot migration a no-op, so a run from a checkout can never MOVE the live `kb/data.db`.
See [docs/how-to/desktop-core-lifecycle.md](../docs/how-to/desktop-core-lifecycle.md) for the
import path from the Mac app.

**Environment.** The child gets `env_clear()` plus an allowlist (`core_env.rs`: HOME/USER,
locale, temp dirs, Windows profile vars, proxy and CA variables, `LLMIDE_CLAUDE_PATH`,
`LLMIDE_FEATURES`), the two secrets, and the `LLMIDE_*` the host sets. `ANTHROPIC_*`, provider keys,
`NODE_OPTIONS`, tokens never reach it. `PATH` is the host's own, plus the `claude` install dirs
that `extension/providers/claude-path.mjs` searches (`~/.claude/local`, `~/.local/bin`,
Homebrew, `~/.npm-global/bin`, nvm; Windows `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs[\claude]`),
the OS system dirs, and the bundled node's dir last (so an npm-installed `claude` with an
`env node` shebang finds a node; the user's own wins). Keep `core_env::well_known_dirs` and
`claude-path.mjs` in step.

**Finding `claude`.** A GUI app has a minimal PATH, so after the core is ready the host runs the
server's own `claude-path.mjs` (`resolveClaudeExecutable`) under the core's node and environment
and reports the result in `core_status.claude*`; while missing it re-checks every 30 s, so
installing Claude Code is noticed without a restart. A probe that cannot run reports `unknown`,
never `missing`. `LLMIDE_CLAUDE_PATH` in the host's environment is passed through; there is no
host settings file for it yet.

**Packaged Node.** `stage-core.mjs` takes `--target darwin-arm64|darwin-x64|win32-x64|linux-x64`
(default: this machine; the release workflow stages each target on a native runner). It
downloads the version in `scripts/node-pin.json` (Node 22 LTS) from nodejs.org and requires the
archive's SHA-256 to equal both the repo pin and the line in nodejs.org's `SHASUMS256.txt`
(fail closed; the SHASUMS signature is not checked). Only the `node` executable and its LICENSE
are copied: npm, npx, corepack, headers and docs never ship. Homebrew/distro node is never used;
`LLMIDE_NODE_BIN` remains an offline dev override for the host target only and is refused when
`LLMIDE_STAGE_RELEASE=1`. better-sqlite3 13 ships N-API prebuilds for every target inside the
package (`prebuilds/<platform>-<arch>.node`), so nothing is built or `prebuild-install`ed and no
ABI match with the pinned node is needed; staging keeps only the target's file and fails if it is
missing. `scripts/check-core-deps.mjs` loads the staged `.node` under the STAGED node (in-memory
open) along with the other runtime modules; `scripts/smoke-core.mjs` starts the staged core as the
host does (cleared env, nonce, secrets, data dir), checks `/health`, the nonce echo, the DB
location, the claude probe, then stops the group and asserts nothing survives.
`desktop-release.yml` (manual, unsigned, no secrets) runs stage + check + smoke on macOS arm64,
macOS x64, Windows x64 and Linux x64 before building.

**Verified here (macOS arm64, 2026-10-31):** pinned node download and hash check, stage, 6/6
dependency check, `smoke-core` (health 518 ms, nonce, DB, probe, clean stop), the real launcher
end to end (`cargo test --lib real_staged_core -- --ignored`, 698 ms to healthy, claude found),
79 cargo tests. **Not run:** any Windows or Linux execution (the Job Object code, `node.exe`
staging, `taskkill` smoke path, the Windows exclusive-open lock and the workflow matrix were only
type-checked or read), a signed or Finder-launched macOS run of the new supervisor, macOS x64.

## Secrets

The JWT secret and vault key live in the OS credential store and reach the sidecar through its environment only; see [docs/how-to/desktop-secret-store.md](../docs/how-to/desktop-secret-store.md).

## Project open, tray and notifications

**Project open** (`src-tauri/src/project.rs`). The host opens the native folder dialog
with `rfd` 0.17.2 (pinned). `rfd` rather than `tauri-plugin-dialog` because the host
runs the dialog itself: the webview gets no `dialog:*` or fs permission and never
supplies a path (`project_open`, `project_open_recent <index>`, `project_active`,
`project_recent`). The pick is canonicalised (symlinks resolved), required to be a
folder, and refused if too broad: a Rust mirror of `isTooBroadRoot` +
`isTooBroadTrustRoot` in `extension/core/broad-root.mjs` (`/`, home, system trees,
volumes, other users' homes, temp dirs, Documents/Desktop/Downloads themselves,
Windows drive/Users/Windows/Program Files, UNC share roots). Keep the two lists in
step. The accepted root is the one `read_graph_file` uses (`graph_file::project_root`
prefers it over the `LLMIDE_POC_*` env fallbacks). The Node sidecar is spawned without a
workspace env today, so it does not yet follow the active root; `project::active_root()`
is the hook for that. Recent projects: at most 10 paths in
`<app data dir>/recent-projects.json` (no secrets), re-validated on every load.

**macOS.** `Info.plist` keeps the `NSDesktop/Documents/DownloadsFolderUsageDescription`
strings, so a Finder-launched app gets a TCC prompt for those folders. The app is not
sandboxed. A Mac App Store / sandboxed build would additionally need the
`com.apple.security.files.user-selected.read-write` entitlement and
`com.apple.security.files.bookmarks.app-scope`: the folder chosen in the dialog is only
reachable for the current launch, so the host must store a security-scoped bookmark
(`NSURL bookmarkData` with `.withSecurityScope`) next to each recent entry and call
`startAccessingSecurityScopedResource` when reopening it. Not implemented; recent
entries rely on normal filesystem access.

**Tray and notifications** (`src-tauri/src/tray.rs`). Tauri `tray-icon` feature plus
`tauri-plugin-notification` 2.4.0 (newest release that resolves against the pinned
`tauri` 2.11.6; 2.5+ require tauri 2.12). The plugin is used from Rust only: no
`notification:*` permission is granted, and `check-capabilities` now forbids
`notification:`/`autostart:` grants. Tray menu: Show window, the active project name
(label), Quit; left-click toggles the window. Close-to-tray is off by default
(`tray-settings.json` in the app data dir) and is refused when no tray icon exists.
The `notify` command accepts only the templates `approval_needed` and `task_done` with an
optional detail (control chars and `<>&"` removed, 80 chars max) and is rate limited.
There is no auto-start.

Per-OS caveats:
- **Linux**: the tray needs `libayatana-appindicator3` (runtime) and its `-dev` package at
  build time; CI owner: add `libayatana-appindicator3-dev` to the apt step of
  `desktop-ci.yml` (not edited here). GNOME needs the AppIndicator extension, otherwise
  the tray is absent and the app runs without it (close-to-tray then stays off). Tray
  menus do not receive left-click events on most Linux hosts. Notifications use D-Bus.
- **Windows**: notifications from an unpackaged exe show under the exe's name; an
  installed (NSIS) build with an AppUserModelID is needed for correct attribution.
- **macOS**: the first `notify` triggers the system permission prompt; the menu-bar icon
  is a color icon unless a template image is supplied (icon polish open).

## Security hardening of the host (post-review)

An independent review of the Tauri host drove these changes (all covered by tests; none of the GUI paths was run in a window here).

- **Terminal is gated in the host** (`pty.rs`). `pty_spawn`/`pty_write` need (1) the Terminal feature enabled in the host's own `LLMIDE_FEATURES` (unset/empty = all, same rule as the Mac app and server; the key is `terminal`), and (2) the user's approval in a native confirm dialog (`rfd`, run by the host, default deny) once per page load. A "No" is remembered until the page reloads; a reload or window close revokes consent and kills every shell. The shell runs with a scrubbed environment (no `LLMIDE_*`, `MEETNOTES_*`, `ANTHROPIC_*`, provider keys, or any variable named like a secret) and starts in the active project root (else `$HOME`; the repo root only in debug builds).
- **Core identity** (`core_host.rs`). A spawned server gets a per-launch random nonce (`LLMIDE_CORE_NONCE`, 32 bytes hex) and echoes it as the `x-llmide-nonce` header on `/health` (additive; the JSON body and schema are unchanged, no API version bump). The host never trusts a /health that lacks the nonce (a squatter on the port is rejected), tries ports 3457..3459, skips busy ones, and never follows HTTP redirects. An **adopted** `:3456` server cannot be verified (nothing shares a secret with it): `core_status` reports `trust: "adopted_unverified"` plus a `notice`, the status bar shows "adopted (unverified)", and the host sends it nothing credential-bearing. A same-user proof (a nonce file written by a server the host did not spawn) would need a server-side writer and is not built.
- **Private state.** The spawned core's DB lives in `<app data dir>/core/poc.db` (dir created 0700, symlink and foreign-owner refused), not under the temp dir. `recent-projects.json` and `tray-settings.json` are bounded, written atomically with mode 0600. A lock file (`instance.lock`, `flock`) allows one app instance per data dir so two first-run instances cannot overwrite the keychain secrets.
- **Errors.** `core_status.error` is a fixed message; the last core output, with secrets and long opaque tokens redacted, goes to `<app data dir>/core.log` (0600) only.
- **Graph read.** `read_graph_file` opens the file once (`O_NOFOLLOW`), checks the real path from the descriptor (`F_GETPATH` / `/proc/self/fd`) is still `<root>/**/graph.json`, `fstat`s that descriptor and reads from it (32 MB cap); the root is re-checked against the too-broad list every call. Release builds have no env/default root fallback: nothing is readable until a project is opened.
- **Webview.** CSP adds `base-uri/form-action/object-src/frame-ancestors 'none'`, `freezePrototype` is on, and the dev server origins moved to `devCsp` (the release CSP has no `127.0.0.1` at all: the webview never talks to the core directly). A navigation guard plugin blocks any navigation off the app's own origin. `freezePrototype` can break a library that mutates built-in prototypes; if a GUI run shows that, fix the library, do not drop the flag.
- **Build gates.** `check-capabilities` no longer fails open (it compared `import.meta.url` to `file://argv[1]`, false for paths with spaces or a symlinked prefix), allowlists `core:*` permissions, rejects unknown permissions and `#[cfg]`-gated handlers, and `--product` fails if `capabilities/spike.json` exists. `stage-core` copies only `.mjs/.json/.sql` under `kb/`, drops symlinks, and re-walks the finished stage failing on `*.db*`, `*.pre-move`, `*.bak`, `.dev-secrets*`, `server.log`, `backups/`, secrets, non-source files under `kb/` and any symlink leaving the tree (`scripts/stage-filter.mjs`).
- **Too-broad roots** now also refuse `~/.ssh`, `~/.aws`, `~/.gnupg` (and anything inside), `~/.config` itself, `/proc`, `/dev`, `/sys`, `/boot` (and inside), `/root` itself and the `/private/var/folders/xx/yyyy[/T]` temp roots; Rust (`project.rs`) and `extension/core/broad-root.mjs` stay in step.
- **Server side.** git/npm/skills helper children spawned by `llm-sources/registry.mjs`, `kb/install-project-skills.mjs` and `llm_agent/sdk/updater.mjs` use `core/child-env.mjs` (`scrubbedChildEnv`): no `LLMIDE_*`, `MEETNOTES_*`, `ANTHROPIC_*` or provider keys; PATH, HOME, proxy and locale pass through.
- Notification detail also drops bidi/format characters and links; `secrets_status` is cached for 60 s (invalidated when secrets are created) so the webview cannot hammer the OS credential store.
