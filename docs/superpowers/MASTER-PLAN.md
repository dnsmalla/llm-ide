# Master plan: desktop, mobile, web and extension

Created 2026-10-30 from the repo as of `a3897732`. This is the **living** total plan: what each surface needs to be complete, what exists, what is not done. Detail lives in the linked plans; this page is the one place to look. Principle (user, 2026-10-29): **professional quality over speed**; no gate is compressed to hit a date.

Legend: `- [x]` done (the repo evidences it) · `- [~]` partial · `- [ ]` not done. Owner tags: **(me)** the agent can do it, **(you)** needs the user (decision, real login, real device, money), **(wait)** time-gated (real usage or data must accumulate). "unverified" means a doc claims it and this page could not confirm it in the code or a run. Evidence is a commit hash or a repo path.

## Status dashboard

Numbers are computed from the checkboxes below by `node scripts/plan-status.mjs` (`--check` fails on drift; `--fix` rewrites this table).

| Surface | Done | Partial | Not started | Total | State |
|---|---|---|---|---|---|
| Desktop Mac (Swift) | 8 | 2 | 7 | 17 | Shipping product; feature-complete for today's scope, manual checks pending |
| Desktop multi-OS (Tauri) | 13 | 20 | 14 | 47 | Phase 0 spike measured (GO with 4 conditions); no product app, ADR still "proposed" |
| Mobile (iPhone native, PWA) | 9 | 6 | 10 | 25 | Native chat/explorer/auto-task client works through the Mac; PWA and push do not exist |
| Web app and relay | 6 | 1 | 7 | 14 | Scope decided (relay-served phone web view, built last in sync-kit); no relay code yet, host undecided |
| Chrome extension | 6 | 2 | 5 | 13 | Capture and live chat client work; stores nothing; origin pin and store listing open |
| Shared server and core | 14 | 4 | 1 | 19 | API 92, contract gates and feature matrix landed; kit K1 moves still ahead |
| Data and storage | 6 | 1 | 7 | 14 | Moved and backed up; live-then-archive phases 0-4 done, meeting phases wait for use |
| Agents, providers, extensions | 14 | 1 | 10 | 25 | Agent store, provider catalog, router built; token-affecting parts OFF until bench |
| Security | 10 | 2 | 5 | 17 | Loopback, vault, guardrails in place; relay, signing and Tauri scoping not started |
| Release and CI | 7 | 2 | 6 | 15 | Mac release/notarize and 8 workflows exist; Tauri, Windows, Linux builds do not |
| Total | 93 | 41 | 72 | 206 |  |

## How the surfaces connect

```text
 iPhone native app ──WS :3006 + Bonjour + PIN/token──► Mac app (SwiftUI) ──HTTP 127.0.0.1:3456──► Node server (core)
 Chrome extension ──HTTP localhost, JWT (no data of its own)────────────────────────────────────────┘      │
 Tauri desktop (future) ──Node sidecar = the same server───────────────────────────────────────────────────┤
 Relay + phone PWA (future, ADR 0018) ◄──E2E-encrypted snapshots / inbox──► desktop (main worker)           │
                                                                      SQLite data.db + agent.db (live) ──archive at quit──► Mac files
```

One-copy rule ([data-lifecycle](../kits/data-lifecycle.md)): a session is **live in the server DB**, then **archived once into the Mac app's files** and the server rows deleted; the **extension stores nothing** and calls the Mac app live; the **phone reads through the Mac** (relay later); the **web and external services are ingest connectors only**. Metadata (run history, usage) is outside that rule.

## Dependencies and critical path

Parents: [kit-by-kit migration](plans/2026-10-27-kit-by-kit-migration.md), [Tauri + relay plan](plans/2026-10-24-tauri-desktop-and-relay.md), [ADR 0018](../decisions/0018-tauri-desktop-node-core-relay.md), [ROADMAP](ROADMAP.md), [USER-CHECKLIST](USER-CHECKLIST.md).

1. **Bench go-ahead (you)** unblocks every token-affecting change (lean SDK config X1, SDK adoption X2, router defaults, ended-chat continuation X3). Until then those ship OFF.
2. **Manual app checks Y2 (you)** unblock turning live-then-archive `lta.mode` on by default and closing the Mac K1 work.
3. **Phase 0 closing items (you)**: user-run bench, one Windows run, Accessibility cadence. **Decided 2026-10-31:** ADR 0018 is accepted for the Phase 3 start, conditional; these measurements must be recorded before Phase 3 exits, and a failed Windows gate pauses the work. The relay still waits for sync-kit.
4. **Web app decided (Q-WEB-1 = A, relay-served phone web view, last, in sync-kit).** The relay, PWA, push and phone-without-Mac stay behind sync-kit; only relay hosting (Q-WEB-2) is still open.
5. **Kit order** (kit-by-kit plan): ui-kit, os-kit, docs-kit, graph-kit, knowledge-kit, agent-kit, work/workspace/capture, core job runner, automation-kit, sync-kit. Tauri K3 screens follow each kit's K1/K2; **sync-kit (relay + PWA) comes last** because it mirrors every other kit.
6. **Knowledge-kit K1 needs Q1-Q14, Q16, Q19 answered (you)**; meeting work (live-then-archive Phase 5 Mac side, 3, 6) waits for you to record meetings (wait).
7. **Swift retirement (K4 / Phase 6)** only after one release with both desktop apps and a parity checklist.

## Web app: the user's answers (2026-10-30)

- **Q-WEB-1 answered: option A.** The web app is the relay-served phone web view (PWA), built **last as part of sync-kit**.
- **Q-WEB-3 answered:** the phone through the Mac is enough for now; phone-without-Mac (relay) comes later.
- **Q-WEB-2 open by decision:** relay hosting (VPS or Cloudflare) is decided later, with the relay work.

The original analysis is kept below for the record.

**The repo has no web app plan.** Searched: `docs/superpowers/plans/*`, `docs/decisions/*`, `docs/kits/*`, ROADMAP, `desktop/`, `extension/`. The nearest existing things are:

- the **relay + phone PWA** in the sync-kit row and ADR 0018 (phase 4 of the Tauri plan): an always-on service holding E2E-encrypted snapshots, a phone PWA served by it, extension read/queue while the desktop is off. **No code exists**; hosting is undecided (small VPS or Cloudflare Workers + R2);
- the **"the web is a connector" rule** ([data-lifecycle](../kits/data-lifecycle.md) rule 3): the web and external services are ingest sources only;
- the **React web bundles** that already run inside the Mac app (`mac/LocalPackages/graph-kit/web/`, the System/OS view, commits `b31133e0`, `641fa2fd`): not a hosted web app;
- the Chrome extension, which is the only browser-resident surface.

Q-WEB-1. **What is "the web app"?** Options:

| Option | What it is | Fit with the rules |
|---|---|---|
| A. Relay-served PWA (recommended) | The ADR 0018 relay serves one installable web app for phone and any browser: read snapshots, queue requests, desktop does the work | Matches one-copy (snapshots are encrypted, not a second store), "no data access" on the relay, and replaces the cleartext `:3006` link |
| B. Connector-only web | "Web" means external sources (Slack, Box, Email, MCP) only; no hosted UI | Already built; nothing to plan beyond the connector items |
| C. Full hosted web client | A server-side app with its own login and data | Breaks one-copy, loopback-only and "no data access" rules; needs a new ADR |

