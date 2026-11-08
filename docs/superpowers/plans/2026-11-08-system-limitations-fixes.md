# System Limitations Fixes — Implementation Plan (2026-11-08)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the limitations found by the 2026-11-08 system review that need no product decision, in three batches: (A) the system costs more than it claims today, (B) Team Hub readiness, (C) big-project ceilings and shipping hygiene. Every task is the smallest change that fully fixes its item and leaves one test that fails without it.

**Source:** the review is in the planner's session transcript; its 20 numbered findings are referenced below as **F1..F20**. The ones that need a user decision are listed at the end, not as tasks.

**Architecture:** no new modules unless a task names one. Reuse `core/semaphore.mjs`, `kb/usage.mjs` `estimateTurnCostUsd`, `kb/members.mjs` `CLASS_GRANTS`, `server/route-authority.mjs`, `desktop/src-tauri/src/core_env.rs` `host_api_env`, and the existing fake stores under `extension/tests/helpers/`.

**Tech Stack:** Node 22 core (pure `node:http`, better-sqlite3, `node:test`), Tauri host (Rust, `cargo test --lib`), React screens (`ui/screens`, node tests), web PWA (`web/`), iOS (`ios_app/SharedProtocol`, swift-testing).

**Builds on:** `main` at `09bef4cc` or later. `SERVER_API_VERSION` is 124; migration head is `0069`. A task that changes the wire format bumps the version in its own commit, as the H1.2 plan did.

## Global constraints

- Work on `main`, Conventional Commits, one concern per commit, never `--no-verify`, `CARGO_INCREMENTAL=0` for cargo.
- Smallest change that fully fixes the item. No wrappers, options or config nobody asked for. Deletion beats addition.
- Every task leaves one test that fails when the fix is reverted (say so in the commit body).
- A solo install never regresses: single user = owner with execute; nothing here changes that.
- Never log keys, tokens, prompt or note content, the MEGA email or password, or decrypted sync content.
- Where a task says "notice", it is a one-line `role="status"` text in the existing screen, not a dialog.
- Mark `READY <plan> T<n> <sha>` in `agent-coord/to-reviewer.md` and `log.md` after each task; push after each batch with `make regression` green and CI checked.

---

## Batch A — the system costs more than it claims (REQ-014, do first)

### Task A1 — sync producer re-uploads everything every minute (F5)

**Why:** `routes/sync/kinds.mjs:27` puts `generatedAt: now` inside the hashed frame, so the change check at `routes/sync/producer.mjs:48` never matches and all four kinds are sealed and uploaded per device every produce tick (`scheduler.mjs:18` PRODUCE_MS 60 s + jitter). The existing test passes only because its fake uses a fixed `generatedAt` (`tests/sync-producer.test.mjs:28,70-82`).

- [ ] In `kinds.mjs`, compute the change hash over `{ v, kind, truncated, items }` without `generatedAt`. Keep `generatedAt` in the encrypted frame the device reads. Smallest shape: export a `frameHash(frame)` beside the frame builder and use it in `producer.mjs:48` and in the `plainSha256` recorded at `producer.mjs:56`, instead of `sha256(frames[k])`.
- [ ] Heartbeat stays as designed (design spec §"heartbeat", 15 min): unchanged kinds are not re-sent between heartbeats.
- [ ] Test in `tests/sync-producer.test.mjs`: build the kinds twice with the REAL clock advancing (do not fix `generatedAt`), same items → producer uploads 0 blobs on the second tick; change one chat message → exactly 1 blob. The test must fail on `main` before the fix.
- [ ] Commit: `fix(sync): hash snapshot items without the timestamp so unchanged kinds are not re-uploaded`.

### Task A2 — the member USD cap does not count one-shot calls (F4, part 1)

**Why:** `providers/providers.mjs:404-413` and `providers/adapter-complete.mjs:78` call `recordUsage` without `costUsd`, so notes, plans, summaries and email classify never count toward `usage.mjs:587-606` (`usedUsdMonth`).

