# Testing Checklist

Before merging caption/transcript/LLM changes, run through this against a real meeting:

## Caption Fidelity
- [ ] Short Japanese captions (`はい。`) appear
- [ ] Long multi-sentence captions appear as ONE line
- [ ] Same speaker continuous updates stay on one line
- [ ] Different speakers produce different lines with real names
- [ ] Combined-speaker labels stripped to just speaker
- [ ] UI text does NOT appear (toolbar, clocks, meeting ID, effects)
- [ ] Works when extension loaded AFTER Meet tab opened
- [ ] Works on Teams and Zoom web

## Capture drafts and local storage (live-then-archive T5.2)

The extension stores nothing of its own except an unfinished capture draft (`transcriptDraft:<id>` + `draftStage:<id>`), kept only until the server reports the capture acked by an archivist. **Archivist:** the desktop host (`desktop/src-tauri/src/capture_archivist.rs`) adopts `GET /kb/live/unacked` of the core it spawned (which runs with `LLMIDE_LIVE_ACK=1`), writes and verifies the note, then acks `POST /kb/live/:id/ack`. The desktop spawns its core on `:3456` first (falling back to 3457-3459 when another program holds it), so the extension can reach it. If another program holds `:3456`, the desktop status bar says "Chrome extension cannot connect: another program uses port 3456" (else "Chrome extension can connect"), and captures wait until that port is free.

**Signing the extension in to the desktop core (once).** The accounts are the desktop core's own local accounts (its DB in the desktop data dir, `llm-ide-desktop/core/data.db`), the same ones the desktop app signs in with.
- Registration on the spawned core is OPEN: the host passes no `NODE_ENV`, `LLMIDE_DISABLE_REGISTRATION` or `LLMIDE_ALLOW_REMOTE` (`core_env.rs` drops every other `LLMIDE_*`), and the core binds `127.0.0.1` only, so only this computer can register.
- What the user does: with the desktop app running and signed in, open the extension side panel; the login view (`LoginView.tsx`, `POST /auth/login`) asks for an email and password. Enter the SAME email and password as the desktop app and press "Sign in". Do not "Create account" a second user: the archivist reads `GET /kb/live/unacked` for the account the desktop app is signed in with, so another account's captures are held (up to 7 days) and never become notes.
- After that the extension keeps the refresh token in `chrome.storage.local` (`auth.refreshToken`) and the access token in memory, and re-mints it silently (`POST /auth/refresh`); it asks again only after a sign-out or when the refresh token is no longer accepted.
- CORS: before each spawn the host writes `{"ids":["ecojclccfoegmlffpiahbcenmkfhadlk"]}` (0600, atomic) to `extension-ids.json` in the core's data dir (`core_env::pin_extension_ids`), so that core echoes CORS only for this extension's ID (pinned by the manifest `key`), never any other `chrome-extension://` origin (`tests/extension-origins-core.test.mjs`).
- [ ] Only the desktop running (no other server on `:3456`): the side panel connects (status bar "Chrome extension can connect"), sign in with the desktop account, record 1+ min and Stop: within about 20 s the capture is archived as a note in the desktop Library and the draft is released
- [ ] Record 1+ min, Stop with the desktop app running: the draft is gone from `chrome.storage.local` only after the note exists (status `acked`); before that it is still there
- [ ] Stop with the desktop app/server CLOSED: the draft stays, the banner says "Desktop app not running"; open the app, the capture is re-sent, the desktop app writes the note, the draft disappears
- [ ] Close the panel mid-recording, reopen after 2+ min: the transcript is restored in the live view, re-sent and released after the ack
- [ ] Restart the server between Stop and the archivist ack: the draft is kept ("not confirmed copied" + Resend button), never deleted on an unknown status
- [ ] Server WITHOUT `LLMIDE_LIVE_ACK`: the draft is kept and listed with Export and Delete; with 50 kept, Stop refuses to finalize (error shown, capture stays) until you delete or export one. Nothing is ever dropped automatically
- [ ] Record past 2000 lines: the capture is never released; it is listed with Export and Delete
- [ ] Rename a speaker, set a language, Stop: the desktop note carries the display names, the language, the real start time and duration (not the Stop time)
- [ ] Fill storage (or block it in devtools) and Stop: a persistent red error appears, the capture is still sent, and the draft appears once space is back
- [ ] Two panels open: only the recording panel finalizes its capture; the other re-sends it only after the draft is 2 minutes stale
- [ ] No `transcripts` or `chatMessages` key is written (`chrome.storage.local.get(null)` in the panel console)
- [ ] Settings -> "Meetings saved in this browser (old)": lists old saved meetings read-only; nothing is sent until "Copy to the desktop app"; a copy is removed locally only after the desktop app confirms; pressing twice sends once; closing the panel mid-copy and pressing again resumes
- [ ] Chat with the desktop app closed: "Desktop app not running", nothing is persisted; reopen the app, the banner clears by itself
- [ ] Upgrading from a build that kept `chatMessages`: a non-empty old buffer is NOT deleted; the chat tab offers Export, and only that (or an empty buffer after the server answered) removes it