Recommendation was **A**, built last (sync-kit), after Tauri K3 provides the shared React UI; the user chose it. Q-WEB-2: relay hosting, VPS or Cloudflare (ADR 0018 decision 2), is decided later. Q-WEB-3 was answered: "through the Mac" is enough for now.

## S1. Desktop Mac (Swift)

**Complete means:** the SwiftUI app stays the shipping product until each kit's K4; all 16 features sealed; reduced builds work; daily-use flows verified by the user.
**Connection:** spawns the Node server (`BackendManager`), serves the phone on `:3006`, archives live sessions to Mac files at quit.

- [x] 16 features sealed, 8-check boundary gate in `make regression` (CLAUDE.md; `mac/Scripts/feature-boundaries.sh`) (me)
- [x] Reduced builds lite / min / mobile-only (`Makefile` build-mac-*; `bb4342dc` feature matrix) (me)
- [x] Chat on Agent SDK v2, classic engine and `/code-assist` retired (ROADMAP Done, agent-kit P6) (me)
- [x] Settings: Agent history card, Storage hub, Clear/Compact (ROADMAP Done) (me)
- [x] System (OS) view in a web view (`641fa2fd`, `f44e52e0`, `104f85d9`) (me)
- [x] Quit archive with crash recovery, delete-everywhere, sign-out safety (ROADMAP Done, live-then-archive Phases 0-4) (me)
- [x] Apply & Rebuild card for source checkouts (CLAUDE.md; `FeatureRebuildService`; unverified in a run) (me)
- [x] Provider settings consolidation: one Providers list and one Model routing section replace four sections (`d7ce5367`, `b56d80c3`, `c586f506`, `2a0501db`); DeepSeek plain-chat and "tools (assumed)" UI fixes (`400110ed`) (me)
- [ ] Provider settings live-app verification: DeepSeek connection, router switch, tools switch in the running app (me)
- [~] Plugin / MCP / LLM-source screens in sealed `Features/Extensions` (ROADMAP Track Q Mac half); real-app check pending (you)
- [ ] Y2 manual checks: 12-step quit/relaunch with `lta.mode=on`, provider card, chat cap chip, moved screens ([USER-CHECKLIST](USER-CHECKLIST.md) B) (you)
- [ ] Decisions Q19 (notes without `platform` invisible), Q16 (search latency at 50k notes) (you)
- [ ] Loose ends: Q21 quit delay on macOS logout, Q11 `llmide://` from Chrome (ROADMAP Loose ends) (me)
- [ ] Meeting flows Mac half: ack with `lines`/`hash`, dedupe by session id, meeting-attached chat (ROADMAP M1) (wait)
- [ ] Library read-path switch to `note_index` (M3) and legacy duplicate-row deletion (L1) (wait)
- [~] Swift feature freeze: **in force with the Phase 3 start (inferred consequence of the 2026-10-31 acceptance; user to confirm).** New Mac features stop; allowed: bug and security fixes, work needed for parity or for the shared core contract, and release/build upkeep. Exact definition and exceptions in `plans/2026-10-31-tauri-phase3-plan.md` section 10 (you)
- [ ] K4 Retire: remove each kit's Swift UI one release after its Tauri screen (kit plan) (wait)

## S2. Desktop multi-OS (Tauri)

**Complete means (macOS, Windows, Linux):** Tauri 2 + React app over the Node sidecar, feature parity with the Mac app, signed and auto-updating on three OSes, then Swift retired (ADR 0018, Tauri plan phases 3, 5, 6).
**Connection:** the sidecar is the same Node core on loopback; becomes the main worker with one company API key; talks to the relay (S4).