- [ ] At both record sites pass `costUsd: estimateTurnCostUsd(model, usage)` (the helper exists in `kb/usage.mjs`; check its signature and reuse it, do not write a second price table). Only when `usage` has token counts; otherwise leave null, as today.
- [ ] Test: a one-shot call through the providers path with a fake usage of 1000 input / 100 output tokens writes a `usage_ledger` row whose `cost_usd` is > 0, and `usedUsdMonth(userId)` reflects it. Reverting the change makes `cost_usd` NULL.
- [ ] Commit: `fix(usage): one-shot model calls count toward the member's monthly USD cap`.

### Task A3 — a turn can run far past the member's remaining budget (F4, part 2)

**Why:** `llm_agent/sdk/engine.mjs:1693` sets the SDK `maxBudgetUsd` from per-model limits (`resolveMaxBudgetUsd`), not from the member's remaining monthly budget. A member at 19.99 of 20 USD can start a turn with the 2M-token turn budget.

- [ ] In `resolveMaxBudgetUsd` (engine.mjs ~1151-1200), take `min(existing, remainingMonthlyUsd(userId))` where remaining = `usd_cap_month - usedUsdMonth` from the member's row (`kb/members.mjs` getter; `0` cap means no cap). Never below a small floor (0.01) so a turn that is already allowed to start can finish its first hop; the route-entry cap check still refuses a turn at or over the cap.
- [ ] Keep the documented known limit for concurrent chats (R-012#3) as is; this task does not add a per-user reservation.
- [ ] Test: member with cap 20 and 19.50 used → `maxBudgetUsd` resolves to 0.50 (not the per-model value); cap 0 → unchanged per-model value.
- [ ] Commit: `fix(agent-v2): clamp the turn budget to the member's remaining monthly USD`.

### Task A4 — global Host API session cap and unbounded turn concurrency (F3)

**Why:** `routes/host-api/gateway.mjs:18` `MAX_SESSIONS = 4` is global; the fifth phone or browser across the whole team is refused (`:191`). Chat turns have no global concurrency cap (`routes/agent-v2.mjs:168-189`, lock per chat only); the 6-slot semaphore at `providers/providers.mjs:758` covers only the providers CLI path.

- [ ] Gateway: make the cap per user (`MAX_SESSIONS_PER_USER = 4`) and add a hub-sized global cap (`MAX_SESSIONS = 64`, constant in the same place). Keep `MAX_UNAUTHENTICATED_PER_PEER`. Refusal text unchanged for the per-user case; a new short text for the global case.
- [ ] agent-v2: one global `Semaphore` (`core/semaphore.mjs`) for in-flight turns, size from `config.maxConcurrentTurns` (new env `LLMIDE_MAX_TURNS`, default 8), acquired in `runV2Turn` before the engine starts and released in `finally`. A turn that cannot acquire within 30 s answers `429 { error: { code: 'BUSY', message } }` and writes nothing to the ledger. Document the env in `extension/CLAUDE.md` next to the other `LLMIDE_*` lines.
- [ ] Tests: (a) two users each open 4 gateway sessions → all 8 accepted; a 5th for one user is refused; (b) with `LLMIDE_MAX_TURNS=1`, a second concurrent turn gets `BUSY`, and the first still completes.
- [ ] Commit (two): `fix(host-api): session cap is per user, with a hub-wide ceiling` and `feat(agent-v2): bound in-flight turns with one semaphore`.

### Task A5 — disabled accounts keep working on their access token (F12, part 1)

**Why:** `server/auth.mjs:66-80` `authenticate()` checks the JWT and revocation epoch but not `users.status`; only refresh does (`server/users.mjs:247`). A disabled member works for up to `LLMIDE_ACCESS_TTL_SEC` (900 s).

- [ ] In `authenticate()`, after the epoch check, read the user's `status` (one indexed read; if `requireRole` already loads the `members` row in the same request, reuse that read rather than adding a second) and answer `401 { error: { code: 'ACCOUNT_DISABLED' } }` when it is not `active`.
- [ ] Test: disable a user, their still-valid access token is refused on the next request.
- [ ] Commit: `fix(auth): a disabled account is refused on its access token, not only on refresh`.

### Task A6 — turns and tool runs are not audited (F12, part 2)

**Why:** `routes/agent-v2.mjs:426-434` writes audit rows only for bypass and `team.deny`; the engine writes none. "Who ran what" cannot be answered.

- [ ] At turn end (next to the existing ledger write in `routes/agent-v2.mjs`, ~`:690`), write one `audit_log` row: `action: 'turn.end'`, `detail: { chatId, mode, model, provider, toolNames: [...unique], costUsd, stopReason }`. Never prompt, reply or file paths. Tool names come from the engine's tool events already counted for the ledger.
- [ ] Test: a turn that ran two tools leaves one `turn.end` row with both names and no content.
- [ ] Commit: `feat(audit): one row per finished turn with mode, model, tools and cost`.

### Task A7 — queued prompt expiry and truncated snapshots mislead the phone (F10)

**Why:** `routes/sync/consumer.mjs:14` expires requests older than 24 h (`maxAgeMs`) while the web client keeps them as "waiting" for 8 days (`web/src/sync/controller.ts:20-22`); the desktop's outbox already keeps replies 7 days (`consumer.mjs:140`). `kinds.mjs:25-33` sets `truncated` when the oldest sessions are dropped; `web/src/read/snapshot.ts:5-15` ignores it and `ios_app/.../SyncSnapshots.swift:24` parses it but no view shows it.

- [ ] Raise `maxAgeMs` to 7 days to match `outboxDays` (one constant). Update the design spec line that states 24 h.
- [ ] Web: when a pending request is older than `maxAgeMs`, show it as `expired` (reuse the existing status enum). iOS: same rule in `SyncStore` where pending items are listed.
- [ ] Web and iOS: when any kind's `truncated` is true, show one notice "Only the most recent items are on this device." above the list (web `screens/sync`, iOS `SyncOfflineViews.swift`).
- [ ] Tests: web `tests/sync-*.test.mjs` for the expired state and the notice; SharedProtocol test that a truncated frame decodes with `truncated == true`; core test that a request 6 days old is still answered.
- [ ] Commits (two): `fix(sync): queued prompts live as long as the desktop's outbox` and `feat(sync): phone and web show when a snapshot is truncated`.

**Batch A push:** after A1-A7, `make regression` green, push, CI green.

---

## Batch B — Team Hub readiness (REQ-015)

### Task B1 — hub mode refuses to boot without a TLS terminator (F1, part 1)

**Why:** `core/config.mjs:46,295-297` reads `LLMIDE_HUB` only for registration; with `LLMIDE_ALLOW_REMOTE=1` the main API binds `0.0.0.0` with no TLS and `server.mjs:1523-1530` only logs a warning.

- [ ] New env `LLMIDE_TLS_TERMINATED=1` (documented: "the only thing in front of this core on a non-loopback bind is a TLS terminator"). On boot, when `config.hub` is true and the bind is non-loopback and this flag is not set, log `hub_requires_tls` and exit 1. Loopback binds are unaffected (local dev, tests).
- [ ] Add the line to `deploy/vps/README.md` `core.env` example and to `extension/CLAUDE.md`.
- [ ] Test: spawning `server.mjs` with `LLMIDE_HUB=1 LLMIDE_ALLOW_REMOTE=1 LLMIDE_HOST=0.0.0.0` and no flag exits 1 with that reason; with the flag it boots. (Needs local listen; follow the pattern of `tests/self-heal-server.test.mjs`.)
- [ ] Commit: `fix(hub): refuse a non-loopback hub bind without a declared TLS terminator`.

### Task B2 — hub members cannot pair a phone because every `/host-api` route needs the desktop's host proof (F1, part 2)

**Why:** `routes/host-api/http-routes.mjs:66` runs `verifyBusHostProof` first on PIN, devices and push routes. The proof key exists only in a desktop-spawned core (`core/host-approval.mjs:46-60`), so on a VPS hub no member can mint a PIN or list devices. ADR 0021 H2's exit criterion ("a member on the public domain pairs a phone and a browser") cannot be met.

- [ ] In hub mode only (`config.hub === true`), replace the host-proof check on `POST /host-api/pin`, `GET/DELETE /host-api/devices*` and `/host-api/push/*` with the member's JWT + `requireRole('member')` (class `external.*` per `CLASS_GRANTS`; add a row to `ROUTE_POLICY` if the generator needs one). Outside hub mode nothing changes.
- [ ] A PIN minted on a hub binds to the member's `userId` exactly as today; the device's capabilities at pairing still derive from the member's grants (H1 gateway filter).
- [ ] Tests: `tests/host-api-gateway.test.mjs` or a new `tests/host-api-hub-pairing.test.mjs`: in hub mode a `member` mints a PIN and pairs without any proof header; a `viewer` is refused `ROLE_DENIED`; outside hub mode the proof is still required.
- [ ] Commit: `feat(hub): members pair phones and browsers by role, not by the desktop host proof`.

### Task B3 — the packaged desktop never enables read, compose, push or tool approvals (F2)

**Why:** `desktop/src-tauri/src/core_env.rs:25-26` `host_api_env` passes only `LLMIDE_HOST_API_TLS` and `LLMIDE_HOST_API_WEB_ORIGINS` to the spawned core; `routes/host-api/gateway.mjs:63-69` reads the other three from the core's env, so they are never on in a normal install. `ui/screens/settings/sections/HostApiPairing.tsx:4-6` renders nothing until the PIN route answers.

- [ ] Rust: extend `host_api_env` to pass `LLMIDE_HOST_API_READ`, `LLMIDE_HOST_API_COMPOSE`, `LLMIDE_HOST_API_PUSH`, `LLMIDE_HOST_API_TOOL_APPROVALS` with the same exact-value rule (`"1"` only). Source: desktop prefs (new booleans `hostApiRead`, `hostApiCompose`, `hostApiPush`, `hostApiToolApprovals`, `hostApiTls`, all default false, in `prefs.rs` `Prefs` + `PrefsPatch`, applied at next core start like every other backend pref).
- [ ] Settings → Host API card: four checkboxes plus "Serve the pairing listener (TLS)" with the notice "Applies on the next core start."; the pairing card shows a hint when TLS is off instead of nothing.
- [ ] Tests: `core_env` test that the five keys pass with value `1` and nothing else leaks; `prefs` test for the new fields; a ui test that the card renders the hint when the PIN route answers 404.
- [ ] Commit (two): `feat(desktop): Host API capabilities are desktop prefs passed to the spawned core` and `feat(ui): Host API settings card with the pairing hint`.

### Task B4 — secrets travel in the core's environment (F7, part 2)

**Why:** `core_host.rs:1217-1224` passes `LLMIDE_JWT_SECRET`, `LLMIDE_VAULT_KEY` and `LLMIDE_HOST_APPROVAL_KEY` as env vars; any same-user process reads them (`ps eww` / `/proc/<pid>/environ`).

- [ ] Pass the three secrets as one JSON line on the child's stdin (the core already uses stdin only for nothing; confirm with grep) and read them in `server.mjs` boot before anything else when `LLMIDE_SECRETS_STDIN=1`; the env vars remain for the non-desktop case. The host closes stdin after the write; the core must not echo it.
- [ ] Rust test: the spawned command's env contains no `LLMIDE_JWT_SECRET`; a fake child reads the JSON from stdin. Node test: boot with `LLMIDE_SECRETS_STDIN=1` and a piped line → `/health` is served and `/auth/login` works.
- [ ] Commit: `fix(desktop): hand the core its secrets over stdin, not the environment`.

### Task B5 — backups block every request and never leave the host (F6, part 2)

**Why:** `kb/backup-databases.mjs:27-33` runs `VACUUM INTO` synchronously on the event loop from the daily job (`server.mjs:1472-1591`) and the admin route (`:1056-1090`); `DEFAULT_BACKUP_KEEP = 2` (`kb/backup-retention.mjs:13`); no off-host copy exists.

- [ ] Run the backup in a `child_process.fork` of a small `kb/backup-worker.mjs` that opens the DB read-only and does the `VACUUM INTO`; the parent awaits exit and then runs retention as today. Admin route returns `202` with a job id when it would take long? No: keep the route synchronous in API shape; the worker just stops the main loop from blocking.
- [ ] Hub default keep: when `config.hub`, `DEFAULT_BACKUP_KEEP` is 7.
- [ ] Off-host copy: `scripts/backup-offhost.sh` (documented in `deploy/vps/README.md`, run by a cron line in the runbook) that `scp`s the newest backup to the existing SFTP sync host path `backups/` and keeps 7 there. No secrets in the script; the SSH key is the service user's.
- [ ] Test: a 50 MB fixture DB backs up while a concurrent `/health` answers within 200 ms (measure with `performance.now()`; today it stalls for the VACUUM duration).
- [ ] Commits (two): `perf(db): run backups in a child process so requests never stall` and `docs(ops): nightly off-host backup copy for the hub`.

### Task B6 — agent spend and trust on a shared host (F16)

**Why:** `server/route-authority.mjs:284` email classify is one model call per message with no per-batch cap; `agents/outcome-watcher.mjs:207-210` polls provider APIs every 5 min for every dispatched task; `llm_agent/extensions/mcp-servers.mjs:33` stdio MCP servers run as the core's OS user on the hub.

- [ ] Email classify: a per-run token budget (`LLMIDE_CLASSIFY_BUDGET_TOKENS`, default 50,000); stop the batch at the budget and report `classifiedCount`/`skippedCount`.
- [ ] Outcome poller: when a cycle finds no task changed, double the interval up to 60 min; reset on any change.
- [ ] Hub mode: refuse to start a stdio MCP server (`transport: 'stdio'`) with `MCP_STDIO_DISABLED_IN_HUB`; remote transports unchanged. Document in `extension/CLAUDE.md` and the extensions spec.
- [ ] Tests: classify stops at the budget; poller interval doubles then resets; hub refuses stdio.
- [ ] Commits (three, one per concern).

**Batch B push:** after B1-B6, `make regression` green, push, CI green. Bump `SERVER_API_VERSION` once for the new `ACCOUNT_DISABLED`/`BUSY` codes and the hub pairing rule, in B2's commit (or A5's if A ships first; whichever lands first bumps to 125 and the other reuses it).