## LLM Output
- [ ] Primary language change → Notes/chat respond in that language
- [ ] Questions H2 headings localized (対立/要確認/要説明)
- [ ] DOCX export produces correct font (MS Gothic for JA)
- [ ] Stale server shows yellow "restart" banner

## Security
- [ ] `GET http://evil.example/` does NOT reach server (CORS)
- [ ] Setting `serverUrl` to evil URL rejected by `isSafeServerUrl()`
- [ ] Meeting with `<<<END>>>` spoken does not break AI output

## Feature pruning

The server honours `LLMIDE_FEATURES`, the comma-separated list of ENABLED feature keys the desktop host passes from its feature prefs (unset or empty = every feature). `core/config.mjs#parseFeatures` reads it once into `config.features`.

- **Feature-owned routes** live in `routes/feature-routes.mjs` (`FEATURE_ROUTE_GROUPS`): `auto_tasks` → `/kb/loop/*`, `gantt_issues` → `/kb/issue-schedule`, `code_graph_3d` → `/kb/ingest-code-graph`, `doc_gen` → `/generate-doc` (exact match; `/generate-docx` is not in the group). A disabled group's module is never imported, and its paths answer `404 {"error":"feature_disabled","feature":"<key>"}`.
- **Prune only single-owner routes** — a group may move into the table only when every caller (grep `src/`, `ui/screens/` and `web/src/`) belongs to that feature. `/generate-docx` stays always-on because the Chrome extension's ExportMenu calls it.
- **Never import a feature route module statically** from `routes/router.mjs` or `server.mjs`; dispatch through `featureHandlers.<key>?.(…)` at the route's position.
- **The outcome poller stays unconditional** — `/kb/dispatch` and review approvals (always-on) are what write the dispatched tasks it polls.
- Tests: `tests/feature-config.test.mjs`, `tests/feature-routes.test.mjs`, `tests/server-features-health.test.mjs` (spawns `server.mjs`; needs local listen).

### Lazy engine

The Claude Agent SDK and the v2 chat engine (`llm_agent/sdk/engine.mjs`) are never on the boot path — nothing `server.mjs` imports statically (router, `server/*-routes.mjs`, the `auto_tasks` Loop route) loads them.