- [x] ADR 0018 written (status: **proposed**) (`375fc325`) (me)
- [x] Phase 0 spike built and tracked on `main` (`desktop/`, 87 files; `23ff0813`, `d4e80fd1`, `4a73b581`) (me)
- [x] Phase 0 report: GO with four conditions; graph 59.8 fps at 10k, 50.9-56.5 fps at 50k, Node core runs unchanged (`docs/superpowers/plans/2026-10-25-tauri-phase0-report.md`) (me)
- [x] Design tokens generated for every web surface from `schema/design/tokens.json` only (`scripts/gen-design-tokens.mjs`; the regex-over-Swift desktop generator is gone, drift gate in `make contract-gates` and `make test-desktop-node`); Mac pixel parity unverified (me)
- [x] Chat renders incrementally, no dropped events in benches (Phase 0 condition 3) (me)
- [~] Node sidecar: `desktop/src-tauri/src/core_host.rs`, `stage-core.mjs`, `PACKAGING.md`; production lifecycle built (see the T6 line), no Windows run yet (me)
- [~] Do not bundle the SDK's `claude` binary (condition 2): the report measures 67 MB without it; `stage-core.mjs` removes the SDK platform package and fails if a `claude` binary remains, `check-core-deps` re-verifies (me)
- [ ] Phase 0 open: user-run autobench with the window frontmost, to confirm numbers and the 30 s hidden phase (you)
- [ ] Phase 0 open: one Windows autobench run (graph >= 30 fps, sidecar start/quit, installer size) (you)
- [ ] Phase 0 open: Accessibility grant to measure caption read cadence; optional Swift cold-start comparison (you)
- [~] ADR 0018 accepted for the Phase 3 start, conditional (user decision 2026-10-31): the Phase 0 measurements above are recorded before Phase 3 exits, a failed Windows run pauses work; the gate itself has not passed yet (me)
- [ ] Graph layout in Rust or WASM (condition 1; ForceAtlas2 in WKWebView is 4-7x slower than Node) (me)
- [x] Monaco's vendored DOMPurify patched: vite redirects its import to pinned `dompurify` 3.4.17 (b1b3d17f); `npm run check:security` + `vite build` show no 3.4.15 in dist (me)
- [x] Tauri capabilities scoped (AppManifest + explicit allow-*, no core:default/wildcards, `check-capabilities`), `read_graph_file` limited to the project root (8 cargo tests), terminal credit-based flow control (5 cargo tests); cargo check/test and 14 node tests pass, GUI launch and a real `yes` flood not run here (me)
- [x] ui-kit extraction: `ui/kit` (`@llmide/ui-kit`) holds the tokens CSS, 8 promoted components and one Lucide icon set; the desktop consumes it, no spike behaviour change; 27 kit tests, `npm run build`, `check:security` green (`563c08da`, `4b7f4aa0`; decisions U1 to U6 provisional in `docs/kits/ui-kit.md` section 11) (me)
- [ ] ui-kit parity bar: pixel-tolerance fixtures against the Mac render (decision U4; needs a headless browser and a Mac fixture render, not built; today DOM/ARIA, token, contrast and alias-drift tests plus 5 reviewed screenshots) (me)
- [ ] K3 screens per kit on ui/kit: Chat, Library, Explorer, Settings, Issues/Gantt, Doc Gen, Graph, Loop/Auto Tasks, Live (kit plan K3) (me)
- [ ] Tauri feature-off mechanism decided: build-time tree-shake plus runtime `/health features` (kit plan "Gates added") (you)
- [~] Packaged Node sidecar for all three OSes, finds the user's `claude` CLI, survives quit/restart (Tauri plan T6): supervised lifecycle (nonce health, bounded backoff restart, fatal state, tree stop via process group / Windows Job Object), `llm-ide-desktop` data dir, allowlisted env + widened PATH, pinned SHA-256-verified official Node per target, `smoke-core.mjs`, release workflow stages + smokes macOS arm64/x64, Windows, Linux; `core_status` extended additively (`restarting`, `restarts`, `fatal`, `claude*`); 79 cargo tests + macOS staged-core smoke and real-launcher run pass, Windows/Linux/x64 runs and Mac-KB import not done, see `desktop/PACKAGING.md` (me)
- [x] Server finds the user's `claude` (`extension/providers/claude-path.mjs`: env, bundled, PATH + per-OS dirs, validated) for the SDK engine (`pathToClaudeCodeExecutable`) and CLI spawns; 9 fake-executable tests; no packaged-app run on any OS yet (me)
- [x] Keychain / secret store per OS: `desktop/src-tauri/src/secrets.rs` (`keyring` 3.6.3, one backend per OS, generate-once JWT secret + vault key under `com.llmide.desktop`, env-only to the sidecar, fail closed, no plaintext fallback, memory backend via `LLMIDE_KEYCHAIN_BACKEND=memory`, `secrets_status` booleans only); 7 cargo tests, cargo check/test, 17 node tests, check:security, build pass; real Windows/Linux stores and a signed-app macOS run not verified, see `docs/how-to/desktop-secret-store.md` (me)
- [~] Project open: host-run native folder dialog (`rfd` 0.17.2, no dialog/fs permission for the webview), canonicalised root, too-broad roots refused (Rust mirror of `broad-root.mjs`), bounded recent list, becomes the `read_graph_file` root, `NS*FolderUsageDescription` strings kept; 12 new cargo tests (34 total), `cargo check`, 17 node tests, check:security, build pass. Open: no GUI/dialog run, security-scoped bookmarks for sandboxed builds only documented (`desktop/PACKAGING.md`), sidecar does not yet follow the active root (me)
- [~] Tray / menu-bar presence and notifications: tray menu (Show, project name, Quit), left-click toggle, close-to-tray default off, `notify` limited to 2 fixed templates (capped plain text, rate limited, no notification permission granted to the webview), no auto-start; `tauri-plugin-notification` 2.4.0; cargo tests pass. Open: not run in a GUI, Windows/Linux untested, Linux needs `libayatana-appindicator3-dev` in CI (see `desktop/PACKAGING.md`) (me)
- [x] Host security review fixes: terminal behind a native consent dialog + Terminal toggle read in Rust with a scrubbed shell env; spawned-core identity by per-launch nonce (`x-llmide-nonce` on `/health`, additive), no redirects, adopted `:3456` core flagged `adopted_unverified`; DB in the 0700 app data dir; redacted `core.log` instead of raw tails in `core_status`; graph read via fd (O_NOFOLLOW + F_GETPATH, 32 MB); hardened CSP + navigation guard; `check-capabilities` fail-open fixed (+`--product`, core allowlist); `stage-core` kb allowlist + staged-tree verification; broad-root lists extended (Rust + JS parity); server git/npm children scrubbed (`core/child-env.mjs`); single-instance lock. 58 cargo tests, 29+ node tests; no GUI run, see `desktop/PACKAGING.md` (me)
- [ ] Live caption capture per OS: macOS AX first, Windows next, Linux best-effort (Tauri plan risks) (me)
- [ ] Signing, notarisation (macOS), Authenticode (Windows), signed updates, auto-update channel (me)
- [~] Windows and Linux builds in CI: `desktop-ci.yml` written (cargo check + test --lib, WebKitGTK deps), not yet run on GitHub; WebKitGTK graph render check not done (me)
- [x] Parity checklist exists (`plans/2026-10-31-tauri-parity-checklist.md`; rows filled as screens land) (me)
- [ ] Phase 3: Chat + Explorer + Library + Settings screens on ui/kit, daily use on Mac and Windows (`plans/2026-10-31-tauri-phase3-plan.md`) (me)
- [~] Phase 3 slice S-C Explorer: root-confined host fs/watch/git commands and virtualised tree, tabs, Monaco screen built and unit-tested; GUI run, Windows and parity rows 3.x pending (`ui/screens/explorer`, `desktop/src-tauri/src/{fs_ops,fs_watch,git}.rs`) (me)
- [~] Phase 3 slice S-H Explorer panels: panel switcher, project search (Rust `project_search.rs`, 101k-file scan 2.1 s, streamed, capped, root-confined) with a windowed results UI, terminal dock (xterm, tabs, consent pre-explanation and denied/Try again, scrollback cap, safe paste and links, per-OS shell) built and unit-tested; no GUI run, Windows untested, replace deferred (`ui/screens/explorer/{search,terminal}`, `desktop/src-tauri/src/{project_search,pty}.rs`) (me)
- [~] Phase 3 S-F Settings screen built, not GUI-verified: Providers, Model routing, Agent history, Extensions trust, Appearance, Workspace, Features, Account, About in `ui/screens/settings/` with a section registry, typed decoders and 65 node tests; the S-A adapter now exists (see the integration item); Claude-compatible endpoints are wired to the API 99 routes; the host placeholders are closed: archiving mode, router/cap/compress/learn and the Terminal switch are host prefs (`get_prefs`/`set_prefs`, applied at next start), Add folder uses the neutral `pick_folder` + single-use redeem, trust uses the native `trust_confirm` (`plans/2026-10-31-tauri-parity-checklist.md` section 5) (me)
- [~] Phase 3 integration of the first four screens, not GUI-verified: Chat, Explorer, Library and Settings all mount in the shell (`index.tsx` default export with `SectionProps`); Settings gets a real `SettingsEnv` from the shell (`ui/screens/shell/settings-adapter.ts`: core client with error envelopes as data, diagnostics, theme, notes folder, sign-in/out); Chat uses the host chat file store through `TauriChatStore` with a session binding that follows sign-in, refresh, core restart and sign-out; typed shell bus for Open in Explorer and Settings links; an end-to-end harness starts the real core with the fake engine and drives login, binding, a streamed turn and the Settings adapter (`ui/screens/shell/tests/e2e/`, 14 tests); `desktop` node tests, `check:security`, `tsc` and `vite build` pass; the LTA mode, route prefs, folder picker, native trust confirmation, core log path and shell-exit event now have host commands (`prefs.rs`, `source_pick.rs`, `confirm.rs`); open: attachments are not wired, chats held only on the server are not listed, and nothing ran in a real window (me)
- [~] Phase 3 S-E Library read side built, not GUI-verified: notes folder host commands (`desktop/src-tauri/src/notes_fs.rs`, read-only, hardened open, 50k paging, iCloud placeholders), sections, virtualised list, safe markdown viewer, meeting detail, local filter, FTS state machine and index rebuild in `ui/screens/library/` with 107 node tests and 15 Rust tests; `GET /kb/index/search` and `open_external_url` now exist and the screen is wired to them via the shell (search with kinds, rebuild of every note kind, asserted against the real core); notes without `platform` show under Unsorted (parity row records the Mac difference) (`plans/2026-10-31-tauri-parity-checklist.md` section 4) (me)
- [~] Phase 3 S-I Library write side and source panes built, not GUI-verified: host commands `note_open/note_save/note_create/note_rename/notes_delete_many` (`desktop/src-tauri/src/notes_write.rs`, 13 Rust tests: CAS on a content hash, create never overwrites, no write through symlinks or hard links, trash only through an injected trasher, never permanent) and `source_pick_folder`; in `ui/screens/library/{write,sources}/`: surgical frontmatter editor (unknown keys, order, quoting, CRLF byte-stable, tested on every shared fixture), editor session with conflict choices and unsaved-changes guard, new/rename/delete dialogs, 1,000-note chunked bulk delete and tag with progress, Stop and a typed confirm, Re-summarise through `/kb/summarize` with CAS, incremental list updates (no rescans), Email/Slack/Box/Repositories/Connectors panes with write-only secrets, fetch-then-write-then-mark-seen ingest; 62 node tests plus the Rust ones; open: LLM classification and `llm-doc/` notes for fetched items, hide tombstone, Monaco editor, shared non-secret source settings with the Mac, real-window and real-account runs (`plans/2026-10-31-tauri-parity-checklist.md` section 4) (me)
- [~] Phase 3 S-J Extensions screen built, not GUI-verified: Library entries Extensions (Installed, Browse, Install tabs; consent sheet naming each executable kind and binding to the pinned or previewed commit; update preview with lazy diff groups; rollback, repair, remove confirmed), Plugins, LLM Sources and MCP Plugins lists with switches, MCP consent and plugin hook-trust gates, in `ui/screens/library/extensions/` (virtualised lists, typed decoders for every `schema/http/fixtures/extensions/` fixture, error text for every known code, untrusted text cleaned and capped) with ~100 node tests; open: add/remove/import/update dialogs for MCP, LLM sources and legacy Claude/Codex plugins, per-item LLM-source checkboxes, real-window run (`plans/2026-10-31-tauri-parity-checklist.md` section 4) (me)
- [~] Phase 3 host commands for the UI owners built, not GUI-verified: `open_external_url`, `reveal_in_os`, `attach_pick_files`/`attach_read`/`attach_release`, `bypass_confirm` in `desktop/src-tauri/src/{os_open,attach,confirm}.rs`, each with its own `allow-*` grant and 17 Rust tests; no clipboard command (the webview's `navigator.clipboard` is enough); `open_external_url` and `bypass_confirm` are wired in Chat and Library; attachments are not wired; a real macOS/Windows/Linux GUI run is pending (`desktop/PACKAGING.md` "Host commands for the screens") (me)
- [~] Host-approved Bypass (F3) core half done: with `LLMIDE_HOST_APPROVAL_KEY` set (host-spawned core) `/agent/v2/stream` Bypass needs a valid single-use `x-llmide-host-approval` token or answers 403 `HOST_APPROVAL_REQUIRED` (API 101), a token opens a 30 min per-chat grant, phone/extension/remote origins are capped at Ask, approved turns are audited `approvedBy: host`, unset env is the unchanged legacy path (`docs/spec/api-server.md` 7g, `extension/core/host-approval.mjs`, 21 tests); the chat screen now calls `bypass_confirm_signed` and sends the token once as the header (`ui/screens/chat/bypass.ts`, header allowlist in the shell core client; 403 falls back to Ask); the native dialog + real-core round trip are unverified in a real window (me)
- [~] macOS app runnable, not GUI-verified: `scripts/build-desktop-mac.sh` builds `desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app` (163 MB; `.dmg` 73 MB, bundle id `com.llmide.desktop`, data dir `llm-ide-desktop`, so it coexists with the Swift app), ad-hoc signed and verified (`codesign --verify --deep --strict`, `verify-bundle.mjs`: layout, no SDK `claude` binary, no db or secret files, Info.plist folder usage texts), the bundled core passes `smoke-core.mjs` and the 12-test shell e2e suite (`LLMIDE_E2E_BUNDLE`, fake engine); the user's first-run checklist and known gaps are in `desktop/RUN-ON-MAC.md`; the window itself was never opened by an agent (me)
- [x] Phase 3 core routes for the screens (additive, API 96 to 99, fixtures with errors, `docs/spec/api-server.md` 7b to 7e): `GET /agent/v2/turns` + `GET /agent/v2/turns/stream` (memory-only bounded replay, `detach` stream flag), `GET /kb/chat/sessions/:id?beforeSeq=` (+ `hasMore`), `GET /kb/index/search` + note kinds beyond meeting, Claude-compatible endpoints (`anthropic-compatible` catalog entry, `GET /kb/providers/custom`, no new dependency); full tool results are not retained, so the UI keeps the truncation (me)
- [~] Phase 3 adoption of the core routes in the screens, not GUI-verified: chat sends `detach: true`, re-attaches running turns through the replay stream (sequence-checked, micro-batched, gap marker, Stop works), pages history with `beforeSeq`/`hasMore`; Library search and an all-kinds index rebuild use `GET /kb/index/search` and the API 98 kinds; Settings adds Claude-compatible endpoints (API 99) with the limits in plain words; asserted against the real core in `ui/screens/shell/tests/e2e/`; a real-window reload with a long turn still to run (`plans/2026-10-31-tauri-parity-checklist.md` sections 3, 4, 5) (me)
- [~] Phase 3 chat composer and plan flow (slice S-L), not GUI-verified: `/` menu over seven core-backed surfaces plus modes and models (windowed for 5,000+ rows, Swift built-in list drift test), `@` mentions (bounded index, folder browse for 100k-file projects, notes), attachments through `attach_*` with chunked reads and released handles, plan cards (save under `llm-doc/plans/`, edit, refine, execute with `planExecute`, 'Nothing to execute.'), edit diffs, mode badge, subagent chip, route history; blocked-by a core ended-chat marker, a note body route and a project file search route (`ui/screens/chat/{slash,mentions,attach,plan,badges}`, parity checklist section 2) (me)
- [ ] Parity checklist all rows verified against the Mac app, including Home/toolbar navigation (report "Navigation parity") (you)
- [ ] Phase 5 (macOS first and finished, then Windows and Linux): Code Graph, Issues + Gantt, Doc Gen + Visual, Live capture helper, Loop + Auto Tasks on the core job runner, quick chat, System page; the Tauri app does not host `:3006` (the Swift app keeps the phone until the relay); exit gate = daily use on macOS except the named deferrals (`plans/2026-10-31-tauri-phase5-macos-plan.md`, parity sections 7 to 12); Auto Tasks scope is pending the usage evidence (`plans/2026-10-31-auto-tasks-audit.md`: multi-engine and the phone-command surface kept, 3 tasks proposed for removal) (me)
- [~] Phase 5 P5-G Code Graph section on the desktop (`ui/screens/graph/`, vendored graph-kit WASM layout in a worker, sigma/WebGL, LOD for 50k nodes; parity section 7 rows `~`, not verified in a real window; blocked-by: host CSP for WASM, kernel speed at 50k, 32 MB read cap, Swift-only graph generation; numbers in the phase 5 plan section 5) (me)
- [ ] Phase 6: one release with both apps, then Swift app to maintenance (wait)
- [ ] Phase 7: desktop and browser control via MCP with per-app grants, audit and kill switch; security-first design revised after independent review (rev 2), independent re-review next, 13 research spikes (P7.pre) before any code (`plans/2026-10-31-phase7-desktop-control-design.md`) (me)

## S3. Mobile (iPhone native, PWA)

**Complete means:** the iPhone is a **native chat client** with explorer and auto-task views, not a remote desktop; works with the Mac on today, and with the Mac off once the relay exists.
**Connection:** WebSocket `:3006` served by the Mac app, Bonjour `_llmide._tcp`, PIN pairing then a per-device token; wire types in `ios_app/SharedProtocol`; chat runs through the Mac's own chat engines (`chatHost`; only those reach `:3456`). Details: `docs/mobile/quick-start.md`, `verification.md`.

- [x] Native iOS app with Chat, Explorer chat, Auto Tasks, Loop, Files, Issues, Source Control, Usage, Self-Heal stores (`ios_app/MyApp/Services/*`) (me)
- [x] Pairing: PIN, then per-device token, PIN rotates; paired-device list with revoke (`docs/mobile/quick-start.md`) (me)
- [x] Bonjour discovery and manual / Tailscale IP entry (quick-start) (me)
- [x] Shared wire types and `make test-shared-protocol`; kit invariant 7 keeps it green (CLAUDE.md, kit plan) (me)
- [x] Phone capabilities, access switches, opt-in relay of tool/edit approvals to the phone (`b868756b`, `32eedf3e`, `224a9179`) (me)
- [x] Loopback pairing script `scripts/mobile/verify-native-pairing.swift` and `ios-ci.yml` (me)
- [~] Manual device verification list (`docs/mobile/verification.md`): written, no recorded run (you)
- [~] App Store readiness: `ios_app/APP_REVIEW_NOTES.md` exists; submission state unverified (you)
- [ ] Phone sees archived chats and notes only through the Mac; verify after live-then-archive Y2 run (you)
- [ ] Push notifications (approvals, task done) (me)
- [ ] Background / reconnect behaviour verified on device (unverified) (you)
- [ ] Phone works with the Mac off (needs relay, S4) (wait)
- [ ] Retire cleartext `:3006` + PIN link once the relay reaches parity (ADR 0018 "Supersedes") (wait)
- [x] Command bus spec written: one command/result contract for desktop, extension, iPhone (WS now, relay later) and PWA, tiers, catalogue, mobile audit (`plans/2026-10-31-command-bus-spec.md`) (me)
- [x] Command bus S1: `schema/bus/` (envelope, event, registry with the tier table as data, 33 command, 35 tier, 36 event fixtures, sequences) + `scripts/conformance-bus.mjs` in `make contract-gates`; Swift `Envelope.swift` and the Swift decode of the fixtures are left to S2/S4 (me)
- [~] Command bus S2: the Swift security fixes are done and tested (one tier table and gate for every wire type; Auto Task run honours the enable flag; template/config/toggle desktop-only; implement, review-merge and Self-Heal apply/discard need a desktop confirmation; phone explore never inherits Bypass; queued Loop starts re-validated at execution; dead `history`/`images` fields removed); the envelope mapper behind `mobile.commandBus` is not started (me)
- [x] Mobile docs corrected against the code (port fallback, tabs, chatHost, cleartext warning, capability table) and verification rows F1-F18 added; the 14 untested protocol files now have round-trip tests (me)
- [ ] Run the new `docs/mobile/verification.md` F-rows on a real iPhone and record the result (you)
- [~] Mobile TLS with SPKI pinning: design written (`plans/2026-10-31-mobile-tls-pinning-design.md`), not implemented; needs Q1-Q4 and an on-device Tailscale test (me)
- [~] Command bus S3: API 100 job API is built and tested (nine `/bus/*` routes, desktop approvals with a nonce, execution-time re-check, idempotency, gap-free SSE replay, cancel, quotas, `LLMIDE_BUS=off`, crash recovery, engine interface with claude/adapter/codex/gemini read-only); only `review` is available, the other five kinds answer `KIND_NOT_AVAILABLE` until Node owns their data (source registry, note extractor, Loop definitions, custom tasks, write engines) (`docs/spec/command-bus.md`) (me)
- [ ] Command bus S4: iOS client rewritten as renderer over the envelope, old path kept one release (me)
- [ ] Command bus S5: extension moves to the envelope (me)
- [ ] Command bus S6: relay transport + TLS pin on the direct path (wait)
- [~] sync-kit K0 map done (`docs/kits/sync-kit.md`, `845aa869`); K1-K4 not started (me)
- [ ] Phone PWA served by the relay (decided: Q-WEB-1 = A; built last in sync-kit) (wait)

## S4. Web app and relay

**Complete means:** undefined until Q-WEB-1 is answered. Under option A (recommended): an always-on relay with E2E-encrypted snapshots and an inbox, a PWA served by it, QR device enrollment, revocation by key rotation, no LLM calls and no code execution on the relay (ADR 0018 decisions 4-5, Tauri plan §8).
**Connection:** desktop encrypts and pushes snapshots, pulls inbox requests and re-checks them against its own permission rules; phone PWA and the extension read and queue.

- [x] Rule recorded: the web and external services are connectors / ingest only (`docs/kits/data-lifecycle.md` rule 3) (me)
- [x] Connector adapters for Box, git, issues, QA, SCIP, email, Slack with OAuth (`extension/connectors/`, CLAUDE.md) (me)
- [x] Reusable React web bundles run inside the Mac app (`mac/LocalPackages/graph-kit/web/`, OS view `b31133e0`); not a hosted web app (me)
- [x] Decided what the web app is: relay-served phone web view, built last in sync-kit (Q-WEB-1 = A; Q-WEB-3: phone through the Mac is enough for now) (you)
- [ ] Decide relay hosting: small VPS (Node) or Cloudflare Workers + R2; decide at the start of R2 (Q-WEB-2 = D6, the only open relay decision); the PWA host is a separate account either way (you)
- [ ] Independent external security review of the relay spec and R1, R3, R4 code: release gate G-EXT, required before any public exposure (D9) (you)
- [ ] Relay service: snapshot store, inbox, per-device tokens (no code exists; no `relay/` folder) (me)
- [x] End-to-end crypto design revised to every review finding (25 of 25 mapped in its traceability table): per-user keys with individual login, key hierarchy and capability sets, signed wrap, desktop-owned device registry, signed manifest, tiered clients (PWA read-only on a separate origin and account), fixed read-only ceiling, printed emergency-revoke code, no recovery in v1; user delegated D1 to D9 to the secure option, revisit if wrong (`docs/superpowers/plans/2026-10-31-relay-design.md`) (me)
- [x] Independent security review of the relay design: done with findings, 3 critical (PWA code trust, unauthenticated key wrap, relay-supplied device list), 7 high, 10 medium, 5 low; 9 decisions for you (`docs/superpowers/plans/2026-10-31-relay-security-review.md`) (me)
- [ ] Snapshot producer on the desktop and request consumer with permission re-check (me)
- [ ] Phone PWA (installable, offline read, queue) (me)
- [ ] Extension read/queue through the relay when the desktop is off (me)
- [ ] Relay contract added to `schema/http` with conformance tests (kit plan: contract group "relay (new)") (me)
- [~] Connector catalog: phase 1 verified shipped (catalog, per-user selection, `/auth/me/connectors*` routes, Library and selection-gated Settings, Miro MCP ingest, tests exist); open: gdrive/gcal MCP descriptors (`pipelineReady: false`), Miro tool names are unverified guesses; spec written (`docs/spec/connector-catalog.md`, `de7d1f38`); audit in `plans/2026-10-31-status-audit.md` (b) (me)

## S5. Chrome extension

**Complete means:** captures captions on supported platforms, side panel works as a live client of the Mac app, **stores nothing**, ships through the Chrome Web Store with a pinned origin.
**Connection:** content scripts read captions every 800 ms, the side panel sends them to the local server; reads and chat call the Mac app live; drafts exist only until copied (data-lifecycle R1).

- [x] Capture content scripts for Google Meet, Teams, Zoom web (`extension/manifest.json` host patterns; `extension/src/content/caption-scraper.ts`); other platforms unverified (me)
- [x] Side panel: notes, questions, transcript, plan, agent hooks (`extension/src/sidepanel/hooks/*`) (me)
- [x] Side-panel chat is a live Agent v2 client; `/chat` answers 410 (ROADMAP agent-kit P4; `extension/src/lib/agent-v2-client.ts`) (me)
- [x] Draft release hook so a capture draft is dropped once copied (`useDraftRelease.ts`, ROADMAP live-then-archive) (me)
- [x] CI workflow `extension-ci.yml`; 2611 files under `extension/tests` (me)
- [~] "Extension stores nothing": audited ([audit](plans/2026-10-31-extension-storage-audit.md)); speaker names and pinned participants no longer persisted (`755fd3df`); remaining: flag-off `no-ack` capture retention (up to 50) until the ack protocol is on by default (you)
- [~] "Mac app not running" state for the side panel: described in USER-CHECKLIST B7; not verified in a run (you)
- [ ] Pin the extension origin: CORS accepts every `chrome-extension://*` (ROADMAP Q22) (you)
- [ ] Manual real-meeting checklist (`extension/CLAUDE.md` Testing Checklist) before any caption/LLM merge (you)
- [ ] Chrome Web Store listing and review: no evidence in the repo (unverified) (you)
- [ ] `llmide://` launch from Chrome (Q11) (me)
- [x] Verify the Mac/server API the extension calls for reads is sufficient: every called path is served; capture hand-off is `/kb/live/*` append, finalize, status, ack ([audit](plans/2026-10-31-extension-storage-audit.md)) (me)
- [ ] Phase 7 browser-control tools with grants and audit (Tauri plan) (wait)

## S6. Shared server and core

**Complete means:** one versioned, contract-tested HTTP surface for every client; kits move from Swift into Node behind it without behaviour change; every removable feature stays removable.
**Connection:** Node 20+ pure HTTP on `127.0.0.1:3456`, SQLite WAL + FTS5, `SERVER_API_VERSION = 92` (`extension/server.mjs`).

- [x] Layering lint at zero violations; lazy engine load (CLAUDE.md) (me)
- [x] Route-group schemas, inventory, conformance runner, generated TS types, OpenAPI overlay, `make contract-gates` in `make regression` (Phase 1 plan P1-P16; `extension/src/lib/api-types.ts`, `schema/http`, `Makefile`) (me)
- [x] Feature matrix: every key off, `404 feature_disabled`, nightly workflow (`bb4342dc`, `79e8207d`) (me)
- [x] Server migrations append-only, up to `0054` (`extension/kb/migrations/`) (me)
- [x] Plugin/MCP/LLM-source routes moved to `routes/extension-routes.mjs` (`58ac81b8`) (me)
- [x] `POST /kb/complete` one-shot completion, API 88 (`ba65026b`) (me)
- [x] docs-kit routes `/kb/docs/*` with contract (`b8b52af8`) (me)
- [x] Test-hang protection: per-test timeout and suite watchdog; token-bench fake runs 120 s to 8 s (`83be5934`, `d51e4a61`, `4ece15b3`) (me)
- [x] This master plan and its status script (`93ccd529`) (me)
- [x] Contract gates cover catalog connect `enabled` and `copyKeyFrom` (fixtures, regenerated types, OpenAPI, inventory) (me)
- [~] Phase 1 P12 Swift decode check: `mac/Sources/APIContractLab` exists, 93 routed and 128 skipped of 221 fixture endpoints (70 no Mac caller, 51 Mac decodes through a private wrapper, 7 non-JSON); extensions routes now routed (`66bef1b9`); lab not run in the audit (`plans/2026-10-31-status-audit.md` (c)) (me)
- [~] P17 token baseline: `schema/bench/token-baseline.json` committed; both real baselines not run per the agent-kit plan T0.2 (you)
- [~] K1 per kit, in order (ui-kit done 2026-10-31): ui-kit, os-kit finish, docs-kit, graph-kit, knowledge-kit, agent-kit, work-kit, workspace-kit, capture-kit (kit plan) (me)
- [~] Core job runner: library done (`extension/kb/job-queue.mjs`, `job-runner.mjs`, `core/process-group.mjs`, migration 0055, spec `docs/spec/job-runner.md`, 10 tests in `extension/tests/job-runner.test.mjs`); not wired into boot or HTTP, no flake gate yet (me)
- [ ] automation-kit (Loop + Auto Tasks) logic into Node, the largest kit; the 13 Auto Tasks collapse to six job kinds (review, sources.update, issues.from_notes, issues.implement, loop.run, custom.run) behind a job API for the phone, scope pending `node scripts/auto-task-usage.mjs` output (`plans/2026-10-31-auto-tasks-audit.md`) (me)
- [x] K0 maps for work-, workspace-, capture-, automation-, sync-kit (`docs/kits/*.md`, `845aa869`; each lists numbered decisions for the user) (me)
- [x] K0 maps for ui-kit and os-kit (`docs/kits/ui-kit.md`, `docs/kits/os-kit.md`, `c8d7b8a5`; numbered decisions U1 to U6 and S1 to S6 for the user) (me)
- [x] Flaky tests under full-gate load hardened: `index-routes.http` 1 MB body (`e8f11cad`), `loop-contract-lab` probe timeout and Explorer watch tests (`87764821`); 10/10 under artificial load (me)
- [x] Desktop screen-test flake root-caused: explorer/shell/library/settings helpers bundled to a fixed shared outfile, so parallel test processes clobbered each other (`ExplorerController is not a constructor`, 23 fails in 1 of 10 runs); per-process `bundleDir()` (`f2205fa7`) + fixed-path guard test (`37d9e7dd`); 10/10 clean + 10/10 loaded (x2 concurrent) green (me)

## S7. Data and storage

**Complete means:** one stored copy per kind of data, live in the server DB then archived to Mac files, nothing deleted without a verified copy, every migration N-1 readable with a tested rollback.
**Connection:** [data-lifecycle](../kits/data-lifecycle.md); plans [agent-store](plans/2026-10-28-agent-store.md), [live-then-archive](plans/2026-10-29-live-then-archive.md).

- [x] `data.db`, `agent.db`, secrets moved to Application Support, keep-2 backups, moved-kb tripwire (ROADMAP Done; `data-location-and-rollback.md`) (me)
- [x] DB data in `<project>/system/`, notes in `llm-doc/` (ROADMAP Done) (me)
- [x] Agent store: runs, tool events, composition, rollups, retention (ROADMAP Done) (me)
- [x] Usage ledger shadow `usage_calls` with daily compare (ROADMAP Done) (me)
- [x] Note index rebuildable from files, chunked reconcile, shadow compare (live-then-archive Phases 0-2 per ROADMAP) (me)
- [x] `extension/scripts/backup.mjs` online backup (me)
- [~] Live-then-archive `lta.mode`: built and in shadow; on-by-default waits for Y2 (you)
- [ ] Ledger step B: budget readers to `usage_calls` after 7 days of zero mismatches, fail closed (X5) (you)
- [ ] Ended-chat continuation: per-chat summary on a cheap model plus last turns (X3, bench-gated) (me)
- [ ] 7-day shadow soak on real meeting notes, topK overlap, countDelta 0 (M2) (wait)
- [ ] Delete legacy duplicate rows, destructive: export-before-delete, backup, rollback drill (L1) (wait)
- [ ] Knowledge-kit K1: files stay the truth, server keeps a rebuildable index (L2; needs Q1-Q14) (you)
- [ ] Real-corpus checks: platform-less note count, hidden-note semantics, iCloud placeholders (ROADMAP Loose ends) (you)
- [ ] Two Macs on one account can flap note-index keys: detected, not prevented (ROADMAP Loose ends) (me)

## S8. Agents, providers, extensions

**Complete means:** the skeleton owns permission, budget, knowledge, workflow, observability and contract; the model and SDK do the rest; a new model or vendor is configuration.
**Connection:** `extension/llm_agent/`, `providers/`, `mcp/`, `plugins/`; Mac `Features/Chat`, `ClaudeLink`; plans [agent-kit K1](plans/2026-10-30-agent-kit-k1.md), [extensions catalog](plans/2026-10-31-extensions-catalog.md).

- [x] Provider catalog with Vercel AI SDK adapter, pinned fetch, per-user keys, security-reviewed (ROADMAP P6; `d7ce5367`) (me)
- [x] Session router: per-chat provider/model, billable token cap, handoff, learned limits (ROADMAP P6b) (me)
- [x] Non-token SDK adoption: retry, rate-limit, permission, refusal, thinking notices, MCP status, sandbox (ROADMAP P2) (me)
- [x] Token bench harness and fake-run plumbing (`scripts/token-bench.mjs`, `make token-bench-fake`; `c528c9cf`) (me)
- [x] Provider pinning for tracker-host connectors (`ff0960e9`, ROADMAP X7) (me)
- [x] DeepSeek: a tool mode with tools off degrades to plain chat with a notice; current model ids tool-capable (`27a641a6`) (me)
- [x] Extensions catalog P0-P3: baseline `a3897732`, item model + importer + shadow active set `c25e1c46`, consumers behind `LLMIDE_EXT_ACTIVE_SET` `ebf20127`, MCP on provider-adapter turns behind `LLMIDE_EXT_ADAPTER` `c0b3067c`, spec `4045f2af` (me)
- [x] Extensions MCP review findings fixed: `853f130b`, `9d792d1b`, `9b96282a` (me)
- [~] Retire `llm_agent/runtime/` (P7): 2 commits local, finishing gates (`844b1213`, `ece843c6`) (me)
- [x] Extensions catalog P4: GitHub install at a pinned commit, per-user, default off, warn-only scan, routes (API 93) (me)
- [x] Extensions catalog P4b: installed items load into turns (skills, plugins, MCP; consent, ask-first), default install allowlist (me)
- [x] Extensions catalog P5 server half: updates with diff, per-commit re-consent, one-version rollback and repair `f45111d6`; index adapters, cache and search, active and updates views (API 94) `464c94be` (me)
- [x] Extensions catalog P6 Mac screen: installed/browse/install, consent sheet, update preview, rollback, repair; models decode-checked by api-gates (plan 2026-10-31 16a) (me)
- [ ] Extensions catalog P6 real-app check of the Extensions screen (you)
- [x] Extensions catalog per-user allowlist (server): GET/PUT `/auth/me/extensions/allowlist`, operator ceiling, API 95 (me)
- [x] Extensions catalog allowlist Settings card (Mac, sources/ceiling/effective/ignored, plain error sentences) (me)
- [ ] Extensions catalog rollout (P9) and a real-app check of the Mac screen and cards (plan 2026-10-31) (me)
- [ ] Y1 bench go-ahead and runs: baselines, noise check, A/B per switch (USER-CHECKLIST A) (you)
- [ ] Lean SDK configuration L1-L12 (compact prompt, drop Bash in execute, cache TTL, compaction, tool search); each bench-gated (X1) (me)
- [ ] Token-affecting SDK adoption: `sessionStore`, Haiku search sub-agent, `Task*`, `skills`, `options.agent`, `resumeSessionAt` (X2) (me)
- [ ] Plugin sub-agent tools unavailable until X2 (ROADMAP Loose ends) (me)
- [ ] Router polish: switch history in Agents hub, shadow metrics on Storage page (X6; graph-kit pin bump) (me)
- [ ] Bench: run Y1 baselines and A/B pairs once the user gives the go-ahead (me, with you)
- [ ] Second-model bench so a model upgrade is a measured setting change (kit plan principle) (you)
- [ ] SDK upgrade-and-tune loop on each release via `extension/scripts/sdk-surface.mjs` (ongoing) (me)

## S9. Security

**Complete means:** loopback-only core, secrets in the vault/keychain, every external call pinned and guarded, relay sees no plaintext, builds and updates signed on every OS.
**Connection:** Tauri plan §8, ADR 0004 (loopback), CLAUDE.md "Server" invariants.

- [x] Server binds `127.0.0.1`; remote bind needs `LLMIDE_ALLOW_REMOTE=1` (CLAUDE.md invariants) (me)
- [x] CORS allowlist, 8 MB body cap, 500k-char prompt cap, JWT + rate limit (CLAUDE.md) (me)
- [x] Guardrail scanners for secrets, PII, destructive ops (`extension/guardrails/`) (me)
- [x] Claude-style permissions: Ask / Accept Edits / Bypass with prefix rules (project notes, PR #65; unverified in this audit) (me)
- [x] Phase 0 staging script excludes secrets, keys, DBs (report "Packaging") (me)
- [~] Provider and connector fetch pinning: pinned for providers, adapter MCP, extension install, tracker hosts, Box content downloads (host allowlist, manual redirects, token dropped cross-origin, size caps) and MCP connector OAuth discovery/token calls; **not** pinned: Jev connection check, 7 literal-host calls, subprocess egress (`plans/2026-10-31-status-audit.md` (e)); independent review welcome (ROADMAP X7) (me)
- [ ] Pin extension origin instead of `chrome-extension://*` (Q22) (you)
- [x] Tauri capability manifest and path scoping (see S2; `desktop/src-tauri/capabilities/`, `graph_file.rs`) (me)
- [~] Relay: E2E design revised to the independent review (threats T1 to T23, negative-test list, gate G-EXT before public exposure; `plans/2026-10-31-relay-design.md`); build items open: spec R0, crypto vectors R1, key rotation, emergency revoke and no-plaintext tests in R2 to R4 (me)
- [x] Workspace Trust server: per-user trust records, untrusted folders' `.mcp.json` stdio servers are not loaded and project hooks/plugins/skill scripts are named in a notice, `LLMIDE_WORKSPACE_TRUST=off` kill switch, API 95 (Tauri plan §8) (me)
- [x] Workspace Trust Mac UI: chat banner with confirmed Trust this folder, Settings folder list with enforced state (me)
- [ ] Real-app check of the Workspace Trust banner and Settings cards (me)
- [x] Independent security review fixes (server): workspace trust fails closed (strict MCP for every untrusted folder, parents, remote servers, stricter trust roots), raw commits verified on the repo (`COMMIT_NOT_IN_REPO`), apply bound to the preview (`UPDATE_CHANGED`), server-owned shared index refresh, uninstall/repair/apply locking, job runner and process-group hardening, lazy integrity check at load (me)
- [x] Independent review fixes (desktop chat approvals): held key and double click cannot approve queued requests unseen (repeat ignored, 500 ms dwell, no shortcuts while typing), bounded private-key redaction with visible counters and exact secret keys, saved rules only for a positive read-only allowlist, advisory-only risk classifier with normalisation, edits need one textual in-root path, batch lists and binds every member, rules scoped to the turn's root, hidden-character set widened; 54 new tests in `ui/screens/chat/tests/approvals-hardening.test.mjs`; real-window check open (me)
- [ ] Signed builds and signed updates on every platform; plugins hash-pinned (S10) (me)
- [ ] One company API key with per-user caps replaces any shared personal subscription (ADR 0018 decision 5) (you)
- [ ] Phase 7 desktop-control grants, "agent is driving" indicator, kill switch, audit log; security-first design revised after independent review (rev 2), independent re-review next, 13 research spikes (P7.pre) before any code (`plans/2026-10-31-phase7-desktop-control-design.md`) (me)

## S10. Release and CI

**Complete means:** one reproducible release per OS with signed artifacts, an update channel, and CI that runs every gate.
**Connection:** `mac/Scripts/{release,sign,notarize,appcast}.sh`, `.github/workflows/*`, `docs/how-to/release*.md`.

- [x] Mac release, sign, notarize, Sparkle appcast scripts and `mac-release.yml` (`mac/Scripts/`, `docs/how-to/release-with-auto-update.md`) (me)
- [x] CI workflows: mac, extension, ios, contract, docs, codeql, skills-drift, feature-matrix, release (`.github/workflows/`) (me)
- [x] Pre-push gate runs the same lint CI does (`a0dd8473`) (me)
- [x] `make test-desktop` (node, security, token drift, cargo if present); node part is in `make regression` (`Makefile`) (me)
- [x] `make regression` aggregates graph-kit pin, feature, contract, Mac, chat/loop/api gates (`Makefile`) (me)
- [~] Mac Sparkle `CFBundleVersion` limitation: one build-number source for local and CI (`mac/Scripts/build-number.sh` = commit count; `LLMIDE_BUILD_NUMBER` only raises it, below the count or a shallow clone fails; CI `fetch-depth: 0`; `extension/tests/scripts-build-number.test.mjs`); open: no real signed-build-to-build Sparkle update run (`plans/2026-10-31-status-audit.md` (a)) (me)
- [x] Night-push job built (`746b94f9`) (me)
- [ ] Install the nightly push job: commands in `scripts/nightly-push.sh --help` (you)
- [ ] CI result checked after every push (`gh run list`) (you)
- [~] Tauri release workflow: unsigned manual draft `desktop-release.yml` (macOS dmg, Windows NSIS, Linux deb/AppImage); never run on a runner, no signing (me)
- [ ] Windows code signing and Linux packaging (deb/AppImage) decision; options and recommendation in `docs/how-to/desktop-signing-decisions.md` (you)
- [ ] Auto-update for Tauri, signed (me)
- [ ] Relay deployment pipeline and monitoring (blocked on S4 hosting) (wait)
- [ ] Chrome Web Store publishing step in the extension release (you)
- [x] Release notes / CHANGELOG discipline per surface (October summary by surface in `CHANGELOG.md`, `docs/how-to/maintain-the-changelog.md`) (me)

## Cross-cutting rules

- **Quality over speed.** A phase ships only when its exit gate, its independent review (Sonnet reviews data-, money- and security-touching code, Fable for each kit's final review) and the full pre-push gate are green.
- **Night push.** Agents commit on `main` (no branches) and do not push; a nightly job pushes. Ask before pushing `main` by hand.
- **Bench-gated token changes.** Every token-affecting change ships OFF by default; paid or subscription bench runs happen after the end-to-end build (user decision 2026-10-30). Keep a change only if it beats noise and stays inside +15% tokens, +30% time, +20% hops.
- **No data deletion without a verified copy.** Archive, verify, then delete; real-data checks and an old-format fixture (N-1 readable, rollback tested) before any destructive switch.
- **Kit invariants** at every kit step: sealed Mac boundaries, removable features, server layering at zero, additive contract (version bump on wire change), current app keeps working, no token or latency regression, phone keeps working through the Mac until sync-kit lands.
- Markdownlint before every push; never `--no-verify`.

## How to keep this current

1. **Every phase that ships ticks its boxes and updates this page in the same commit.** Change `[ ]` to `[~]` or `[x]`, cite the commit or doc in the item, and add new items when scope appears (never delete an unfinished item; mark it done or move the decision to the open questions).
2. Run `node scripts/plan-status.mjs --fix` to refresh the dashboard numbers, edit the one-line State if it changed, then `node scripts/plan-status.mjs --check` (also covered by `extension/tests/plan-status.test.mjs`, so `npm test` fails on drift).
3. Read the status any time with `node scripts/plan-status.mjs` (table) or `--json`.
4. When something is `unverified`, verifying it is itself a task: turn the doubt into a run, then tick the box.
5. Keep [ROADMAP](ROADMAP.md) as the dated narrative and [USER-CHECKLIST](USER-CHECKLIST.md) as the hands-on list; this page is the all-surface index over both.