---

## Batch C — big-project ceilings and shipping hygiene (REQ-016)

### Task C1 — silent desktop ceilings get notices (F15)

**Why:** `ui/screens/explorer/controller.ts:866` watches the first 500 expanded folders and swallows the host error; `fs_watch.rs:31-32` caps 512 folders / 2000 paths; search stops at 5,000 hits (`project_search.rs:38-44`) with no notice; a folder over 1,000,000 entries returns `too_large` with no listing (`fs_ops.rs:36`).

- [ ] Explorer: when the expanded set exceeds the cap, show "Changes in folders beyond the first 500 expanded are not watched; collapse some folders." once, and do not swallow the `fs_watch_set` error (log it, show the notice).
- [ ] Search: when results hit the cap, show "Showing the first 5,000 matches; narrow the search."
- [ ] Listing: on `too_large`, show the count and the cap instead of a bare error.
- [ ] Tests: ui tests for the three notices with fake hosts.
- [ ] Commit: `feat(ui): say so when the watcher, search or a listing hits its cap`.

### Task C2 — graph layout timeout returns nothing (F15)

**Why:** `ui/screens/graph/engine.ts:82` aborts after 180 s with an error and no partial result.

- [ ] Timeout scales with size: `base 180 s + 1 s per 1,000 edges`, capped at 15 min; on timeout, if the worker has an intermediate layout, render it with the notice "Layout stopped early; positions are approximate."
- [ ] Test: a fake worker that never finishes but posts one intermediate layout → the screen renders it with the notice.
- [ ] Commit: `feat(graph): a layout timeout shows the partial layout instead of nothing`.

