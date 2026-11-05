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

The extension stores nothing of its own except an unfinished capture draft (`transcriptDraft:<id>` + `draftStage:<id>`), kept only until the server reports the capture acked by the Mac app. Run with `LLMIDE_LIVE_ACK=1` on the server (Mac-managed server) unless a row says otherwise.
- [ ] Record 1+ min, Stop with the Mac app running: the draft is gone from `chrome.storage.local` only after the Mac note exists (status `acked`); before that it is still there
- [ ] Stop with the Mac app/server CLOSED: the draft stays, the banner says "Mac app not running"; open the app, the capture is re-sent, the Mac writes the note, the draft disappears
- [ ] Close the panel mid-recording, reopen after 2+ min: the transcript is restored in the live view, re-sent and released after the ack
- [ ] Restart the server between Stop and the Mac ack: the draft is kept ("not confirmed copied" + Resend button), never deleted on an unknown status
- [ ] Server WITHOUT `LLMIDE_LIVE_ACK`: the draft is kept and listed with Export and Delete; with 50 kept, Stop refuses to finalize (error shown, capture stays) until you delete or export one. Nothing is ever dropped automatically
- [ ] Record past 2000 lines: the capture is never released; it is listed with Export and Delete
- [ ] Rename a speaker, set a language, Stop: the Mac note carries the display names, the language, the real start time and duration (not the Stop time)
- [ ] Fill storage (or block it in devtools) and Stop: a persistent red error appears, the capture is still sent, and the draft appears once space is back
- [ ] Two panels open: only the recording panel finalizes its capture; the other re-sends it only after the draft is 2 minutes stale
- [ ] No `transcripts` or `chatMessages` key is written (`chrome.storage.local.get(null)` in the panel console)
- [ ] Settings -> "Meetings saved in this browser (old)": lists old saved meetings read-only; nothing is sent until "Copy to Mac"; a copy is removed locally only after the Mac confirms; pressing twice sends once; closing the panel mid-copy and pressing again resumes
- [ ] Chat with the Mac app closed: "Mac app not running", nothing is persisted; reopen the app, the banner clears by itself
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

The server honours `LLMIDE_FEATURES`, the comma-separated list of ENABLED feature keys the Mac app was built with (`mac/Package.swift`; unset or empty = every feature). `core/config.mjs#parseFeatures` reads it once into `config.features`.

- **Feature-owned routes** live in `routes/feature-routes.mjs` (`FEATURE_ROUTE_GROUPS`): `auto_tasks` → `/kb/loop/*`, `gantt_issues` → `/kb/issue-schedule`, `code_graph_3d` → `/kb/ingest-code-graph`, `doc_gen` → `/generate-doc` (exact match; `/generate-docx` is not in the group). A disabled group's module is never imported, and its paths answer `404 {"error":"feature_disabled","feature":"<key>"}`.
- **Prune only single-owner routes** — a group may move into the table only when every caller (grep `src/` and the Mac `LlmIdeAPIClient*`) belongs to that feature. `/generate-docx` stays always-on because the Chrome extension's ExportMenu calls it.
- **Never import a feature route module statically** from `routes/router.mjs` or `server.mjs`; dispatch through `featureHandlers.<key>?.(…)` at the route's position.
- **The outcome poller stays unconditional** — `/kb/dispatch` and review approvals (always-on) are what write the dispatched tasks it polls.
- Tests: `tests/feature-config.test.mjs`, `tests/feature-routes.test.mjs`, `tests/server-features-health.test.mjs` (spawns `server.mjs`; needs local listen).

### Lazy engine

The Claude Agent SDK and the v2 chat engine (`llm_agent/sdk/engine.mjs`) are never on the boot path — nothing `server.mjs` imports statically (router, `server/*-routes.mjs`, the `auto_tasks` Loop route) loads them.