- **Chat**: `routes/agent-v2.mjs` imports the engine on the first turn through `loadAgentEngine()` (memoised; a rejected import is forgotten so the next turn retries, and the failure reaches the client as the usual terminal `ENGINE_ERROR` event).
- **Prewarm**: right after `server_started`, `server.mjs` calls `prewarmAgentEngine()` on `setImmediate` and logs `engine_prewarmed {ms}` or `engine_prewarm_failed`. `LLMIDE_ENGINE_PREWARM=0` (`config.enginePrewarm`) skips it — set it when measuring boot cost or module counts.
- **Also lazy**: the SDK in `llm_agent/sdk/models.mjs` (first model listing), `spike-engine.mjs` in `server/ai-routes.mjs`, and `llm_agent/sdk/loop-agent.mjs` in `routes/loop-agent.mjs` (first Loop run).
- **Turn concurrency**: at most `LLMIDE_MAX_TURNS` (`config.maxConcurrentTurns`, default 8, clamped 1-64) chat turns run at once, process-wide, through one `core/semaphore.mjs` gate in `runV2Turn` — HTTP streams and Host API turns alike (the providers CLI has its own 6-slot gate). A turn that cannot get a slot within 30 s answers `429 { error: { code: 'BUSY' } }` before the engine starts and writes no usage row. `LLMIDE_MAX_TURNS=1` serialises every turn.
- **Constants a route needs** come from `llm_agent/sdk/constants.mjs` (`AGENT_SDK_PROVIDER`, `RESERVED_MCP_NAME`; no imports), and the auth ladder + engine home from `llm_agent/sdk/auth.mjs` (no SDK). `engine.mjs` re-exports all of them. Never import `engine.mjs` or the SDK statically from a module on the boot path — add the value to one of those two files instead.
- Test: `tests/lazy-engine.test.mjs` (module-load hook over the boot path; also spawns `server.mjs`, so it needs local listen).

## Team Hub YAML assignments (ADR 0021 H1.1)

- **Boot guard**: hub mode (`LLMIDE_HUB=1`) on a non-loopback bind refuses to start unless `LLMIDE_TLS_TERMINATED=1`: the operator declares that a TLS terminator (nginx, Caddy) is the only thing in front of the core (`hub_requires_tls`, exit 1). A loopback hub (local dev, tests) needs no declaration.
- **File**: `<LLMIDE_DATA_DIR>/team.yaml` (desktop: `~/Library/Application Support/llm-ide-desktop/core/team.yaml`; repo-kb layout: beside `data.db`). The core reads it **once per boot**, after migrations and before any request is handled, and never watches it or reads it on a request path. Restart the core to apply an edit made by hand.
- **Write-through**: because the file is authoritative at every boot, `PATCH /admin/members` and an invited registration rewrite it **after** their DB transaction (same atomic 0600 generation path), so a grant made in Settings → Team or through an invite survives the next restart. A failed write answers 500 and rolls the grant / registration back, so a completed request never leaves the DB and the file disagreeing. The DB wins for an account it lists; entries for emails with no account and the file's full-line comments are preserved (an edit made while the core runs is replaced by the next API grant change).
- **Shape**: `members:` then one lower-cased `email:` mapping per account with exactly three keys:
  - `role`: `owner | admin | member | viewer`
  - `max_mode`: `none | read_only | execute`
  - `usd_cap_month`: `0` = no cap, maximum `100000`
  Two-space indentation, `#` comments allowed, no anchors/aliases/sequences/flow maps. Unknown keys, duplicate emails or fields, tabs and malformed values fail the boot.