### Task C3 — a core crash mid-turn loses the reply; a missing data dir looks like a fresh install (F19)

- [ ] agent-v2: on an aborted stream (core restart or engine death), persist the partial assistant text so far into the chat with `interrupted: true`; the desktop chat shows "Interrupted" on that bubble. (`routes/turn-replay.mjs` already has the events in memory; write the text on `abort`, not on every chunk.)
- [ ] Rust `fsutil.rs:13`: if the configured data dir's parent does not exist, do not create it; return an error the Shell shows as "Your data folder is not available: <path>. Reconnect the drive or change the location in Settings." Default location (under Application Support) is unaffected because its parent always exists.
- [ ] Tests: node test for the interrupted write; Rust test for the missing parent.
- [ ] Commits (two).

### Task C4 — search is one shared FTS table with a 10,000-row window (F11)

**Why:** `kb/db.mjs:333-362` runs bm25 over every user's rows then filters by owner within `SEARCH_DEEP_LIMIT = 10000`; a hub member's hits beyond that vanish. `kb/note-index.mjs:250-263` rebuilds in one transaction.

- [ ] Migration `0070_search_user_column.sql`: add `user_id` as an UNINDEXED column to the FTS table (and `project_id` if it exists in `note_index`), backfilled from the base table; the MATCH query adds `AND user_id = ?` so the window is per user. Keep the trigram setup.
- [ ] Rebuild in batches of 500 rows per transaction with `setImmediate` yields between batches; the manifest/reconcile scan keeps its limits.
- [ ] Tests: two users with 12,000 and 10 notes; the second user's note is found; a rebuild of 5,000 notes does not block a concurrent read for more than 100 ms.
- [ ] Commit (two): `perf(search): partition full-text search by user` and `perf(search): rebuild the note index in yielding batches`.