- **Chat**: `routes/agent-v2.mjs` imports the engine on the first turn through `loadAgentEngine()` (memoised; a rejected import is forgotten so the next turn retries, and the failure reaches the client as the usual terminal `ENGINE_ERROR` event).
- **Prewarm**: right after `server_started`, `server.mjs` calls `prewarmAgentEngine()` on `setImmediate` and logs `engine_prewarmed {ms}` or `engine_prewarm_failed`. `LLMIDE_ENGINE_PREWARM=0` (`config.enginePrewarm`) skips it — set it when measuring boot cost or module counts.
- **Also lazy**: the SDK in `llm_agent/sdk/models.mjs` (first model listing), `spike-engine.mjs` in `server/ai-routes.mjs`, and `llm_agent/sdk/loop-agent.mjs` in `routes/loop-agent.mjs` (first Loop run).
- **Constants a route needs** come from `llm_agent/sdk/constants.mjs` (`AGENT_SDK_PROVIDER`, `RESERVED_MCP_NAME`; no imports), and the auth ladder + engine home from `llm_agent/sdk/auth.mjs` (no SDK). `engine.mjs` re-exports all of them. Never import `engine.mjs` or the SDK statically from a module on the boot path — add the value to one of those two files instead.
- Test: `tests/lazy-engine.test.mjs` (module-load hook over the boot path; also spawns `server.mjs`, so it needs local listen).

## Host API v1 (desktop)

