# Packaging the Node core (Phase 0, T6)

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
- Windows/Linux: same layout with `node.exe` / ELF node; better-sqlite3
  prebuilds per platform; no measurements yet.
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
a real packaged-app run on all three OSes (Tauri plan T6).

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