### Task C5 — device tokens never expire; sync revoke is not a kill switch (F14)

- [ ] `kb/host-api-devices.mjs:7-46`: add `MAX_LIFETIME_MS = 90 days` from `created_at`; a device past it must re-pair (`token_expired`). Desktop device list shows last-seen and created.
- [ ] Sync revoke (desktop `routes/sync/registry.mjs` + the Settings card): after revoking a device, show "Change the MEGA account password now; the phone still holds a session." with a Done checkbox that writes `sync_state.passwordChangedAt`.
- [ ] Web `sync/device.ts:121-123` and iOS `SyncDevice.swift:194`: refuse a manifest whose `validUntil` is more than 7 days in the past (`stale_manifest`), and add the rule as a shared vector in `schema/sync/v1` that both clients run.
- [ ] Tests: device past 90 days refused; the vector in both clients.
- [ ] Commits (three).

### Task C6 — ingestion caps and the stale "Mac app" comment (F17)

- [ ] `routes/bus/sources-update.mjs:4-5`: Box is Pattern A and already has `MAX_FILES` with a `truncated` flag; add it to the scheduled set behind the same T1 approval; fix the comment (Slack and email stay fetch-only and say why).
- [ ] `connectors/git.mjs:36-38`: record `truncated: true` per file when `MAX_CHUNKS_PER_FILE` cuts it (as `box.mjs` does) and show the count in the source's status.
- [ ] Tests: a 3,000-line file ingests with `truncated: true`; Box appears in the schedulable kinds.
- [ ] Commits (two).