- **The file holds user assignments only.** Role permissions stay in code (`requireRole`, the turn clamp, the Host API gateway filter); this module only writes `members` at boot.
- **Undefined is least privilege**: an account not in the file (or a user with no `members` row) becomes `viewer`, `read_only`, 20 USD/month. A user without a `members` row gets that row created.
- **Generation is deferred on a fresh install**: while only the synthetic `legacy` user exists, no file is written (an empty file would become authoritative at the next boot and demote the first registered owner). The first boot that sees real accounts generates it from their `members` rows (an existing solo owner stays owner; other accounts are listed with their current role/grants), then applies it. A **boot** never rewrites an existing file (an API grant change does, through the write-through above).
- **Unknown email** in the file: ignored, never creates a user, logged and audited as `team.yaml.unknown_email`.
- **Fail closed**: invalid YAML, an unknown role/mode or an invalid cap (or an unreadable/unwritable file) logs `team_yaml_invalid` with the line and **exits 1**; no partial grant change is written. The same applies when applying the file would leave **zero owners** while real accounts exist (`reason: 'no_owner'` — an owner email typo, an owner listed with another role, or an empty `members:`), because the API's LAST_OWNER guard only protects its own path. An install with no real accounts yet (fresh DB) is exempt (and defers generation): the first registration creates the owner and the next boot writes them into the file.
- **Downgrade warnings**: every boot-time narrowing (role, max_mode, or a tighter USD cap — e.g. an admin-UI grant or invited member the file does not repeat) logs one `team_yaml_downgrade` warning with the email and from/to grants, so an operator sees what the authoritative file reset.
- **Known limit — concurrent chats can overshoot the USD cap**: the monthly cap is checked at turn start and the in-flight lock is per chat, not per user, so N chats of one member can each pass the check and overshoot by up to (N−1) × the remaining budget. A per-user in-flight reservation would close it; until then this is the documented (not hidden) bound.
- **Audit**: each real boot change is one `team.yaml.apply` row with `requestId`/`userAgent` = `team.yaml`, `detail.actor` = `team.yaml`, and `from`/`to` grants only (never file text or message content). Generation is `team.yaml.generate`; invalid files are `team.yaml.invalid`; unknown emails are `team.yaml.unknown_email`; an API write-through is `team.yaml.write` (`detail.trigger` = `admin.patch` or `auth.register.invite`, never file text).
- Code: `kb/team-yaml.mjs` (strict parser/serializer + one apply), `server/team-boot.mjs` (safeAudit adapter), tests `tests/team-yaml.test.mjs` and `tests/team-yaml-boot.test.mjs`.

## Agent/tool route authority (R-014#1)

- **Every route has exactly one action class; undeclared routes are refused (plan H1.2).** `server/route-authority.mjs` `ROUTE_POLICY` gives every method + path one class from `kb/members.mjs` `CLASS_GRANTS`; `server.mjs` calls `enforceRouteAuthority` after authentication and rate limiting (auth/extension dispatch are checked at their own point; a disabled feature still answers 404 `feature_disabled`). An authenticated request that matches no rule answers `404 NOT_FOUND` and logs `route_policy_unlisted`. A refusal is `403 ROLE_DENIED` / `429 USD_CAP` and writes one `team.deny` audit row with `{ reason }` only.
- **Roles (user decision 2026-11-08): owners, admins and engineers (role `member`) do all work; viewers only Ask.** Class `install` = member + execute (plugins, MCP servers, hook trust, workspace trust, extension installs, the skills kit, SDK update); `admin` = team/install management only (`/admin/*`, `/metrics`); `model.ask` = viewer + read_only + cap, the chat turn forced to `ask` in `runV2Turn` (HTTP and Host API alike); `model.read`/`model.exec`/`fs.*`/`external.*` = member. `authorizeAction` reads the `members` row on every call (never the JWT claim) and applies `max_mode` + the monthly USD cap.
- **Adding a route: add its method + path to `ROUTE_POLICY` under one class (see the class table in ADR 0021), or it will 404.**
- **Gated elsewhere (do not duplicate):** `/host-api/*` (gateway `COMMAND_CLASS` per frame + grant filter), `/admin/*` + extension admin routes (`requireRole`), `/kb/self-heal/runs` (debug only, bus host proof + exact repo allow-list), the command bus (`KIND_CLASS` + tier/client class + host proof), the meeting agent (`tickRun` authority) and the outcome poller (`usersAllowedToPoll`).
- Tests: `tests/route-policy-coverage.test.mjs` (every served route has one rule, no dead rules), `tests/route-policy-e2e.test.mjs` (real server: viewer/read-only/engineer), `tests/route-authority.test.mjs`, `tests/action-classes.test.mjs` (class matrix), `tests/host-api-gateway.test.mjs`, `tests/command-bus.test.mjs`, `tests/meeting-agent.test.mjs`, `tests/outcome-watcher-refresh.test.mjs`.

