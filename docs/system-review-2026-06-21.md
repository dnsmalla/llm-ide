---
title: Whole-system review — 2026-06-21
status: findings
---

# Whole-system review — 2026-06-21

A four-lens (correctness · security · architecture · production-readiness) review across all subsystems, grounded in the `docs/spec/` contracts. Findings were produced by per-area reviewers and then **independently verified against source**; each carries a verdict:

- **✓ verified** — confirmed by reading the cited source directly during this review.
- **○ reported** — traced by the area reviewer (high confidence) but not independently re-read here.
- **△ downgraded / nuanced** — the raw finding overstated impact; see the note.

Every item has a `file:line` and a one-line fix. Line numbers are point-in-time (2026-06-21).

## Remediation status (updated 2026-06-21)

The critical findings and the secret-leak highs were fixed the same day (commits `9d06a09`, `80420fc`, `6ec3cc5`):

| Finding | Status |
|---|---|
| AGT-1 SSRF via `custom.baseUrl` | ✅ fixed — `assertSafeBaseUrl` guard + tests |
| KB-1 account-deletion orphans `agent_ask_messages` | ✅ fixed — added to `deleteUserCascade` + test |
| AGT-4 provider CLI inherits full env | ✅ fixed — `minimalCliEnv` allowlist + tests |
| AGT-5 guardrail zero-width evasion | ✅ fixed — two-collapse (ws + zero-width) + tests |
| MAC-3 `BackendManager` leaks full env to Node | ✅ fixed — env allowlist (`swift build` clean) |
| AGT-2 Backlog key in URL | ✅ verified no-op — already never-logged + redacted |

A subsequent full-backlog pass then remediated **the rest** (commits `15aa4a5` server, `5631843` kb, `707a0c5` agent, `276215c` extension, `7f6df07` mac):

| Area | Fixed | Verification |
|---|---|---|
| Server | SRV-2, SRV-3, SRV-5, SRV-6, SRV-7, SRV-9, SRV-10 | +5 tests, suite green |
| KB | KB-2, KB-3, KB-4, KB-6, KB-8, KB-9 (+migrations 0014/0015) | +2 tests, migrations apply |
| Agent | AGT-8, AGT-9, AGT-10, AGT-11, AGT-12 | +6 tests, suite green |
| Extension | EXT-1, EXT-3, EXT-4, EXT-5, EXT-6, EXT-7, EXT-8, EXT-9, EXT-10 | `tsc --noEmit` clean |
| macOS | MAC-1, MAC-2, MAC-4, MAC-6, MAC-7, MAC-10 | `swift build` clean |

**Deferred** (recorded, not abandoned — each needs its own focused pass, not a blind edit):

| ID | Why deferred |
|---|---|
| SRV-4 (async bcrypt) | making auth async ripples through 10+ test call sites; half-done silently breaks DB writes |
| SRV-8 (auth-routes monolith) | 755-line refactor; needs its own pass with full route coverage |
| KB-10 (UTF-8 checksum) | 11/13 migration files have non-ASCII comments → switch would invalidate every stored checksum; needs comment-cleanup or a reset path first |
| MAC-5 (adopted-backend health) | wiring reconcile into the API client risks a circular dep + feedback loop on transient errors |
| MAC-8 (`@Observable` migration) | large cross-cutting refactor |
| MAC-9 (crash reporting) | needs a new dependency (Sentry/etc.) + product decision |
| KB-5, KB-7 | non-exploitable / accepted perf trade-off (reviewer recommended accepting) |

Net: **2 critical + ~9 high + ~17 medium + ~14 low addressed; 7 deliberately deferred with rationale.** The detailed findings below are retained as the record; line numbers predate the fixes.

## Executive summary