### Task C7 — capture defaults and the 2,000-line cap (F9)

- [ ] `extension/src/sidepanel/hooks/useTranscript.ts:86`: default `captureMode` to `captions` on the three supported platforms; label the mic option "Local microphone only (uses Chrome speech service)".
- [ ] Panel closed: the content script shows a small banner "LLM-IDE panel is closed; captions are not being saved" when `sendMessage` has no receiver (the error at `caption-scraper.ts:406-420` is currently ignored). Keep the no-buffer design.
- [ ] `capture-store.ts:113-115`: chunk the finalize body at 2,000 lines / 3 MB into sequential `POST`s with `part`/`of`; the core concatenates (one small change in the capture route; bump API if the body shape changes). Add `unlimitedStorage` to `manifest.json`. Delete the unused `MAX_SESSION_DURATION_MS` (`config.ts:463`).
- [ ] Tests: default mode; the banner on a missing receiver; a 4,500-line capture lands whole.
- [ ] Commits (three).

### Task C8 — runtime and release hygiene (F8, F18)

- [ ] Node 22 everywhere: `.github/workflows/release.yml:29`, `extension/package.json` `engines` `>=22`, `setup.sh:27`.
- [ ] `release.yml`: fail when the CHANGELOG section for the tag is empty; add the `[2.0.0]` section (from `git log v1.0.0..v2.0.0 --oneline`, grouped by type).
- [ ] `contract-ci.yml`: add `make regression` after `git submodule update --init graph-kit`; record its duration in `docs/how-to/ci.md` (create if missing, one table).
- [ ] `desktop-release.yml`: a packaged install-and-launch smoke on `windows-latest` and `ubuntu-latest` that starts the app with `LLMIDE_POC_AUTOBENCH`-style exit after `/health` is seen (reuse the autobench exit path; if it needs the `spike` feature, build the smoke with it and keep the release build without).
- [ ] Docs: a `make docs-check` rule that fails on `mac/` or `Swift` references outside a line containing "removed" (allow-list the ADRs and CHANGELOG); fix what it finds in `docs/kits/*`, `docs/how-to/release*`, `docs/explanation/architecture.md`, `docs/reference/project-layout.md`, MASTER-PLAN S10, USER-CHECKLIST section B.
- [ ] Commits: one per bullet.