- **Mode** (`config.hostApiMode`): `tls` when `LLMIDE_HOST_API_TLS=1` (release builds too), else `dev` when `LLMIDE_HOST_API_DEV=1` (never with `NODE_ENV=production`; the Tauri host passes it only in a debug build), else `off`. Any mode but `off` starts the listener and enables `/host-api/pin|devices` (else `404 HOST_API_DISABLED`; those routes also need the bus host proof). The PIN answer carries the certificate `fingerprint` and `addresses` (this computer's IPv4s for the Settings pairing QR, Tailscale first, then LAN, then container/VM bridges; `pairingAddresses` in `routes/host-api/http-routes.mjs`) in `tls` mode; `null` and `[]` in `dev`.
- **Listener**: `server/host-api-listener.mjs` on 3016 (next free port up to 10), serving `/host-api/v1` only. `tls`: pinned WSS on `0.0.0.0` with the identity from `server/host-identity.mjs` (`host.hello` carries `certificateFingerprint`). `dev`: plaintext on `127.0.0.1`, non-loopback peers refused. Both refuse an `Origin` not in `LLMIDE_HOST_API_WEB_ORIGINS` (`core/host-api-origins.mjs`: exact loopback http with a port, or exact https DNS origin; pinned by `schema/host-api/v1/fixtures/security/origins.json`).
- **Env**: `LLMIDE_HOST_API_TLS=1` binds `0.0.0.0:3016+`, TLS only (off by default; turning it on by default is a product-stage decision). `LLMIDE_HOST_API_WEB_ORIGINS` lists exact origins (loopback `http` with a port, or `https://<domain>`, the latter honoured only in `tls` mode). `LLMIDE_HOST_API_READ=1` serves the `read` capability (`chat.sessions`, `chat.history`, `usage.get`; default off, `routes/host-api/reads.mjs`): every read is the session user's own (`listChatSessions` / `getChatSession` / `usageSummary`), re-redacted and clamped on the way out, with no meta, system lines or limit configuration. A device paired before the switch was on must re-pair to get it. The Tauri app passes only `LLMIDE_HOST_API_TLS` and `LLMIDE_HOST_API_WEB_ORIGINS` to a core it starts (`desktop/src-tauri/src/core_env.rs` drops every other `LLMIDE_*`), so `read` works only on a core you start yourself (`cd extension && LLMIDE_HOST_API_READ=1 npm run server`), which the app then adopts; it fails closed otherwise.
- **Identity**: the self-signed certificate and key live in the `host_api_identity` table (migration 0062), encrypted by the vault. A vault-key change resets the identity and wipes v1 devices (`server/host-identity.mjs`); any other read error propagates and changes nothing. Tokens carry the scopes granted at pairing (served ∩ granted; legacy tokens never get `tool_approvals`).
- **Audit and limits** (`routes/host-api/audit.mjs`, `rate.mjs`): `audit_log` rows with action `host_api.<event>`: `pair_failed`, `pair_ok`, `token_failed`, `pair_throttled`, `token_throttled`, `revoke_self`, `revoke_host`, `scope_denied`, `rate_closed`, `identity_created`, `identity_reset`, `origin_refused`, `plaintext_refused`, and `<event>_suppressed` summaries. Rows are de-duplicated per 60 s (refusals per peer, IPv6 by /64) and capped at `AUDIT_EVENT_CAP_PER_MINUTE = 60` per event type. Per session: 40-frame bucket at 10/s, 6-turn bucket at 0.1/s, 20-read bucket at 2/s (per device), close after 100 refusals; at most 2 unauthenticated sessions per peer with a 10 s auth deadline; PIN and token throttles are separate; a 4 MiB write cap closes with 1013; 32 connections and a 10 s handshake deadline. No secret or frame content is ever written.
- **No HTTP inside**: the gateway (`routes/host-api/gateway.mjs`) runs turns in process through `startHostTurn` / `cancelChatTurn` / `clearChatSessionState` from `routes/agent-v2.mjs`, never over HTTP, and never reads UI state.
- **Phone chat**: one server-side chat per user (`host_api_quick_chat`), run in mode `auto_read_only` in the extension chat workspace, not the open project.
- **Ordering**: frames of one session are processed in order (one at a time per session).

## Sync (desktop producer)

- **What**: encrypted snapshots (chats, meetings, plans, usage) and a queued-prompt inbox in a user-owned folder, for the phone and web with the desktop off. Design `docs/superpowers/specs/2026-11-05-box-encrypted-sync-design.md`, ADR 0020.
- **Where**: envelope `core/sync-envelope.mjs` (relay v1 bytes + `snapshot`/`manifest`/`syncwrap`; vectors `schema/sync/v1`, check `node scripts/sync-vectors.mjs`); stores `connectors/sync-store/` (memory for tests; MEGA via `megajs` 1.3.10, the first adapter by user decision; SFTP and Box are later sub-projects); state `kb/sync-state.mjs` (migration 0064); producer/consumer/scheduler/routes `routes/sync/`.
- **Vault**: `sync.rootKey`, `sync.signingKey`, `sync.megaEmail`, `sync.megaPassword`, `sync.prevRootKey` (24 h, for `stale_epoch`) are server-internal — never client-settable, listed or returned.
- **Enrollment** (SP2): `core/sync-enroll.mjs` (QR payload, claim, signed ack, SAS; vectors `enroll` in `schema/sync/v1`) and `routes/sync/enroll.mjs` (one pending enrollment per user, in memory; `es` is never stored or logged; the claim is pinned once and never re-fetched; the tier is the desktop's choice). Device contract: `schema/sync/v1/README.md` "Enrollment"; Node reference device `tests/helpers/sync-device.mjs` (on the independent `tests/helpers/sync-reference.mjs`, never `core/sync-*`); malicious-storage suite `tests/sync-enroll-malicious.test.mjs`.
- **Registry**: `sync_devices` is the only registry. Revoke = `removeTree(d/<dir>)`, row delete, rotation (`routes/sync/registry.mjs`, `rotateNow` in the scheduler). A registered device with `wrapEpoch > 0` whose folder lost `key.bin` is dropped, rotated and noted (`sync_device_removed`) at the next publish; puts never recreate a deleted folder.
- **MEGA**: a dedicated account only; 2FA off on that account (`SYNC_MFA_REQUIRED` otherwise); one session per user cached in `routes/sync/scheduler.mjs` while the core runs, logged out on shutdown, setup change or sync off; a refused login turns sync off instead of retrying. Tests use `tests/helpers/fake-mega.mjs`; the live run is opt-in (`LLMIDE_SYNC_MEGA_IT=1`).
- **Ceiling**: queued requests are `chat.send` only and run only through `startHostTurn` (`auto_read_only`, phone chat); an approval request cancels the turn and replies `needs_approval`; record-before-execute in `sync_requests`.
- **Off switch**: `LLMIDE_SYNC=off` starts no scheduler; per user, Settings "Sync on" (`sync_state.enabled`).
- **Never** log keys, folder names, the MEGA email or password, or decrypted content.