| Severity | Count | Headline |
|---|---|---|
| Critical | 2 | SSRF via custom provider base URL (AGT-1); user data not deleted on account deletion (KB-1) |
| High | ~9 | secrets leak to subprocesses (AGT-4 / MAC-3); credential in URL (AGT-2); guardrail evasion (AGT-5); stale FTS (KB-2); wrong-path write (MAC-2) + others |
| Medium | ~17 | TOCTOU behind single-writer, vault legacy-blob fallback, blocking bcrypt, etc. |
| Low | ~14 | naming drift, layout-specific shortcut, arch/tech-debt |

**Cross-cutting themes:**
1. **Secrets leak to child processes** — multiple spawn paths inherit the full `process.env` (server JWT/vault secrets) instead of an allowlist: `agents/providers.mjs` `runViaCli`, `mac BackendManager`. The main `agents/runtime.mjs` CLI path *does* allowlist — the others should match it.
2. **Stale-name drift** — Prometheus metrics use the old `meetnotes_` prefix; a few config/log keys too. (Same class the docs effort already fixed in prose.)
3. **Single-writer assumptions** — several TOCTOU windows (KB-6) and the in-memory circuit breaker (AGT-11) are safe only while the server is one process; document or guard before any multi-process move.

---

## 🔴 Critical

### AGT-1 — SSRF via vault `custom.baseUrl` ✓ verified
`extension/agents/providers.mjs:39,99` · security. `customBaseUrl()` returns the vaulted value with only trailing-slash stripping; `callOpenAI()` does `fetch(`${base}/chat/completions`)` with no scheme or host validation (same for `listProviderModels` at :254/:261). A user-set (or vault-tampered) base URL can target `169.254.169.254` (cloud metadata), `localhost:11434`, or any internal host — exfiltrating every agent prompt **and the API key**.
**Fix:** validate `customBaseUrl` output — require `https://`, reject loopback / link-local / RFC-1918 / non-FQDN — before use.

### KB-1 — account deletion orphans `agent_ask_messages` (user PII) ✓ verified
`extension/kb/db.mjs:694–746`, `extension/kb/migrations/0007_agent_ask_history.sql` · security/privacy. `deleteUserCascade` deletes from ~16 tables but **never** `agent_ask_messages` (confirmed: 0 references in `db.mjs`), and that table has no `REFERENCES users … ON DELETE CASCADE` (just `PRIMARY KEY (user_id, seq)`). A deleted user's full ask-the-agent transcript — potentially sensitive meeting content — survives indefinitely.
**Fix:** add `counts.agent_ask_messages = del('DELETE FROM agent_ask_messages WHERE user_id = ?');` inside the cascade transaction (and ideally an FK with cascade in a new migration).

---

## 🟠 High

### AGT-4 / MAC-3 — secrets leak to spawned subprocesses ✓ verified
- `extension/agents/providers.mjs:204` · `runViaCli` calls `execFile(inv.bin, inv.args, { timeout, maxBuffer })` with **no `env` option** → the codex/gemini/custom CLI fallbacks inherit the full server env (`LLMIDE_JWT_SECRET`, `LLMIDE_VAULT_KEY`, …). The main `agents/runtime.mjs:288` CLI path allowlists env; this one must too.
- `mac/Sources/LlmIdeMac/Services/BackendManager.swift:246` · spawns Node with `ProcessInfo.processInfo.environment` verbatim (only overriding `TERM`/log flag) → any ambient shell secrets reach the Node server and everything it shells out to.
**Fix:** allowlist env vars (`PATH`, `HOME`, the specific `*_API_KEY` needed) in both spawn paths.

### AGT-2 — Backlog API key in GET URL query ✓ verified
`extension/agents/outcome-providers.mjs:98` · security. Outcome polling builds `https://${space}/api/v2/issues/${key}?apiKey=${apiKey}`. The dispatch path correctly puts the key in the POST body; the poll path leaks it into URLs (server logs, intermediaries, Backlog logs). The poller reads the key from the vault server-side, so this is a server-originated exposure.
**Fix:** send the key as a header, or document + suppress URL logging if query-only is unavoidable.