## Host API v1 (desktop)

- **Mode** (`config.hostApiMode`): `tls` when `LLMIDE_HOST_API_TLS=1` (release builds too), else `dev` when `LLMIDE_HOST_API_DEV=1` (never with `NODE_ENV=production`; the Tauri host passes it only in a debug build), else `off`. Any mode but `off` starts the listener and enables `/host-api/pin|devices` (else `404 HOST_API_DISABLED`; those routes also need the bus host proof). The PIN answer carries the certificate `fingerprint` and `addresses` (this computer's IPv4s for the Settings pairing QR, Tailscale first, then LAN, then container/VM bridges; `pairingAddresses` in `routes/host-api/http-routes.mjs`) in `tls` mode; `null` and `[]` in `dev`.
- **Listener**: `server/host-api-listener.mjs` on 3016 (next free port up to 10), serving `/host-api/v1` only. `tls`: pinned WSS on `0.0.0.0` with the identity from `server/host-identity.mjs` (`host.hello` carries `certificateFingerprint`). `dev`: plaintext on `127.0.0.1`, non-loopback peers refused. Both refuse an `Origin` not in `LLMIDE_HOST_API_WEB_ORIGINS` (`core/host-api-origins.mjs`: exact loopback http with a port, or exact https DNS origin; pinned by `schema/host-api/v1/fixtures/security/origins.json`).
- **Env**: `LLMIDE_HOST_API_TLS=1` binds `0.0.0.0:3016+`, TLS only (off by default; turning it on by default is a product-stage decision). `LLMIDE_HOST_API_WEB_ORIGINS` lists exact origins (loopback `http` with a port, or `https://<domain>`, the latter honoured only in `tls` mode). `LLMIDE_HOST_API_READ=1` serves the `read` capability (`chat.sessions`, `chat.history`, `usage.get`; default off, `routes/host-api/reads.mjs`): every read is the session user's own (`listChatSessions` / `getChatSession` / `usageSummary`), re-redacted and clamped on the way out, with no meta, system lines or limit configuration. A device paired before the switch was on must re-pair to get it. The Tauri app passes only `LLMIDE_HOST_API_TLS` and `LLMIDE_HOST_API_WEB_ORIGINS` to a core it starts (`desktop/src-tauri/src/core_env.rs` drops every other `LLMIDE_*`), so `read` works only on a core you start yourself (`cd extension && LLMIDE_HOST_API_READ=1 npm run server`), which the app then adopts; it fails closed otherwise. `LLMIDE_HOST_API_COMPOSE=1` serves `compose` (default off, `routes/host-api/compose.mjs`): `chat.options` lists the read-only modes (`auto` = `auto_read_only`, `ask`, `plan`, `assist_plan`, `review`, `document`; never `execute` or a permission mode) and the account's Claude models (`listSdkModels`, in process); `chat.send` may carry `mode` / `model` only on a session granted `compose`, the model re-checked against that list; `chat.new` points the user's phone chat at a fresh session. Never granted to a relay-bridged session. Same re-pair and Tauri `core_env.rs` rules as `read`.
- **Identity**: the self-signed certificate and key live in the `host_api_identity` table (migration 0062), encrypted by the vault. A vault-key change resets the identity and wipes v1 devices (`server/host-identity.mjs`); any other read error propagates and changes nothing. Tokens carry the scopes granted at pairing (served ∩ granted; legacy tokens never get `tool_approvals`).
- **Audit and limits** (`routes/host-api/audit.mjs`, `rate.mjs`): `audit_log` rows with action `host_api.<event>`: `pair_failed`, `pair_ok`, `token_failed`, `pair_throttled`, `token_throttled`, `revoke_self`, `revoke_host`, `scope_denied`, `role_denied`, `rate_closed`, `identity_created`, `identity_reset`, `origin_refused`, `plaintext_refused`, `chat_options`, `chat_new`, `compose_send`, and `<event>_suppressed` summaries. Rows are de-duplicated per 60 s (refusals per peer, IPv6 by /64) and capped at `AUDIT_EVENT_CAP_PER_MINUTE = 60` per event type. Per session: 40-frame bucket at 10/s, 6-turn bucket at 0.1/s, 20-read bucket at 2/s (per device), close after 100 refusals; at most 2 unauthenticated sessions per peer with a 10 s auth deadline; PIN and token throttles are separate; a 4 MiB write cap closes with 1013; 32 connections and a 10 s handshake deadline. No secret or frame content is ever written.
- **No HTTP inside**: the gateway (`routes/host-api/gateway.mjs`) runs turns in process through `startHostTurn` / `cancelChatTurn` / `clearChatSessionState` from `routes/agent-v2.mjs`, never over HTTP, and never reads UI state.
- **Phone chat**: one server-side chat per user (`host_api_quick_chat`), run in mode `auto_read_only` (or a read-only mode a `compose` client picked; `startHostTurn` clamps again) in the extension chat workspace, not the open project. `chat.new` replaces it with a fresh one; other chats are read-only from a client. Attachments arrive as `{ name, text }` and run as engine files `{ path, content }` (text only, the core's 80,000 / 200,000-character caps).
- **Ordering**: frames of one session are processed in order (one at a time per session).

## Sync (desktop producer)

- **What**: encrypted snapshots (chats, meetings, plans, usage) and a queued-prompt inbox in a user-owned folder, for the phone and web with the desktop off. Design `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md`, ADR 0020.
- **Where**: envelope `core/sync-envelope.mjs` (relay v1 bytes + `snapshot`/`manifest`/`syncwrap`; vectors `schema/sync/v1`, check `node scripts/sync-vectors.mjs`); stores `connectors/sync-store/` (memory for tests; MEGA via `megajs` 1.3.10, the first adapter by user decision; own-server SFTP via `ssh2` 1.17.0 with a pinned ed25519 host key; Box is a later sub-project); state `kb/sync-state.mjs` (migration 0064); producer/consumer/scheduler/routes `routes/sync/`.
- **Vault**: `sync.rootKey`, `sync.signingKey`, `sync.megaEmail`, `sync.megaPassword`, `sync.prevRootKey` (24 h, for `stale_epoch`) are server-internal — never client-settable, listed or returned.
- **Enrollment** (SP2): `core/sync-enroll.mjs` (QR payload, claim, signed ack, SAS; vectors `enroll` in `schema/sync/v1`) and `routes/sync/enroll.mjs` (one pending enrollment per user, in memory; `es` is never stored or logged; the claim is pinned once and never re-fetched; the tier is the desktop's choice). Device contract: `schema/sync/v1/README.md` "Enrollment"; Node reference device `tests/helpers/sync-device.mjs` (on the independent `tests/helpers/sync-reference.mjs`, never `core/sync-*`); malicious-storage suite `tests/sync-enroll-malicious.test.mjs`.
- **Registry**: `sync_devices` is the only registry. Revoke = `removeTree(d/<dir>)`, row delete, rotation (`routes/sync/registry.mjs`, `rotateNow` in the scheduler). A registered device with `wrapEpoch > 0` whose folder lost `key.bin` is dropped, rotated and noted (`sync_device_removed`) at the next publish; puts never recreate a deleted folder.
- **Own server (SFTP)**: `POST /kb/sync/sftp` validates the host, port, user, pinned `SHA256:` fingerprint and HTTPS `webHost`, then generates one ed25519 key into `sync.sshKey` and never returns the private key. `storeFor` builds the SFTP store; `SYNC_HOST_KEY_CHANGED` turns sync off. Switching storage kind unlinks every device. Tests use `tests/helpers/fake-sftp.mjs`; the live run is opt-in (`LLMIDE_SYNC_SFTP_IT`).
- **MEGA**: a dedicated account only; 2FA off on that account (`SYNC_MFA_REQUIRED` otherwise); one session per user cached in `routes/sync/scheduler.mjs` while the core runs, logged out on shutdown, setup change or sync off; a refused login turns sync off instead of retrying. Tests use `tests/helpers/fake-mega.mjs`; the live run is opt-in (`LLMIDE_SYNC_MEGA_IT=1`).
- **Ceiling**: queued requests are `chat.send` only and run only through `startHostTurn` (`auto_read_only`, phone chat); an approval request cancels the turn and replies `needs_approval`; record-before-execute in `sync_requests`.
- **Off switch**: `LLMIDE_SYNC=off` starts no scheduler; per user, Settings "Sync on" (`sync_state.enabled`).
- **Never** log keys, folder names, the SSH private key, the MEGA email or password, or decrypted content.

## Self-Heal (debug desktop builds)

- **Switch**:
  - `config.selfHeal` = `LLMIDE_SELF_HEAL=1` and not production. The Tauri host passes it only in a debug build (`desktop/src-tauri/src/self_heal.rs` `enabled()`; opt out with `LLMIDE_SELF_HEAL=0` in the host's env).
  - Off: `/kb/self-heal/*` answers `404 {"error":"feature_disabled","feature":"self_heal"}`, `routes/self-heal.mjs` is never imported, and `/health` does not list the paths.
  - It is not a `FEATURE_ROUTE_GROUPS` entry, because an unset `LLMIDE_FEATURES` means all on.
- **Capture (plan A)**:
  - The host turns the spawned core's stderr and panic records into reports.
  - The webview's pump (`ui/screens/shell/self-heal.ts`, `self_heal_take` every 15 s) adds Chat and Loop failures and posts them to `POST /kb/self-heal/incidents`.
  - `kb/incidents.mjs` stores them in `self_heal_incidents` (migration 0067) after `core/incident.mjs` redacted and signed them.
- **Fix loop (plan B, manual only)**: Settings → Self-Heal → Try to fix (`ui/screens/settings/self-heal-run.ts`).
  1. `POST /kb/self-heal/runs` (one run per user, 4 h in-memory lease) triages up to 5 `new` incidents and returns `.self-heal/BATCH.md` (`core/self-heal-batch.mjs`).
  2. The host adds a worktree of the source checkout under `<data dir>/self-heal/loop-worktrees/<run id>` (`self_heal_fix.rs`).
  3. One `POST /kb/loop/agent-run` edits the worktree.
  4. The host reverts `Makefile`, `scripts/**`, `**/*.sh` and `**/package.json`, then runs the checkout's `scripts/self-heal-verify.sh` (`make regression`, 90 min).
  5. `POST /kb/self-heal/runs/:id/outcome` maps the verdicts.
  - Review / Apply (`git apply` of the reviewed patch, never a commit) / Discard end with `POST /kb/self-heal/runs/:id/resolve`.
  - The source checkout must be on the user's repo allow-list, and the Auto Tasks feature (which owns the Loop agent) must be on.
  - While a run is open, the core skips `log` and `server` reports.
- **Never** log incident text or send it anywhere. It reaches a model only fenced inside `BATCH.md`, in a run the user started.
- Tests:
  - node: `tests/incident-rules.test.mjs`, `tests/self-heal-store.test.mjs`, `tests/self-heal-routes.test.mjs`, `tests/self-heal-server.test.mjs` (spawns `server.mjs`; needs local listen), `tests/self-heal-batch.test.mjs`, `tests/self-heal-fix-store.test.mjs`, `tests/self-heal-runs.test.mjs` (local listen)
  - cargo: `self_heal_fix` (real git in temp folders)

### Add-on state location

`LLMIDE_PLUGIN_DIR` defaults to the OS plugin root, but the desktop host always sets it to
`<desktop data dir>/core/addons/plugins`. The sibling add-on bundles and JSON state live under
`<core>/addons/`. A one-time host copy imports the retired Mac app's add-ons; spawned-core tests must
set `LLMIDE_PLUGIN_DIR` to their temp dir so they never write real user data.