**Batch C push:** after C1-C8, `make regression` green, push, CI green.

---

## Needs a user decision (not tasks; the planner will ask)

| # | Finding | Question |
|---|---|---|
| D1 | F6 operator trust | Record in ADR 0021 that the VPS operator can read every member's data and secrets, or move the vault master and JWT secret out of the DB host (KMS or separate secret store)? |
| D2 | F2 phone scope | Does the phone get project-scoped read commands (files, sessions per project) in Host API v1, or stay chat-only until Team Hub H4? |
| D3 | F7 hub origin | Desktop "Connect to hub": which origin rule goes into the CSP and the trust model (one configured https origin, pinned fingerprint or CA)? This is H3. |
| D4 | F8 signed release | Run the `workflow_dispatch` signed build without publish now (needs your 9 secrets), and one real N-1 → N update on a staging channel? |
| D5 | F13 token overhead | Flip `LLMIDE_V2_COMPACT_PROMPT` on for the hub surface after the bench, and set the cache TTL? (Bench-gated by your 2026-10-30 rule.) |
| D6 | F20 duplication | Generate the sync kind frames and rollback rules from `schema/sync/v1` for web, iOS and the core (three hand-ported copies today)? Larger refactor; after C5's shared vector. |

## Review gates

Each batch: `make regression` green, CI green after push, the reviewer's `R-NNN` with no open Critical/Important before the next batch starts.