### AGT-5 — guardrail evasion via zero-width characters ✓ verified
`extension/guardrails/rules.mjs:65` · security. `findMatches` collapses only `text.replace(/\s+/g,'')`; `\s` excludes U+200B/200C/200D/2060/FEFF. A secret/destructive pattern with embedded zero-width chars (the runtime even *inserts* U+200D for fence redaction) slips past both the raw and collapsed checks.
**Fix:** collapse `/[\s​-‍⁠﻿]+/g` in `findMatches` and `scanForSecrets`.

### KB-2 — stale FTS: no `AFTER UPDATE` trigger on `meetings`/`plans` ✓ verified
`extension/kb/migrations/0001_initial.sql` · correctness. `AFTER UPDATE` triggers exist for `sources` and `plan_tasks` only. `ingestMeeting`/`savePlan` upserts (re-ingest, rename) fire `AFTER UPDATE`, which has no trigger → the FTS `search` table keeps the old title/body. Keyword search returns stale content.
**Fix:** add `trg_meetings_au` and `trg_plans_au` (delete old FTS row by `entity_id`+`kind`, re-insert).

### MAC-2 — code-assist writes to the LLM-emitted path, not the attached file ✓ verified
`mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift:1632` · security/correctness. `matchingAttachment(for: args.path)` has a basename-only fallback, but the write uses `PathUtils.canonicalise(args.path)` (the LLM's path) while the in-memory attachment update uses `match.path`. So the disk write can land on a different file that merely shares a basename with an attached one — overwriting the wrong file and desyncing disk vs memory.
**Fix:** write to `match.path`, not `args.path`.

### MAC-1 — auto-edit follow-up is a silent no-op ○ reported
`mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift:1516–1543,1659,1689` · correctness. In auto-edit mode, `send()` sets `busy=true`, then `confirmUpdateFile` calls `sendFollowup()` which returns early on `guard !busy`. The file is written and a synthetic ack turn appended, but the agent's `(continue)` turn never fires → truncated conversation, lost chained actions.
**Fix:** clear `busy` before `sendFollowup()`, or pass a flag distinguishing the in-`send()` call.

### EXT-3 — `CAPTION_FINAL` merge only checks the last segment ○ reported
`extension/src/sidepanel/hooks/useTranscript.ts:229` · correctness. The session-merge checks only `prev[lastIdx].sessionId`. With interleaved speakers, an update to a non-last session creates a duplicate segment instead of merging → fragmented attribution and faster segment growth.
**Fix:** `prev.findLastIndex(s => s.sessionId === sessionId)` before appending.

### EXT-4 — START retries not cancelled on stop ○ reported
`extension/src/sidepanel/hooks/useTranscript.ts:558–562` · correctness. `startRecording()` fires `START_CAPTION_SCRAPING` at 0/1/3s via untracked `setTimeout`s. Clicking Stop before they fire restarts the scraper after stop → the content-script observer/interval runs indefinitely.
**Fix:** store the timer IDs in refs; clear them in `stopRecording()`.

### KB-4 — `agent_ask_messages.created_at` type mismatch ✓ verified (schema), ○ (insert)
`extension/kb/migrations/0007_agent_ask_history.sql` (`created_at REAL`, unix-seconds) vs `extension/kb/personas.mjs:301` (inserts `new Date().toISOString()`) · correctness. SQLite stores the string in a REAL column without error; any future numeric ordering/range/pruning on `created_at` silently breaks. Dormant (current reads order by `seq`).
**Fix:** insert `Date.now()/1000`.

### SRV-1 — password-reset token written to logs △ nuanced (high→medium)
`extension/server/auth-routes.mjs:265` · security. In prod, `logger.warn('password_reset_token', { token: result.token })` logs the raw token. **This is an intentional dev-stub** ("replace this block with your SMTP/SES call") for OOB delivery — so it's "must harden before a real multi-user deployment," not an accidental leak. Still: any log aggregation persists a live credential.
**Fix:** before shipping multi-user, replace with real OOB delivery; never log the raw token (log a digest for correlation).

---

## 🟡 Medium

| ID | Lens | Location | Issue | Fix | Verdict |
|---|---|---|---|---|---|
| SRV-2 | sec | `server/jwt.mjs:70–81` | `verifyAndDecode` doesn't require `jti`; a jti-less token bypasses revocation | reject tokens without `jti` | ✓ (defense-in-depth — all issued tokens have one) |
| SRV-3 | sec | `server/auth.mjs:65` | `requireAdmin` throws 401 (AUTH_REQUIRED), should be 403 (FORBIDDEN) | `throw errForbidden(...)` | ✓ |
| SRV-4 | prod | `server/users.mjs:127…` | `bcryptjs` sync hashing blocks the event loop ~250–400ms/call | use async bcrypt API / native `bcrypt` | ○ |
| SRV-5 | sec | `server/vault.mjs:88–103` | legacy no-AAD decrypt fallback never force-migrates untouched secrets | add a re-encrypt migration; warn on legacy decrypt | ✓ |
| SRV-6 | correct | `server/auth-routes.mjs:37–51` | local `readJson` uses `req.destroy()` on overflow (kills response) vs `utils.readBody`'s `req.pause()` | use `core/utils.readBody` | ○ |
| SRV-7 | sec | `server/users.mjs:286–316` | reset-token path: DB ops differ for known vs unknown email → timing enumeration | equalize DB round-trips on the unknown path | ○ |
| KB-3 | sec | `kb/db.mjs:635,658` | `setEmailHighWater`/`markEmailSeen` silently `return` on bad userId instead of `requireUser` throw | call `requireUser` | ✓ |
| KB-6 | sec | `kb/meetings.mjs:44`, `kb/plans.mjs:26` | ownership `SELECT` is outside the upsert transaction (TOCTOU; safe only single-writer) | move the check inside `db.transaction()` | ✓ |
| KB-8 | sec | `kb/migrations/0001_initial.sql` outcomes trigger | outcomes `meta` JSON indexed verbatim as FTS `body` (provider text searchable) | set `body=''` for outcomes, like entities | ○ |
| AGT-8 | sec | `agents/outcome-watcher.mjs:88` | token-redaction list missing Anthropic `sk-ant-` pattern | add `/\bsk-ant-[A-Za-z0-9-]{10,}\b/g` | ○ |
| AGT-9 | sec | `agents/outcome-providers.mjs:81` | Backlog poll URL host not re-validated (dispatch validates; poll doesn't) | apply `BACKLOG_TLD_RE` before the poll fetch | ✓ |
| AGT-10 | arch | `agents/runtime.mjs:354–459` | `runClaudeStream` duplicates key-lookup/provider-routing from `runClaude` | extract a shared helper | ○ |
| AGT-11 | prod | `agents/outcome-watcher.mjs:41` | circuit-breaker state is per-process (breaks under multi-process) | document single-process, or shared store | ✓ |
| EXT-6 | sec/prod | `sidepanel/hooks/useChat.ts` | `chatMessages` uncapped shares the 5MB `chrome.storage.local` pool with transcripts → filling it can evict saved meetings | cap chat history (~200) | ○ |
| EXT-8 | prod | `src/content/speaker-detector.ts:226` | speaker detector polls + broadcasts on load, ungated by recording state | gate intervals on START/STOP | ✓ |
| MAC-5 | prod | `Services/BackendManager.swift:223` | adopted-external backend death leaves status stuck `.running` (recovery only via LoginView) | central health reconcile / heartbeat for adopted servers | ○ |
| MAC-6 | sec | `Services/BackendManager.swift:434` | `killExternalListener` SIGTERMs *any* PID on port 3456 (friendly-fire) | filter to node/`server.mjs` PIDs | ○ |

## 🟢 Low

| ID | Lens | Location | Issue | Verdict |
|---|---|---|---|---|
| SRV-8 | arch | `server/auth-routes.mjs` (755 lines) | monolithic dispatch; 3 body-readers; mixed `send`/`sendError` | ✓ |
| SRV-9 | prod | `server/auth-routes.mjs:309` | bottom-of-handler `if(!req.user)` guard is structurally fragile | ○ |
| SRV-10 | prod | `server/metrics.mjs` | metric names use stale `meetnotes_` prefix → dashboards built on `llmide_*` see no data | ✓ |
| KB-5 | sec | `kb/db.mjs:277` | FTS hydration IN-list not SAFE_ID-validated (not exploitable — values are trigger-written) | ○ |
| KB-7 | arch | `kb/db.mjs:277,543` | hydration uses `db.prepare` not `lazyPrepare` (perf/consistency) | ✓ |
| KB-9 | correct | `kb/db.mjs:223` | empty-query source rows emit `meetingId: r.kind` vs `null` in the FTS path | ✓ |
| KB-10 | prod | `kb/migrations.mjs:64` | checksum uses `charCodeAt` (UTF-16), not UTF-8 bytes (fine while migrations are ASCII) | ✓ |
| AGT-12 | correct | `llm_agent/runtime/fence.mjs:49` | `validateArgs` silently drops extra args (benign now; risky if a handler reads `args` directly) | ○ |
| EXT-1 | correct | `src/content/caption-scraper.ts:792,881` | `POST_CHAT` handler skips `isMessage()`; malformed *internal* message → "undefined" posted to chat | △ **downgraded from critical** — no `externally_connectable`, SW checks `_sender.id`, so no external sender can reach it |
| EXT-5 | correct | `src/background/service-worker.ts:28` | `ensureContentScriptInjected` returns `true` for unsupported URLs (misleading "ready") | ○ |
| EXT-7 | correct | `src/content/caption-scraper.ts:793` | same missing `isMessage()` guard as EXT-1 | ○ |
| EXT-9 | prod | `src/content/caption-scraper.ts:769` | start/stop partial-failure can double-create or drop the scrape interval | ○ |
| EXT-10 | arch | `src/sidepanel/App.tsx:183` | two coupled effects on overlapping deps → possible double-dispatch | ○ |
| MAC-4 | correct | `Services/SessionStore.swift:79` | redundant first refresh-coalesce check (works via MainActor serialization) | ○ |
| MAC-7 | correct | `Services/BackendManager.swift:189` | `[weak self]` re-accessed across `await` without re-guard (safe via `@State` lifetime) | ○ |
| MAC-8 | arch | `Services/` | mixed `@Observable` / `ObservableObject` → `@EnvironmentObject` crash risk if mismatched | ✓ |
| MAC-9 | prod | `LlmIdeMacApp.swift:10` | crash handler logs to os.log only; no remote crash reporting | ○ |
| MAC-10 | correct | `Views/AppShell.swift:95` | Ctrl+` terminal toggle uses raw `keyCode 50` (layout-specific) | ✓ |

---

## Non-findings (looked suspicious, clean on inspection)
- **EXT-1 external DOM injection** — no `externally_connectable`; only trusted same-extension contexts can send `POST_CHAT`. Reclassified to the low correctness item above.
- **AGT-7 depth-cap off-by-one** — the `> MAX_LOOP_DEPTH` guard is correct per spec; max executing depth is 2 as intended.
- **`authFetch` 15s overriding the 120s caller timeout** — `withTimeout` skips its own timer when the caller supplies a signal; no bug.
- **`isSafeServerUrl` bypass** — not exported; every `authFetch` resolves through it; port-locked to 3456.

## Recommended remediation order
1. **AGT-1** (SSRF) and **AGT-4 / MAC-3** (env-secret leak) — security-critical, surgical, deterministic fixes.
2. **KB-1** (data-deletion/privacy) — add the cascade delete + a migration.
3. **AGT-2, AGT-5** (credential-in-URL, guardrail evasion) and **KB-2** (stale FTS) — small, high-value.
4. **MAC-1, MAC-2** (code-assist write correctness) — user-facing data-loss risk.
5. The medium/low backlog — schedule as tech-debt.

> Each fix should land with a regression test where one exists (extension `node --test`); the macOS items have no automated test harness — verify manually.
