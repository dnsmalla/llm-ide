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
path) and `claude_notice` (the server's own install message when `missing`), and
`core_log_path` (the absolute path of the redacted failure log `core.log`, never its contents; the
file exists only after a failure). A consumer that switches on `state` must handle `restarting`.

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

## Host prefs, neutral folder pick and trust confirmation

**`prefs.json`** (`src-tauri/src/prefs.rs`, `get_prefs` / `set_prefs`). Bounded (16 KB), atomic, 0600, in the
data dir. Strict typed schema: unknown keys and bad values are refused at deserialisation; an unreadable,
oversized or hand-edited file means the defaults. Keys: `ltaMode` (`off` default | `shadow` | `on`), `router`,
`cap`, `compress`, `learn` (token-affecting, default OFF; `cap` and `compress` are stored only while `router`
is on), `terminal` (default on), `theme`. The file is read once at launch (`prefs::init`, before the core is
spawned); a change applies at the NEXT start and `restartNeeded` says so. What each does:

- router/cap/compress/learn become `LLMIDE_ROUTER`, `_CAP`, `_COMPRESS`, `_LEARN` for the SPAWNED core, only as
  the exact value `on` (`extension/core/router-flags.mjs`). The core's environment is scrubbed, so the host's own
  environment cannot turn them on; an adopted core keeps its own.
- `terminal` off removes `terminal` from the host's Terminal gate and from the `LLMIDE_FEATURES` the core gets
  (the explicit list of every other feature; `FEATURE_KEYS` in `prefs.rs` is pinned to `config.mjs` by a test).
- `ltaMode` is not read by the core (in the Mac app it is a UserDefaults key too): the host's chat archive uses it
  (`ArchivePolicy`): off = no quit archive and the start sweep only forwards pending deletes; shadow = verify and
  record receipts, never purge; on = the full verify, receipt, purge.
- `theme` is mirrored from the webview and used at boot only if the webview's own storage lost the choice.
There is no `tools` host switch: "tools on provider models" is a core setting (Settings > Model routing).

**`pick_folder`** (`source_pick.rs`) opens the native folder dialog and changes no state (not the project, not the
notes folder). It returns an opaque single-use token and the folder name; `pick_folder_redeem(token)` releases the
canonical path once, within two minutes (8 tokens at most). The choice is validated like a project root
(`project::validate_root`, too-broad refusal). One dialog at a time, rate limited.

**`trust_confirm(path)`** (`confirm.rs`) is the native, default-Cancel confirmation for trusting a folder. The text
is fixed and names the folder (control and bidi characters removed, capped); the page cannot change the text,
only name the path (absolute paths only). Used by the chat trust banner (`nativeConfirm`) and Settings > Extensions
trust. `bypass_confirm` is unchanged.

**Shell exit.** `pty_spawn` takes a second channel, `on_exit`: after a shell's last output batch is delivered it
fires once, so a tab reads "(exited)" at once.

## macOS app build (`scripts/build-desktop-mac.sh`)

`scripts/build-desktop-mac.sh [--dmg] [--skip-checks] [--no-smoke]` builds `LLM-IDE.app` for this Mac. Steps, each
idempotent: `npm ci` in `ui/kit` and `desktop` when their lockfile is newer; `stage-core.mjs --target <host>` with
`LLMIDE_STAGE_RELEASE=1` (pinned, hash-checked official Node, production deps, no SDK `claude` binary, staged-tree
verifier); `check:security`; `tauri build --bundles app` (runs `npm run build` itself); ad-hoc `codesign --force
--deep --sign -` then `codesign --verify --deep --strict`; `scripts/verify-bundle.mjs` (layout, node present and
executable, `server.mjs`, no `claude` executable or SDK package, no `.db` / `.pre-move` / secret files via the
staged-tree verifier run on the bundle's own copy, Info.plist: `CFBundleIdentifier` `com.llmide.desktop`
(distinct from the Swift app's `com.llmide.macapp`), `CFBundleName` `LLM-IDE`, the three folder usage
descriptions); `smoke-core.mjs` against the core inside the app (`LLMIDE_CORE_DIR`); optional `.dmg` with
`hdiutil` (no Finder scripting, so it works headless). Output:
`desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app`. It never launches the app.

Signing: ad hoc, no hardened runtime, no entitlements file. That is what a locally built app needs. A Developer ID
signature with the hardened runtime and notarization additionally needs `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.disable-library-validation` (the bundled node JITs and loads `better_sqlite3.node`), and
each nested executable signed with the same identity ([desktop-signing-decisions](../docs/how-to/desktop-signing-decisions.md)).
Ad-hoc identity changes with every build, so macOS asks again for keychain and folder access after a rebuild.
Quarantine: a build made here has none; a copied or downloaded app needs
`xattr -dr com.apple.quarantine /Applications/LLM-IDE.app`. Run it with [RUN-ON-MAC.md](RUN-ON-MAC.md).

## Host commands for the screens (links, attachments, Bypass, reveal)

Five small host commands, each with its own `allow-*` grant (no opener, dialog, shell, fs or clipboard plugin permission). Shared pieces live in `src-tauri/src/confirm.rs`: a rate limiter, a one-line sanitiser (control and bidi characters dropped) and a native confirm whose DEFAULT button is Cancel (rfd custom buttons, Cancel listed first; only the exact accept label counts, any other result is a refusal). The webview cannot prove a user gesture, so these dialogs are the mitigation.

- **`open_external_url(url) -> bool`** (`os_open.rs`). http/https/mailto only, parsed with the `url` crate (2.5.8, already in the lock through tauri; MIT OR Apache-2.0). Refused: whitespace/control/backslash/bidi characters, over 2048 bytes, userinfo, no host, `localhost`, single-label and intranet names (`.local`, `.internal`, `.lan`, `.home.arpa`, ...), numeric TLDs, and IP literals in loopback/private/link-local/CGNAT/multicast/documentation/reserved ranges including IPv4 hidden in IPv6 (mapped, compatible, NAT64, 6to4, Teredo); decimal/hex/octal IPv4 forms are normalised by the parser first. mailto keeps only to/cc/bcc/subject/body (an `attach=` key can attach a local file). 500 ms gap and 30 per minute; the first open per host per app session asks in a native dialog showing the host and the full address, `false` = declined. Known gap: a public name that resolves to a private IP (DNS rebinding) is not detectable without a lookup; the dialog is the control. OS invocation, no shell, fixed program, args array, env scrubbed with `pty::shell_env`, stdio closed, child reaped on a thread: macOS `/usr/bin/open <url>`; Windows `%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler <url>`; Linux the first existing absolute `xdg-open` (`/usr/bin`, `/bin`, `/usr/local/bin`; no PATH search).
- **`reveal_in_os(relPath)`** (`os_open.rs`). Path relative to the active project root, validated by `fs_ops::resolve_existing` (no `..`, canonicalised, must stay inside the root, symlink escapes refused; `""` is the root). macOS `/usr/bin/open -R <path>`; Windows `explorer.exe /select,"<path>"` as one raw argument (verbatim `\\?\` prefix stripped); Linux opens the PARENT FOLDER only, never the file. 300 ms gap, 60 per minute.
- **`attach_pick_files()` / `attach_read(handle, offset, len)` / `attach_release(handle)`** (`attach.rs`). The host runs the multi-file dialog and returns `{ files: [{ handle, name, size, mime }], rejected: [{ name, reason }] }`: never a path. Each pick is canonicalised once, opened `O_NOFOLLOW | O_NONBLOCK` and `fstat`ed (regular files only; devices, FIFOs, sockets, directories refused unread); the handle owns the open descriptor, so a later path swap changes nothing. Reads are positional, at most 4 MiB, never past the size recorded at pick time. Limits: 25 MB per file, 100 MB total, 64 handles, 20 files per pick; handles expire after 30 minutes, on release, on page reload and at quit. Nothing logs file names. Mime comes from the extension only.
- **`bypass_confirm(summary?) -> bool`** (`confirm.rs`). Native modal, default Cancel, fixed template with the capped single-line summary shown as a quoted detail; rate limited, one at a time. The chat screen must fail closed without a `true`.
- **No clipboard command.** `navigator.clipboard` works in the Tauri webview; adding `arboard` would add a native dependency for no gain.

Not verified: any of the dialogs in a real window (macOS, Windows or Linux), the Windows and Linux opener invocations (unit-tested as argument lists only), Windows `seek_read` and the `\\?\` stripping, and that Return/Esc pick Cancel on every rfd backend (macOS NSAlert default is the first button; GTK/portal and Windows not run).

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

## Security hardening round 2 (compromised-webview review)

Threat model: a compromised webview (XSS through model output) that holds the `main` window's grants and a core JWT. A second independent review of the Rust host drove the changes below, one commit per finding; each has tests.

- **`.git` is never writable from the webview (F1).** Every `fs_ops` mutator (write, create, rename source AND target, delete, and so `notes_write`) refuses any path with a `.git` component (any case, NTFS trailing dots/spaces and `GIT~1`, HFS ignorable code points), also when it is reached through a symlink (`protected_path`). `.gitignore`/`.gitattributes` stay ordinary files.
- **Git config is an allowlist, not a denylist (F1).** `git_config.rs` refuses the repo config unless every byte is understood: no BOM, valid UTF-8, no NUL / bare CR, no line continuation, no dotted sections, only `core` (plain data keys), `extensions.objectformat`, `user.name/email`, `remote.*` (url/pushurl/fetch/push/tagopt/prune), `branch.*`, `submodule.*` (url/active only), and a few `pull`/`push`/`fetch`/`init`/`commit.gpgsign` keys. So `filter.*`, `diff.*`, `merge.*`, `credential.*`, `alias.*`, `include*`, `url.*`, `http.*`, `gpg.*`, `protocol.*`, `core.fsmonitor/hooksPath/sshCommand/pager/editor/gitProxy/worktree`, `extensions.worktreeConfig` all make the repo `untrusted_repo_config`. `config.worktree` is scanned too. A `.git` FILE must point inside the project, or be a real linked worktree (its `gitdir` back-pointer names this folder; the common dir config is scanned), or a submodule git dir whose `core.worktree` is exactly this folder. The runner adds `-c submodule.recurse=false -c protocol.allow=never -c status.submoduleSummary=false -c maintenance.auto=false -c gc.auto=0 -c core.attributesFile=/dev/null -c diff.ignoreSubmodules=dirty` and `--ignore-submodules=dirty` on status, so git never starts a `status` inside a submodule (which would read the submodule's own config). User-visible: a repo whose local config has an alias/credential/http/etc. section is now shown as untrusted until reviewed outside the app (previously only program-running keys).
- **Terminal consent (F2).** The native dialog is Cancel-first (`confirm::ask`, button order covered by a test) instead of rfd Yes/No (Return used to grant). The approval expires after 30 minutes (then the next spawn asks again, and typing into an already open terminal is refused until a new approval), and an answer to a dialog opened for an older page load is discarded.
- **Host-signed approvals for Bypass (F3), host half only.** `bypass_confirm` stays a bool and stays advisory. New `bypass_confirm_signed(summary?) -> string | null` runs the same Cancel-first dialog and, on accept, returns a 60 s single-use token `v1.<expiry_ms>.<nonce>.<mac>`, `mac = HMAC-SHA256(key, "llmide-host-approval/v1|bypass|<expiry_ms>|<nonce>")` (`host_approval.rs`; HMAC checked against the RFC 4231 vectors). `key` is a per-launch random 32 bytes held in host memory and passed ONLY to the core this app spawns as `LLMIDE_HOST_APPROVAL_KEY` (hex; never to an adopted core or a terminal, redacted from the core log). **UX-only until the core verifies it.** Blocked-by item for `extension/**` (not changed here): when `LLMIDE_HOST_APPROVAL_KEY` is set, the core rejects any request that asks for `permission-mode=bypass` without a valid `x-llmide-host-approval` header (recompute the MAC, `expiry > now`, `expiry <= now + 60 s`, constant-time compare, remember the nonce until expiry so a token works once). The chat screen then sends the token from `bypass_confirm_signed` with the request.
- **Spike/bench commands are not in product builds (F7).** `ping`, `bench`, `bench_done`, `autobench_mode`, `graph_path_override`, `theme_override`, `section_override`, `sse_replay_*` and `ax_probe` are registered only with the cargo feature `spike` (default OFF; `lib.rs` `app_handler!`), `build.rs` embeds only `capabilities/default.json` unless that feature is on (`capabilities_path_pattern`), and `LLMIDE_POC_AUTOBENCH` is ignored (it used to skip the single-instance lock). `check-capabilities.mjs --product` now fails if `spike` is a default feature, `build.rs` does not gate the capability embedding, a non-spike capability grants a spike command, or a command only `spike.json` grants is registered in the always-on list. It runs in `npm run build`, `npm run check:security:product` and unconditionally in `scripts/build-desktop-mac.sh`, which also refuses a finished binary that still contains the autobench string. Dev and autobench runs: `npm run tauri dev -- --features spike`.
- **Chat store (F4, F11, F14).** Deleting a chat asks in a native Cancel-first dialog (per chat; rate limited) and moves the file to `<sessions>/.deleted/<UUID>.<ts>.json` (private folder, 30 days, at most 500 copies) instead of removing it; the UI sees the error code `declined` when the user says no. `chat_save` in replace mode refuses a drop of more than half the messages of a chat with more than 4 messages (`truncation_needs_confirm`) unless it carries the one-time, 60 s, chat-bound token returned by `chat_confirm_truncate` after a native dialog. The archive purge now compares the FILE's mtime with the server's `updatedAt` (no tolerance; the header's `lastUsedAt` is page-writable and ignored) and refuses a file with fewer messages than the store has seen (`fewerMessagesThanSeen`); the digest format is unchanged (shared with the server and the Mac; it already length-prefixes role and content of every message and the count is sent with it). In the Mac app's shared folder an unparseable file is reported (`unreadable`) and never moved; in the app's own folder quarantine is capped at 200 files. A corrupt or oversized `pending-deletes.json` is left in place, a copy is set aside once, and saves/deletes fail with `pending_corrupt` until it is fixed. Chat files are opened `O_NONBLOCK|O_NOFOLLOW` and must be regular (a FIFO cannot hang the reader); a lock whose owner has no readable start time is honoured for 10 minutes; tombstone attempts stop counting at 1000. User ids may not end in `.` or be Windows device names, per-user folders differing only by case are refused, and chat files with no `ownerUserId` are visible only to the first user who opened the store (`unowned-claim.json`; the Mac instead shows them to whoever is signed in until its explicit "Claim" action).
- **Chat token and core identity (F5).** `chat_bind_session` and the sweep/quit runs send the bearer token only to `CoreHost::verified_url()`: phase Ready, trust `spawned` (never `adopted_unverified`) and `/health` still echoing this launch's nonce, re-resolved at every use (a restarted core on another port is followed, a squatter is not).
- **Origins (F6).** Navigation guard and the spawned core's CORS list are per OS: macOS/Linux `tauri://localhost` only, Windows `http(s)://tauri.localhost` only, never a port; the dev server only in debug builds.
- **Removal (F9).** Every removal goes through `trash_guard::Trasher`: NSFileManager on macOS, a fixed-drive check on Windows (a drive without a Recycle Bin would make `FOF_ALLOWUNDO` delete permanently, so it is refused with `trash_unavailable`), and no permanent-delete fallback anywhere (tests inject a refusing trash). Not compiled or run on Windows here.
- **Smaller hardening (LOW).** New files use a no-replace rename (`link`+`unlink` where `RENAME_EXCL` is missing); notes folders are created through a verified parent descriptor (`mkdirat`); directory listings never report metadata of a link target outside the project; hard-linked notes are not read; the file watcher stops on project switch; `mailto:` with an encoded CR/LF is refused; `.svc .docker .k8s .consul .ts.net .cluster.local` are not public sites; the archive digest uses `sha2`; git branch validation is checked against `git check-ref-format`.
- **CSP.** `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly compile only, for the Code Graph layout kernel; no `unsafe-eval`, no `unsafe-inline`) in the release and dev CSP; the graph worker is a same-origin file (`worker-src 'self' blob:` already existed for Monaco). Pinned by `scripts/check-csp.test.mjs`.
