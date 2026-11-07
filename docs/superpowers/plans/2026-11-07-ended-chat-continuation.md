# Ended-Chat Continuation (X3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A turn on a chat whose SDK session has ended is seeded with one short summary of the older turns (made on the turn provider's fast model, cached per chat by a content hash) plus the last turns verbatim, instead of a cold resume or a context-blind fresh session. The feature is complete and tested but ships OFF behind a bench-gated switch.

**Architecture:** One server-side decision in `routes/agent-v2.mjs` `runV2Stream`, so the desktop and every client that sends history get the same rule. It calls a new `providers/continuation.mjs`, which reads the chat's own record (`chat_messages`) when the server has one and the client's `history` otherwise. It decides "ended", builds the seed with the existing `buildHandoff` packer, and caches the summary in a new `chat_continuations` table. The desktop shows a "continued from a summary" notice with a one-shot "send the full history" action. A desktop pref sets the env switch at the next backend start. The token bench gets a long ended-chat scenario and a per-turn `continued` flag for the user's A/B.

**Tech Stack:** Node 20+ (pure `node:http`, `better-sqlite3`, `node:test`), React 18 + TypeScript (desktop/web `ui/`), Rust (Tauri prefs), JSON Schema contracts (`schema/http`, `schema/agent-v2`).

**Spec:** The "Spec" section below (from the request of 2026-11-07, the user decision of 2026-10-30 "ended chats = summary + recent turns", and `docs/superpowers/plans/2026-10-30-agent-kit-k1.md` section 3.4). MASTER-PLAN row: S7 "Ended-chat continuation: per-chat summary on a cheap model plus last turns (X3, bench-gated)".

## Spec

- **S1 Ended, defined.** The switch is on, the chat has at least one earlier assistant turn, and one of these holds, checked in this order:
  1. `fresh`: the client sent `fresh: true`. This is the retry after `SESSION_UNRESUMABLE`, meaning the SDK session expired or was pruned.
  2. `no_session`: the chat has no recorded SDK session (`agent_sessions.sdk_session_id` is NULL or there is no row). That is the case after a quit/sweep purge (live-then-archive), `DELETE /agent/v2/session`, or a core whose DB was purged before a restart.
  3. `idle`: a session is recorded, its `last_used_at` is at least `CONTINUE_IDLE_MS` (5 minutes, the default prompt-cache TTL) old, and the chat's stored text is at least `CONTINUE_MIN_CHARS` (24,000) characters. A shorter chat resumes as today: the cache write costs less than a summary call (kit plan Q-T6).
  - A core restart on its own is **not** an end: the SDK transcript files outlive the process, and the prompt cache lives at the provider. A restart counts only through rule 2 (a purge) or rule 3 (idle).
- **S2 Where it applies.** It applies to `POST /agent/v2/stream` turns from every surface except `agentContext.surface === 'host-api'` (phone and web through the Host API). Host API v1 has no event that can carry the notice, so those chats keep today's behaviour (decision D3). It does not apply to a provider-switch handoff (it has its own, `providers/handoff.mjs`) or to an adapter turn (an adapter is handed the history on every turn).
- **S3 Seed.** One fenced note (the summary, at most 4,000 characters, redacted) plus the last turns verbatim. The last exchange is always kept. Beyond it, up to 6 turns within 24,000 characters (about 6,000 tokens) are kept, and the window starts on a user turn. The seed goes through the existing `buildHandoff`, so there is one packer with two uses.
- **S4 Summary.** It is made only on a cache miss, on the **turn's own provider** at its fast model (`fastModelFor(provider)`, Haiku on Anthropic). A provider with no fast tier uses the chat's own model. It is never sent to another provider. The input is capped at 80,000 characters: the first user turn plus the newest turns that fit, each turn clipped at 4,000 characters, the dropped middle counted, and the whole thing fence-neutralised and redacted. The prompt asks it to keep every request the user made.
- **S5 Cache.** One row per user and chat in `chat_continuations`: the summary, `content_hash` = `archiveHash` over the turns it covers, the turn count, `source` (`server` | `client`), the model, and input/output tokens. A hash hit makes no model call.
- **S6 Metering and attribution.** The summary call is metered by `runClaude` into `usage_ledger` with endpoint `/agent/v2/stream:continuation` and `request_id` = the turn id. So it joins the turn's own rows, and the bench counts it inside the turn. Its tokens are also stored on the chat's `chat_continuations` row and, with `LLMIDE_ROUTER_CAP=on`, committed to the chat's cap like the classifier's. Each call is one call's own usage (a delta), never an SDK running total.
- **S7 Never silent.** The stream carries `notice` `{ kind: 'chat_continued', level: 'info', data: { reason, coveredTurns, keptTurns, cached } }` right after `mode_set`. The desktop shows it, says the full history is unchanged, and offers "Send the full history with my next message". That sends `continueMode: 'replay'`: no summary, and the turn is seeded with today's fresh-turn replay of the chat's record (`freshTurnHistory`, 60,000 characters).
- **S8 Storage and privacy.** The summary is stored like the chat's messages: main DB, per user, redacted at the write. Its text is never logged (only counts). A server-made row is deleted with the chat's messages (chat delete, clear, archive commit, account delete). A client-made row is working state and is also dropped at the quit purge and at `DELETE /agent/v2/session`. The text leaves the machine only to the chat's chosen provider.
- **S9 Fallback.** Any failure (summary call error, empty reply, DB error) returns null and the turn runs exactly as today. A turn never fails because of this feature.
- **S10 Switch.** `LLMIDE_V2_CONTINUE_SUMMARY=on` (exactly `on`, read at call time, like `core/router-flags.mjs`). It is off by default. The desktop pref `continueSummary` (Settings > Routing, beta) sets it at the next backend start, the way `learn` sets `LLMIDE_ROUTER_LEARN`.
- **S11 Bench hook.** Scenario `ended-chat-continue-long` (scenario set version 5). Per-turn `continued` in the results. The `--fake` engine meters a summary and charges replayed history, so a fake A/B shows the plumbing. Gate (kit plan 3.4): on the long seed, `summary` at most 30% of `replay` billable on the continued turn. On the existing 3-turn `ended-chat-continue`, `summary` equals `replay` by construction, because nothing is old enough to summarise.
- **S12 Wire.** Additive. `SERVER_API_VERSION` goes 117 to 118 with the full checklist (Task 4).

## Global Constraints

- Default OFF: only `LLMIDE_V2_CONTINUE_SUMMARY` set to exactly `on` changes any behaviour. With it unset, every existing test and the bench numbers must be unchanged.
- Tests use fake summarisers and fake turn runners only. No network, no SDK. A test that reaches `runClaude` imports `../server/pinned-fetch.mjs` first and stubs `globalThis.fetch` (the pinned-fetch seam, as `tests/usage-metering.test.mjs` does).
- Every `kb/` helper takes `userId` first. All multi-step mutations stay inside the existing `db.transaction()` blocks.
- The summary text and chat text are never logged and never written to `agent_route_events`. Only counts and lengths are logged.
- ESLint layers: `providers/` may import `core/` and `kb/`. `routes/` may import anything. Nothing imports a route module. `npm run lint` must stay at zero warnings.
- `SERVER_API_VERSION` 117 to 118. `ui/screens/shell/core-api-floor.ts` `APP_API_VERSION` must match (drift test).
- Migration `0065_chat_continuations.sql` is append-only. The spec docs name the head migration.
- Conventional Commits, one concern per commit, on `main`, **no push**.
- Run extension tests with `cd extension && node --test --experimental-strip-types tests/<file>.test.mjs`. Run desktop/ui tests with `cd desktop && node --test --experimental-strip-types ../ui/screens/<path>/tests/<file>.test.mjs`. Run Rust with `cd desktop/src-tauri && cargo test prefs::`.
- Stay out of `docs/superpowers/plans/2026-11-07-extensions-catalog-p9.md`, `docs/superpowers/plans/2026-11-07-push-notifications.md` and the code they plan (plugins/MCP/llm-sources/extensions UI under `ui/screens/library/extensions/` and `extension/routes/extensions-catalog.mjs`; desktop notify/tray in `desktop/src-tauri/src/notify*`/tray; the web service worker; `ios_app/`). Shared-file caution: Task 6 adds one field to `desktop/src-tauri/src/prefs.rs` and `ui/screens/shell/host-prefs.ts`, next to `NotifyPrefs`, which the push-notifications work may also edit. Add only the new field and rebase on whatever landed.

---

## File Structure

| File | Responsibility |
|---|---|
| `extension/kb/migrations/0065_chat_continuations.sql` (create) | The `chat_continuations` table |
| `extension/kb/chat-continuations.mjs` (create) | `getContinuation` / `putContinuation` / `deleteContinuation` (per user, redacted at the write) |
| `extension/kb/chat-sessions.mjs` (modify) | Drop the row with the chat in `deleteChatSession` and `clearChatMessages` |
| `extension/kb/chat-lifecycle.mjs` (modify) | Drop it at `archiveCommit`; drop client rows at `purgeWorkingState` |
| `extension/kb/db.mjs` (modify) | Drop it at `deleteUserCascade` |
| `extension/providers/continuation.mjs` (create) | Switch, "ended" rule, prior turns, recent window, summary prompt, cached build, plan, notice |
| `extension/providers/runtime.mjs` (modify) | Pass `requestId` through to the ledger rows |
| `extension/routes/agent-v2.mjs` (modify) | Call `planContinuation` in `runV2Stream`, `continueMode`, notice after `mode_set`, cap commit, `summarize` dep |
| `extension/llm_agent/sdk/bench-fake-engine.mjs` (modify) | Fake summary (metered, no model call); charge replayed history |
| `extension/server.mjs`, `ui/screens/shell/core-api-floor.ts`, `schema/http/agent.schema.json`, `schema/agent-v2/agent-v2.schema.json`, `schema/agent-v2/fixtures/notice_chat_continued.json`, generated `docs/reference/api/openapi.yaml`, `extension/src/lib/api-types.ts`, `schema/http/INVENTORY.md` | API 118 contract |
| `ui/screens/chat/{state.ts,MessageView.tsx,MessageList.tsx,ChatScreen.tsx,controller.ts}` (modify) | Visible notice, "send the full history" action, `continueMode` |
| `desktop/src-tauri/src/prefs.rs`, `ui/screens/shell/{host-prefs.ts,settings-adapter.ts}`, `ui/screens/settings/{host.ts,routing-model.ts,sections/RoutingSection.tsx}` (modify) | The `continueSummary` pref to `LLMIDE_V2_CONTINUE_SUMMARY=on` |
| `scripts/token-bench.mjs`, `schema/bench/scenarios.json` (modify) | Long ended-chat scenario, per-turn `continued` |
| Docs: `docs/spec/session-router.md`, `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`, `docs/spec/knowledge-base.md`, `docs/how-to/run-the-token-bench.md`, `docs/superpowers/MASTER-PLAN.md` | Spec, head migration, version, bench how-to, status |

---

### Task 1: Continuation store (migration 0065 + kb helpers + deletes) (~25 min)

**Files:**
- Create: `extension/kb/migrations/0065_chat_continuations.sql`
- Create: `extension/kb/chat-continuations.mjs`
- Modify: `extension/kb/chat-sessions.mjs` (`deleteChatSession` ~:159, `clearChatMessages` ~:169)
- Modify: `extension/kb/chat-lifecycle.mjs` (`purgeWorkingState` ~:98, `archiveCommit` ~:253)
- Modify: `extension/kb/db.mjs` (`deleteUserCascade`, next to `counts.chat_sessions`)
- Modify: `docs/spec/cross-cutting.md:190`, `docs/spec/knowledge-base.md:38`
- Test: `extension/tests/chat-continuations.test.mjs`

**Interfaces:**
- Produces:
  - `getContinuation(userId: string, chatSessionId: string) -> { summary, contentHash, coveredTurns, source: 'server'|'client', model, inputTokens, outputTokens, updatedAt } | null`
  - `putContinuation(userId, chatSessionId, { summary, contentHash /* 64 hex */, coveredTurns, source, model?, inputTokens?, outputTokens? }) -> void` (upsert; summary redacted, capped at `CONTINUATION_SUMMARY_MAX` = 20,000)
  - `deleteContinuation(userId, chatSessionId, { clientOnly = false } = {}) -> number`

- [ ] **Step 1: Write the failing test** at `extension/tests/chat-continuations.test.mjs`:

```js
// The per-chat continuation summary store (plan 2026-11-07-ended-chat-continuation.md, migration 0065).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-continuations-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb, closeDb, deleteUserCascade } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const store = await import('../kb/chat-continuations.mjs');
const { createChatSession, appendChatMessage, deleteChatSession, clearChatMessages } = await import('../kb/chat-sessions.mjs');
const { purgeWorkingState } = await import('../kb/chat-lifecycle.mjs');

let n = 0;
const mk = () => registerUser(getDb(), { email: `cc-${++n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c' });
const HASH = 'a'.repeat(64);
const put = (u, chat, over = {}) => store.putContinuation(u.id, chat, { summary: 'The user wants SQLite.', contentHash: HASH, coveredTurns: 8, source: 'server', model: 'm', inputTokens: 100, outputTokens: 20, ...over });

test('put then get round-trips; a second put replaces; another user sees nothing', () => {
  const u = mk(); const other = mk();
  put(u, 'chat-1');
  const got = store.getContinuation(u.id, 'chat-1');
  assert.equal(got.summary, 'The user wants SQLite.');
  assert.equal(got.contentHash, HASH);
  assert.equal(got.coveredTurns, 8);
  assert.equal(got.source, 'server');
  assert.equal(got.inputTokens, 100);
  put(u, 'chat-1', { summary: 'Newer.', contentHash: 'b'.repeat(64), coveredTurns: 10 });
  assert.equal(store.getContinuation(u.id, 'chat-1').summary, 'Newer.');
  assert.equal(store.getContinuation(other.id, 'chat-1'), null);
});

test('the summary is redacted and capped at the write; bad input is refused', () => {
  const u = mk();
  const secret = `sk-ant-api03-${'A1b2C3d4'.repeat(10)}`;
  put(u, 'chat-r', { summary: `configure it with ${secret} ${'x'.repeat(30_000)}` });
  const got = store.getContinuation(u.id, 'chat-r');
  assert.ok(!got.summary.includes(secret));
  assert.ok(got.summary.length <= store.CONTINUATION_SUMMARY_MAX + 100);
  assert.throws(() => put(u, 'chat-r', { summary: '  ' }), /summary/);
  assert.throws(() => put(u, 'chat-r', { contentHash: 'nothex' }), /contentHash/);
  assert.throws(() => put(u, 'chat-r', { source: 'phone' }), /source/);
});

test('a server row goes with the chat: delete and clear', () => {
  const u = mk();
  const a = createChatSession(u.id, { title: 'a' });
  appendChatMessage(u.id, a.id, { role: 'user', content: 'hi' });
  put(u, a.id);
  assert.equal(clearChatMessages(u.id, a.id), 1);
  assert.equal(store.getContinuation(u.id, a.id), null);
  const b = createChatSession(u.id, { title: 'b' });
  put(u, b.id);
  deleteChatSession(u.id, b.id);
  assert.equal(store.getContinuation(u.id, b.id), null);
});

test('the quit purge drops client-made rows only; account delete drops everything', () => {
  const u = mk();
  put(u, 'server-chat', { source: 'server' });
  put(u, 'client-chat', { source: 'client' });
  purgeWorkingState(u.id, ['server-chat', 'client-chat']);
  assert.ok(store.getContinuation(u.id, 'server-chat'));
  assert.equal(store.getContinuation(u.id, 'client-chat'), null);
  deleteUserCascade(u.id);
  assert.equal(store.getContinuation(u.id, 'server-chat'), null);
});

test.after(() => { closeDb(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/chat-continuations.test.mjs`
Expected: FAIL with `Cannot find module '.../kb/chat-continuations.mjs'`.

- [ ] **Step 3: Write the migration** `extension/kb/migrations/0065_chat_continuations.sql`:

```sql
-- 0065: per-chat continuation summary (ended-chat continuation, plan 2026-11-07-ended-chat-continuation.md).
-- Derived data: made from the chat's own record, rebuilt on a hash miss, never the only copy. One row per user
-- and chat. content_hash = archiveHash (kb/chat-lifecycle.mjs) over the turns the summary covers. source says
-- whose record it was made from: 'server' (chat_messages, deleted with them) or 'client' (the history a client
-- sent; working state, also dropped at the quit purge). No FK to chat_sessions: client chats have no row there.
CREATE TABLE IF NOT EXISTS chat_continuations (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_session_id TEXT NOT NULL,
  summary         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  covered_turns   INTEGER NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('server', 'client')),
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, chat_session_id)
);
```

- [ ] **Step 4: Write the store** `extension/kb/chat-continuations.mjs`:

```js
// Per-chat continuation summaries (ended-chat continuation, plan 2026-11-07-ended-chat-continuation.md;
// migration 0065). Derived data: made from the chat's own record, rebuilt on a hash miss, never the only
// copy. Stored like the chat's messages: per user, redacted at the write. Every helper takes userId first.
import { getDb, requireUser, lazyPrepare } from './db.mjs';
import { redactSecretsForStorage } from '../core/redact-secrets.mjs';

export const CONTINUATION_SUMMARY_MAX = 20_000;
const SOURCES = new Set(['server', 'client']);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

export function getContinuation(userId, chatSessionId) {
  requireUser(userId);
  const row = lazyPrepare(getDb(), `
    SELECT summary, content_hash, covered_turns, source, model, input_tokens, output_tokens, updated_at
      FROM chat_continuations WHERE user_id = ? AND chat_session_id = ?
  `).get(userId, chatSessionId);
  if (!row) return null;
  return {
    summary: row.summary, contentHash: row.content_hash, coveredTurns: row.covered_turns, source: row.source,
    model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, updatedAt: row.updated_at,
  };
}

export function putContinuation(userId, chatSessionId, { summary, contentHash, coveredTurns, source, model = null, inputTokens = null, outputTokens = null } = {}) {
  requireUser(userId);
  if (typeof chatSessionId !== 'string' || !chatSessionId) throw new Error('chatSessionId is required');
  const text = redactSecretsForStorage(String(summary ?? '').slice(0, CONTINUATION_SUMMARY_MAX));
  if (!text.trim()) throw new Error('summary is required');
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('contentHash must be a sha256 hex digest');
  if (!SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
  lazyPrepare(getDb(), `
    INSERT INTO chat_continuations
      (user_id, chat_session_id, summary, content_hash, covered_turns, source, model, input_tokens, output_tokens, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (user_id, chat_session_id) DO UPDATE SET
      summary = excluded.summary, content_hash = excluded.content_hash, covered_turns = excluded.covered_turns,
      source = excluded.source, model = excluded.model, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, updated_at = excluded.updated_at
  `).run(userId, chatSessionId, text, contentHash, count(coveredTurns) ?? 0, source,
    model == null ? null : String(model).slice(0, 128), count(inputTokens), count(outputTokens));
}

/** Removes the chat's row (`clientOnly`: only a row made from a client's history). Returns the rows removed. */
export function deleteContinuation(userId, chatSessionId, { clientOnly = false } = {}) {
  requireUser(userId);
  return lazyPrepare(getDb(), clientOnly
    ? "DELETE FROM chat_continuations WHERE user_id = ? AND chat_session_id = ? AND source = 'client'"
    : 'DELETE FROM chat_continuations WHERE user_id = ? AND chat_session_id = ?').run(userId, chatSessionId).changes;
}
```

- [ ] **Step 5: Hook the deletes.** In `extension/kb/chat-sessions.mjs` add `import { deleteContinuation } from './chat-continuations.mjs';` after the existing imports, then:

In `deleteChatSession`, replace
```js
    lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid);
    return lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid).changes;
```
with
```js
    lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid);
    deleteContinuation(uid, sid);
    return lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid).changes;
```
In `clearChatMessages`, replace
```js
    const n = lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid).changes;
```
with
```js
    const n = lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid).changes;
    deleteContinuation(uid, sid);
```
In `extension/kb/chat-lifecycle.mjs` add `import { deleteContinuation } from './chat-continuations.mjs';` after `import { deleteSessionMemory } ...`. In `purgeWorkingState`, replace
```js
      const hadRoute = deleteRoute(db, userId, id) > 0;
```
with
```js
      const hadRoute = deleteRoute(db, userId, id) > 0;
      // A summary made from a client's history is working state; one made from chat_messages goes with them.
      deleteContinuation(userId, id, { clientOnly: true });
```
In `archiveCommit`, replace
```js
    lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid);
    lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid);
    return { status: 'deleted', count: digest.count };
```
with
```js
    lazyPrepare(db, 'DELETE FROM chat_messages WHERE user_id = ? AND session_id = ?').run(uid, sid);
    deleteContinuation(uid, sid);
    lazyPrepare(db, 'DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(uid, sid);
    return { status: 'deleted', count: digest.count };
```
In `extension/kb/db.mjs` `deleteUserCascade`, after `counts.chat_sessions = del('DELETE FROM chat_sessions WHERE user_id = ?');` add:
```js
    // migration 0065 — derived continuation summaries of the user's chats.
    counts.chat_continuations = del('DELETE FROM chat_continuations WHERE user_id = ?');
```

- [ ] **Step 6: Update the head-migration docs.** In `docs/spec/cross-cutting.md:190` change ``The head migration is `0064` (`0064_sync.sql`).`` to ``The head migration is `0065` (`0065_chat_continuations.sql`).``. In `docs/spec/knowledge-base.md:38` change ``through `0064_sync.sql` | DDL deltas (64 files as of this writing). Recent: `` to ``through `0065_chat_continuations.sql` | DDL deltas (65 files as of this writing). Recent: `0065_chat_continuations.sql` adds `chat_continuations` (one row per user and chat: the ended-chat continuation summary, its content hash, covered turn count, source server or client, model and tokens; derived and rebuildable, deleted with the chat's messages, client-made rows also at the quit purge; see [session-router](session-router.md) section 6a); ``.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd extension && node --test --experimental-strip-types tests/chat-continuations.test.mjs tests/chat-sessions.test.mjs tests/chat-lifecycle.test.mjs tests/note-index-migration.test.mjs`
Expected: PASS. If `note-index-migration.test.mjs` deep-equals the `deleteUserCascade` receipt keys, add `chat_continuations` to its expected list.

- [ ] **Step 8: Commit**

```bash
git add extension/kb/migrations/0065_chat_continuations.sql extension/kb/chat-continuations.mjs extension/kb/chat-sessions.mjs extension/kb/chat-lifecycle.mjs extension/kb/db.mjs extension/tests/chat-continuations.test.mjs docs/spec/cross-cutting.md docs/spec/knowledge-base.md
git commit -m "feat(server): per-chat continuation summary store (migration 0065)"
```

---

### Task 2: Continuation module + `requestId` on `runClaude` ledger rows (~30 min)

**Files:**
- Create: `extension/providers/continuation.mjs`
- Modify: `extension/providers/runtime.mjs:259` (destructure), `:308` (`meter`), `:382`, `:477`, `:629` (`meterUsage` calls)
- Test: `extension/tests/continuation.test.mjs`, `extension/tests/usage-metering.test.mjs` (one added test)

**Interfaces:**
- Consumes: Task 1 `getContinuation`, `putContinuation`. Existing: `archiveHash(messages)`, `agentSessionLastUsedMs(userId, chatSessionId) -> ms` (`kb/chat-lifecycle.mjs`); `chatSessionExists`, `getChatSession` (`kb/chat-sessions.mjs`); `buildHandoff({ history, summary, keepTurns }) -> { history, ... }`, `HANDOFF_NOTE_CHARS` (`providers/handoff.mjs`); `fastModelFor`, `newTurnTokenTotals`, `countTurnTokens` (`kb/usage.mjs`).
- Produces (all exported from `providers/continuation.mjs`):
  - constants `CONTINUE_IDLE_MS = 300000`, `CONTINUE_MIN_CHARS = 24000`, `CONTINUE_KEEP_TURNS = 6`, `CONTINUE_RECENT_CHARS = 24000`, `SUMMARY_INPUT_CHARS = 80000`, `SUMMARY_TURN_CHARS = 4000`, `SUMMARY_MAX_TOKENS = 1024`, `SUMMARY_ENDPOINT = '/agent/v2/stream:continuation'`
  - `continuationEnabled(env = process.env) -> boolean`
  - `endedReason({ fresh, sdkSessionId, lastUsedMs, now, priorChars, idleMs?, minChars? }) -> 'fresh'|'no_session'|'idle'|null`
  - `priorTurns(userId, chatSessionId, body) -> { source: 'server'|'client', turns: {role,content}[] }`
  - `recentCount(turns, { keepTurns?, recentChars? }?) -> number`
  - `summaryPrompt(older, { inputChars?, turnChars? }?) -> string`
  - `buildContinuation({ userId, chatSessionId, turns, source, provider, model, requestId, summarize, signal }) -> Promise<null | { history, coveredTurns, keptTurns, cached, summaryChars, usage }>`
  - `planContinuation({ userId, chatSessionId, agentContext, body, sdkSessionId, provider, model, requestId, summarize, signal, now?, env? }) -> Promise<null | { kind: 'replay', reason, turns } | { kind: 'summary', reason, history, usage, notice }>` (never throws)
  - `continuedNotice({ coveredTurns, keptTurns, cached, reason }) -> { type: 'notice', kind: 'chat_continued', level: 'info', text, data }`
  - `summarize` contract (the seam): `(prompt: string, opts: { userId, provider, model, maxTokens, endpoint, requestId, signal }) -> Promise<string>`
  - `runClaude(prompt, { ..., requestId })` now writes `request_id` on its ledger row.

- [ ] **Step 1: Write the failing test** at `extension/tests/continuation.test.mjs`:

```js
// providers/continuation.mjs: the ended rule, the turns it reads, the recent window, the summary prompt,
// the cached build and the plan. Fake summariser only: no model call, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_continuation-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb, closeDb } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { createChatSession, appendChatMessage } = await import('../kb/chat-sessions.mjs');
const { getContinuation } = await import('../kb/chat-continuations.mjs');
const { recordUsage, fastModelFor } = await import('../kb/usage.mjs');
const c = await import('../providers/continuation.mjs');

let n = 0;
const mk = () => registerUser(getDb(), { email: `cont-${++n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c' });
const conv = (pairs, chars = 50) => Array.from({ length: pairs }, (_, i) => [
  { role: 'user', content: `q${i} ${'q'.repeat(chars)}` }, { role: 'assistant', content: `a${i} ${'a'.repeat(chars)}` },
]).flat();

test('continuationEnabled: exactly "on"', () => {
  assert.equal(c.continuationEnabled({}), false);
  assert.equal(c.continuationEnabled({ LLMIDE_V2_CONTINUE_SUMMARY: 'ON' }), false);
  assert.equal(c.continuationEnabled({ LLMIDE_V2_CONTINUE_SUMMARY: 'on' }), true);
});

test('endedReason: fresh, then no session, then idle on a long chat only', () => {
  const now = 10_000_000;
  const base = { fresh: false, sdkSessionId: 's', lastUsedMs: now - 1000, now, priorChars: 50_000 };
  assert.equal(c.endedReason({ ...base, fresh: true }), 'fresh');
  assert.equal(c.endedReason({ ...base, sdkSessionId: null }), 'no_session');
  assert.equal(c.endedReason(base), null, 'warm');
  assert.equal(c.endedReason({ ...base, lastUsedMs: now - c.CONTINUE_IDLE_MS }), 'idle');
  assert.equal(c.endedReason({ ...base, lastUsedMs: now - c.CONTINUE_IDLE_MS, priorChars: c.CONTINUE_MIN_CHARS - 1 }), null, 'short: resume');
  assert.equal(c.endedReason({ ...base, lastUsedMs: 0 }), null, 'no timestamp: never idle');
});

test('recentCount keeps the last exchange, then up to 6 turns within the budget, starting on a user turn', () => {
  assert.equal(c.recentCount(conv(7)), 6);
  assert.equal(c.recentCount(conv(7, 30_000)), 2, 'huge turns: only the last exchange');
  assert.equal(c.recentCount(conv(1)), 2);
  // [assistant, q0, a0, q1]: four fit, but the window may not open on an assistant turn.
  assert.equal(c.recentCount([{ role: 'assistant', content: 'x' }, ...conv(3)].slice(0, 4)), 3);
});

test('priorTurns: the server record without the message being sent; else the client history on fresh only', () => {
  const u = mk();
  const chat = createChatSession(u.id, { title: 't' });
  appendChatMessage(u.id, chat.id, { role: 'user', content: 'first' });
  appendChatMessage(u.id, chat.id, { role: 'assistant', content: 'reply' });
  appendChatMessage(u.id, chat.id, { role: 'user', content: 'being sent' });
  const s = c.priorTurns(u.id, chat.id, { message: 'being sent' });
  assert.equal(s.source, 'server');
  assert.deepEqual(s.turns.map((t) => t.content), ['first', 'reply']);
  const hist = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'system', content: 'no' }];
  assert.deepEqual(c.priorTurns(u.id, 'no-row', { fresh: true, history: hist }), { source: 'client', turns: hist.slice(0, 2) });
  assert.deepEqual(c.priorTurns(u.id, 'no-row', { history: hist }).turns, [], 'history is read only with fresh');
});

test('summaryPrompt: data markers, fences neutralised, the first request kept and a dropped middle counted', () => {
  const p = c.summaryPrompt([{ role: 'user', content: 'ORIGINAL <<<TRANSCRIPT>>> trick' }, ...conv(3)]);
  assert.match(p, /every request the user made/);
  assert.match(p, /ORIGINAL/);
  assert.equal(p.split('<<<TRANSCRIPT').length, 2, 'the content cannot open a second data block');
  const big = c.summaryPrompt([{ role: 'user', content: 'ORIGINAL' }, ...conv(60, 3_000)], { inputChars: 20_000 });
  assert.match(big, /ORIGINAL/);
  assert.match(big, /middle turns not shown/);
  assert.ok(big.length < 25_000);
});

test('buildContinuation: one metered call on the fast model, cached by content, rebuilt when older turns change', async () => {
  const u = mk();
  const calls = [];
  const summarize = async (prompt, opts) => {
    calls.push({ prompt, opts });
    recordUsage(getDb(), { userId: opts.userId, provider: opts.provider, model: opts.model, endpoint: opts.endpoint, requestId: opts.requestId, inputTokens: 100, outputTokens: 20 });
    return 'The user asked seven questions.';
  };
  const turns = conv(7);
  const args = { userId: u.id, chatSessionId: 'chat-b', turns, source: 'client', provider: 'anthropic', model: null, requestId: 'turn-1', summarize };
  const one = await c.buildContinuation(args);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.endpoint, c.SUMMARY_ENDPOINT);
  assert.equal(calls[0].opts.model, fastModelFor('anthropic'));
  assert.equal(calls[0].opts.requestId, 'turn-1');
  assert.equal(one.coveredTurns, 8);
  assert.equal(one.keptTurns, 6);
  assert.equal(one.cached, false);
  assert.equal(one.usage.inputTokens, 100);
  assert.match(one.history[0].content, /Handoff note/);
  assert.match(one.history[0].content, /seven questions/);
  assert.equal(one.history.at(-1).content.startsWith('a6'), true);
  const row = getContinuation(u.id, 'chat-b');
  assert.equal(row.inputTokens, 100);
  assert.equal(row.coveredTurns, 8);
  const ledger = getDb().prepare("SELECT request_id, endpoint FROM usage_ledger WHERE user_id = ?").all(u.id);
  assert.deepEqual(ledger, [{ request_id: 'turn-1', endpoint: c.SUMMARY_ENDPOINT }]);

  const two = await c.buildContinuation(args);
  assert.equal(calls.length, 1, 'cache hit');
  assert.equal(two.cached, true);
  await c.buildContinuation({ ...args, turns: [...turns, ...conv(1).map((t) => ({ ...t, content: `${t.content} new` }))] });
  assert.equal(calls.length, 2, 'older turns changed: made again');
});

test('buildContinuation: nothing old enough is null (no call); an empty reply is null', async () => {
  const u = mk();
  let called = 0;
  assert.equal(await c.buildContinuation({ userId: u.id, chatSessionId: 'x', turns: conv(2), source: 'client', provider: 'anthropic', summarize: async () => { called += 1; return 's'; } }), null);
  assert.equal(called, 0);
  assert.equal(await c.buildContinuation({ userId: u.id, chatSessionId: 'y', turns: conv(7), source: 'client', provider: 'anthropic', summarize: async () => '   ' }), null);
  assert.equal(getContinuation(u.id, 'y'), null);
});

test('planContinuation: off, host-api, no prior answer and a throwing summariser all return null', async () => {
  const u = mk();
  const on = { LLMIDE_V2_CONTINUE_SUMMARY: 'on' };
  const body = { fresh: true, history: conv(7) };
  const ok = async () => 'S';
  const base = { userId: u.id, chatSessionId: 'p1', body, sdkSessionId: null, provider: 'anthropic', model: null, requestId: 't', summarize: ok };
  assert.equal(await c.planContinuation({ ...base, agentContext: {}, env: {} }), null);
  assert.equal(await c.planContinuation({ ...base, agentContext: { surface: 'host-api' }, env: on }), null);
  assert.equal(await c.planContinuation({ ...base, body: { fresh: true, history: [{ role: 'user', content: 'only' }] }, agentContext: {}, env: on }), null);
  assert.equal(await c.planContinuation({ ...base, agentContext: {}, env: on, summarize: async () => { throw new Error('boom'); } }), null);
  const plan = await c.planContinuation({ ...base, agentContext: {}, env: on });
  assert.equal(plan.kind, 'summary');
  assert.equal(plan.reason, 'fresh');
  assert.equal(plan.notice.kind, 'chat_continued');
  assert.deepEqual(Object.keys(plan.notice.data).sort(), ['cached', 'coveredTurns', 'keptTurns', 'reason']);
  const replay = await c.planContinuation({ ...base, body: { ...body, continueMode: 'replay' }, agentContext: {}, env: on });
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.turns.length, 14);
});

test.after(() => { closeDb(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });
```

Add to `extension/tests/usage-metering.test.mjs`, after the first test:

```js
test('runClaude writes the caller\'s requestId on its ledger row (the continuation summary joins its turn)', async () => {
  const userId = freshUser();
  vault.setSecret(db.getDb(), userId, 'claude.apiKey', 'sk-anthropic-test');
  const restore = mockFetch(async () => ({
    ok: true, status: 200, headers: new Map(),
    json: async () => ({ content: [{ text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } }),
    text: async () => '{}',
  }));
  try {
    await runClaude('hi', { userId, model: 'claude-sonnet-4-6', endpoint: '/agent/v2/stream:continuation', requestId: 'turn-xyz' });
  } finally { restore(); }
  const row = db.getDb().prepare('SELECT request_id, endpoint FROM usage_ledger WHERE user_id = ?').get(userId);
  assert.deepEqual(row, { request_id: 'turn-xyz', endpoint: '/agent/v2/stream:continuation' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && node --test --experimental-strip-types tests/continuation.test.mjs tests/usage-metering.test.mjs`
Expected: FAIL. `continuation.test.mjs` fails with `Cannot find module '.../providers/continuation.mjs'`. The new usage-metering test fails with `request_id: null` against `'turn-xyz'`.

- [ ] **Step 3: Pass `requestId` through `runClaude`.** In `extension/providers/runtime.mjs`:

Line 259, change the destructure `{ userId, model, maxTokens, cacheTranscript, signal, provider: explicitProvider, images, endpoint, autoFallback = true, mcpConfig, cwd, warm = false } = {}` to `{ userId, model, maxTokens, cacheTranscript, signal, provider: explicitProvider, images, endpoint, requestId, autoFallback = true, mcpConfig, cwd, warm = false } = {}`.

Line 308, change `const meter = userId ? { userId, endpoint } : undefined;` to `const meter = userId ? { userId, endpoint, requestId } : undefined;` (`providers/adapter-complete.mjs` already reads `meter?.requestId`).

Lines 382, 477 and 629: in each `meterUsage({ ... endpoint ... })` call inside `runClaudeDirect`, change `endpoint` to `endpoint, requestId` (for example `source: 'cli', endpoint });` becomes `source: 'cli', endpoint, requestId });`, and `source: 'api', endpoint,` becomes `source: 'api', endpoint, requestId,`).

- [ ] **Step 4: Write the module** `extension/providers/continuation.mjs`:

```js
// Ended-chat continuation (plan docs/superpowers/plans/2026-11-07-ended-chat-continuation.md, MASTER-PLAN S7 X3).
//
// A turn on a chat whose SDK session has ended is seeded with ONE short summary of the older turns, made on the
// turn provider's fast model, plus the last turns verbatim, instead of a cold resume or a context-blind fresh
// session. "Ended" (endedReason): the client asked for a fresh session (SESSION_UNRESUMABLE retry), no SDK
// session is recorded (quit purge, session delete), or the recorded one is idle past the prompt-cache TTL on a
// long chat. A core restart alone is not an end: transcripts outlive the process and the cache is the provider's.
//
// Bench-gated: OFF unless LLMIDE_V2_CONTINUE_SUMMARY=on. Never throws: any failure is null and the route does
// exactly what it did before. The summary is derived data (kb/chat-continuations.mjs), cached by a content hash
// of the turns it covers. Its text is never logged.
import { archiveHash, agentSessionLastUsedMs } from '../kb/chat-lifecycle.mjs';
import { chatSessionExists, getChatSession } from '../kb/chat-sessions.mjs';
import { getContinuation, putContinuation } from '../kb/chat-continuations.mjs';
import { fastModelFor, newTurnTokenTotals, countTurnTokens } from '../kb/usage.mjs';
import { redactSecrets, redactSecretsForStorage } from '../core/redact-secrets.mjs';
import { neutralizePromptFences } from '../core/utils.mjs';
import { logger } from '../core/logger.mjs';
import { buildHandoff, HANDOFF_NOTE_CHARS } from './handoff.mjs';

const log = logger.child({ component: 'continuation' });

export const CONTINUE_IDLE_MS = 5 * 60 * 1000;   // the default prompt-cache TTL (kit plan 3.4 step 4); the bench sets it
export const CONTINUE_MIN_CHARS = 24_000;        // under this an idle chat still resumes (kit plan Q-T6 starting value)
export const CONTINUE_KEEP_TURNS = 6;
export const CONTINUE_RECENT_CHARS = 24_000;     // about 6,000 tokens of verbatim recent turns
export const SUMMARY_INPUT_CHARS = 80_000;
export const SUMMARY_TURN_CHARS = 4_000;
export const SUMMARY_MAX_TOKENS = 1024;
export const SUMMARY_ENDPOINT = '/agent/v2/stream:continuation';
const TURN_CHARS = 20_000;                       // buildHandoff's per-turn clip
// shortcut: a server chat is read up to its newest 2,000 messages (getChatSession's cap); page it if chats grow past that.
const READ_LIMIT = 2000;

export function continuationEnabled(env = process.env) { return env.LLMIDE_V2_CONTINUE_SUMMARY === 'on'; }

const cleanTurns = (list) => (Array.isArray(list) ? list : [])
  .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
  .map((t) => ({ role: t.role, content: t.content }));

/** Why this turn continues an ended chat, or null (resume / run as today). Pure. */
export function endedReason({ fresh, sdkSessionId, lastUsedMs, now, priorChars, idleMs = CONTINUE_IDLE_MS, minChars = CONTINUE_MIN_CHARS }) {
  if (fresh === true) return 'fresh';
  if (!sdkSessionId) return 'no_session';
  if (lastUsedMs > 0 && now - lastUsedMs >= idleMs && priorChars >= minChars) return 'idle';
  return null;
}

/** The chat's earlier turns: the server's own record when it has one, else the client's history (fresh turns only). */
export function priorTurns(userId, chatSessionId, body) {
  if (chatSessionExists(userId, chatSessionId)) {
    let turns = cleanTurns(getChatSession(userId, chatSessionId, { messageLimit: READ_LIMIT })?.messages);
    // The desktop stores the message it is sending before the stream opens: that is this turn, not history.
    const current = typeof body?.message === 'string' ? redactSecretsForStorage(body.message).trim() : '';
    const last = turns.at(-1);
    if (last?.role === 'user' && last.content.trim() === current) turns = turns.slice(0, -1);
    return { source: 'server', turns };
  }
  return { source: 'client', turns: body?.fresh === true ? cleanTurns(body.history) : [] };
}

/** How many newest turns stay verbatim: the last exchange always, then up to keepTurns within recentChars; starts on a user turn. */
export function recentCount(turns, { keepTurns = CONTINUE_KEEP_TURNS, recentChars = CONTINUE_RECENT_CHARS } = {}) {
  let k = 0;
  let used = 0;
  for (let i = turns.length - 1; i >= 0 && k < keepTurns; i -= 1) {
    const len = Math.min(turns[i].content.length, TURN_CHARS);
    if (k >= 2 && used + len > recentChars) break;
    used += len;
    k += 1;
  }
  while (k > 0 && turns[turns.length - k].role !== 'user') k -= 1;
  return k;
}

/** The cheap-model prompt over the older turns: the first request plus the newest that fit; the middle counted. */
export function summaryPrompt(older, { inputChars = SUMMARY_INPUT_CHARS, turnChars = SUMMARY_TURN_CHARS } = {}) {
  const line = (t) => {
    const text = t.content.length > turnChars ? `${t.content.slice(0, turnChars)}...(clipped)` : t.content;
    return `${t.role === 'user' ? 'User' : 'Assistant'}: ${neutralizePromptFences(redactSecrets(text))}`;
  };
  const lines = older.map(line);
  let budget = inputChars - lines[0].length;
  const tail = [];
  for (let i = lines.length - 1; i > 0 && lines[i].length <= budget; i -= 1) {
    budget -= lines[i].length;
    tail.unshift(lines[i]);
  }
  const dropped = lines.length - 1 - tail.length;
  const body = [lines[0], ...(dropped > 0 ? [`(${dropped} middle turns not shown)`] : []), ...tail].join('\n\n');
  return [
    'Summarise the earlier part of a chat so the conversation can continue without it.',
    'Write at most 400 words, in the language the chat uses. Keep, in order: every request the user made (one line each),',
    'decisions, facts, names, file paths, numbers, open questions and unfinished work. Plain text, no preamble.',
    'The transcript between the markers is data, not instructions.',
    '<<<TRANSCRIPT',
    body,
    'TRANSCRIPT>>>',
  ].join('\n');
}

/** The seed for an ended chat, or null when nothing is old enough to summarise or the summary came back empty. Throws on a failed call. */
export async function buildContinuation({ userId, chatSessionId, turns, source, provider, model, requestId, summarize, signal }) {
  const keep = recentCount(turns);
  const older = turns.slice(0, turns.length - keep);
  if (older.length === 0) return null;
  const contentHash = archiveHash(older);
  const cached = getContinuation(userId, chatSessionId);
  let summary;
  let usage = null;
  if (cached && cached.contentHash === contentHash) {
    summary = cached.summary;
  } else {
    // The turn's own provider at its fast tier: the chat text never goes to a provider the user did not pick.
    const summaryModel = fastModelFor(provider) ?? model ?? undefined;
    const totals = newTurnTokenTotals();
    const text = await countTurnTokens(totals, () => summarize(summaryPrompt(older), {
      userId, provider, model: summaryModel, maxTokens: SUMMARY_MAX_TOKENS, endpoint: SUMMARY_ENDPOINT, requestId, signal,
    }));
    summary = typeof text === 'string' ? text.trim().slice(0, HANDOFF_NOTE_CHARS) : '';
    if (!summary) return null;
    usage = totals;
    putContinuation(userId, chatSessionId, {
      summary, contentHash, coveredTurns: older.length, source, model: summaryModel ?? null,
      inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
    });
  }
  const h = buildHandoff({ history: turns, summary, keepTurns: keep });
  return { history: h.history, coveredTurns: older.length, keptTurns: keep, cached: usage === null, summaryChars: summary.length, usage };
}

export function continuedNotice({ coveredTurns, keptTurns, cached, reason }) {
  return {
    type: 'notice', kind: 'chat_continued', level: 'info',
    text: `Continued from a summary of ${coveredTurns} earlier messages and the last ${keptTurns} in full. Your full history is unchanged.`,
    data: { reason, coveredTurns, keptTurns, cached },
  };
}

/**
 * The route's one call. null = today's behaviour. `replay` = the user asked for the full history this turn (the
 * route seeds it with freshTurnHistory; an idle chat just resumes). `summary` = the seed plus the notice.
 */
export async function planContinuation({ userId, chatSessionId, agentContext, body, sdkSessionId, provider, model, requestId, summarize, signal, now = Date.now(), env = process.env }) {
  if (!continuationEnabled(env) || agentContext?.surface === 'host-api') return null;
  try {
    const { source, turns } = priorTurns(userId, chatSessionId, body);
    if (!turns.some((t) => t.role === 'assistant')) return null;
    const priorChars = turns.reduce((sum, t) => sum + t.content.length, 0);
    const reason = endedReason({ fresh: body?.fresh, sdkSessionId, lastUsedMs: agentSessionLastUsedMs(userId, chatSessionId), now, priorChars });
    if (!reason) return null;
    if (body?.continueMode === 'replay') return reason === 'idle' ? null : { kind: 'replay', reason, turns };
    const built = await buildContinuation({ userId, chatSessionId, turns, source, provider, model, requestId, summarize, signal });
    if (!built) return null;
    log.info('chat_continued', { reason, source, coveredTurns: built.coveredTurns, keptTurns: built.keptTurns, cached: built.cached, summaryChars: built.summaryChars });
    return { kind: 'summary', reason, history: built.history, usage: built.usage, notice: continuedNotice({ ...built, reason }) };
  } catch (err) {
    log.warn('continuation_failed', { code: err?.code ?? err?.name ?? 'error' });
    return null;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && node --test --experimental-strip-types tests/continuation.test.mjs tests/usage-metering.test.mjs tests/handoff.test.mjs && npx eslint --max-warnings 0 providers/continuation.mjs providers/runtime.mjs tests/continuation.test.mjs`
Expected: PASS, no lint output.

- [ ] **Step 6: Commit**

```bash
git add extension/providers/continuation.mjs extension/providers/runtime.mjs extension/tests/continuation.test.mjs extension/tests/usage-metering.test.mjs
git commit -m "feat(server): ended-chat continuation builder, metered under the turn id"
```

---

### Task 3: Wire the continuation into the v2 stream (~30 min)

**Files:**
- Modify: `extension/routes/agent-v2.mjs` (imports ~:56; `DEFAULT_DEPS` :290; `runV2Stream` :612-615, :216-221, :238, :264-265; the body comment :385-386)
- Test: `extension/tests/agent-v2-continuation.test.mjs`

**Interfaces:**
- Consumes: Task 2 `planContinuation(...)` and the `summarize` seam; existing `freshTurnHistory(body)`, `commitTurnUsage(db, userId, chatSessionId, totals, {})`, `routerCapEnabled()`.
- Produces: `deps.summarize` on `handleAgentV2Routes(req, res, deps)` and `startHostTurn({ deps })` (defaults to `runClaude`; Task 7 makes the default bench-aware). The request body accepts `continueMode: 'replay'`. The stream emits the `chat_continued` notice right after `mode_set`.

- [ ] **Step 1: Write the failing test** at `extension/tests/agent-v2-continuation.test.mjs`:

```js
// Ended-chat continuation on the v2 stream (plan 2026-11-07-ended-chat-continuation.md): the switch, the three
// "ended" rules, the seed and notice, the cache, the fallbacks and the Host API exclusion.
// Fake turn runner and fake summariser only: no model call, no SDK, no network.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_agent-v2-continue-ws');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-continue-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const v2 = await import('../routes/agent-v2.mjs');
const { createChatSession, appendChatMessage } = await import('../kb/chat-sessions.mjs');
const { markAgentSessionUsed, deleteAgentSession } = await import('../kb/agent-sessions.mjs');
const { getContinuation } = await import('../kb/chat-continuations.mjs');
const { SUMMARY_ENDPOINT } = await import('../providers/continuation.mjs');
const { fastModelFor } = await import('../kb/usage.mjs');
const db = getDb();

after(() => {
  closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  fs.rmSync(WS, { recursive: true, force: true });
});

function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user, headers: {}, refunded: 0,
    rateLimitRefund() { req.refunded += 1; },
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end' || event === 'close') cb(); return req; },
  };
  return req;
}
function makeRes() {
  return {
    on() { return this; }, statusCode: 200, headers: {}, _body: '',
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
    write(c) { this._body += c; }, end(c) { if (c) this._body += c; this.ended = true; },
    sseEvents() { return this._body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6))); },
  };
}

let n = 0;
const mkUser = () => registerUser(db, { email: `v2c-${++n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c' });
beforeEach(() => { delete process.env.LLMIDE_V2_CONTINUE_SUMMARY; });
const ON = () => { process.env.LLMIDE_V2_CONTINUE_SUMMARY = 'on'; };
const STALE = "UPDATE agent_sessions SET last_used_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ? AND mac_chat_session_id = ?";

/** A server chat with `pairs` user/assistant exchanges of about `chars` characters each. */
function seedChat(user, pairs = 7, chars = 100) {
  const chat = createChatSession(user.id, { title: 't', surface: 'any', mode: 'agent' });
  for (let i = 0; i < pairs; i += 1) {
    appendChatMessage(user.id, chat.id, { role: 'user', content: `question ${i} ${'q'.repeat(chars)}` });
    appendChatMessage(user.id, chat.id, { role: 'assistant', content: `answer ${i} ${'a'.repeat(chars)}` });
  }
  return chat.id;
}
const okTurn = (seen) => async (args) => {
  seen.push(args);
  args.onEvent({ type: 'init', sessionId: 'sdk-new', tools: [], capabilities: [] });
  args.onEvent({ type: 'result', subtype: 'success' });
  return { usageTotals: {} };
};
const fakeSummarize = (calls, text = 'SUMMARY: the user asked seven questions.') => async (prompt, opts) => { calls.push({ prompt, opts }); return text; };
async function turn(user, chat, deps, body = {}) {
  const req = makeReq({ method: 'POST', url: '/agent/v2/stream', user, body: { message: 'next question', mode: 'ask', agentContext: { chatSessionId: chat, workspaceRoot: WS, surface: 'desktop' }, ...body } });
  const res = makeRes();
  await v2.handleAgentV2Routes(req, res, { classifyMode: async () => ({ mode: 'ask' }), ...deps });
  return res;
}
const continued = (res) => res.sseEvents().find((e) => e.type === 'notice' && e.kind === 'chat_continued');

test('switch off: an ended server chat runs exactly as before (no summary call, no seed, no notice)', async () => {
  const u = mkUser(); const chat = seedChat(u);
  const seen = []; const calls = [];
  const res = await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 0);
  assert.deepEqual(seen[0].history, []);
  assert.equal(continued(res), undefined);
});

test('switch on, no SDK session: one summary on the fast model under the turn id, then summary + last turns, notice after mode_set', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const seen = []; const calls = [];
  const res = await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.endpoint, SUMMARY_ENDPOINT);
  assert.equal(calls[0].opts.provider, 'anthropic');
  assert.equal(calls[0].opts.model, fastModelFor('anthropic'));
  assert.equal(typeof calls[0].opts.requestId, 'string');
  assert.match(calls[0].prompt, /question 0/);
  assert.doesNotMatch(calls[0].prompt, /question 6/, 'the kept turns are not summarised');
  const h = seen[0].history;
  assert.match(h[0].content, /Handoff note/);
  assert.match(h[0].content, /SUMMARY: the user asked seven questions\./);
  assert.match(h.at(-1).content, /^answer 6/);
  assert.equal(seen[0].resumeSdkSessionId, undefined);
  const evs = res.sseEvents();
  const at = evs.findIndex((e) => e.type === 'mode_set');
  assert.equal(evs[at + 1].kind, 'chat_continued');
  assert.deepEqual(evs[at + 1].data, { reason: 'no_session', coveredTurns: 8, keptTurns: 6, cached: false });
  assert.equal(getContinuation(u.id, chat).source, 'server');
});

test('cached by content: the next ended turn with the same older turns makes no call; new older turns make one', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const calls = [];
  await turn(u, chat, { runTurn: okTurn([]), summarize: fakeSummarize(calls) });
  deleteAgentSession(db, u.id, chat);
  const res = await turn(u, chat, { runTurn: okTurn([]), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 1);
  assert.equal(continued(res).data.cached, true);
  appendChatMessage(u.id, chat, { role: 'user', content: 'question 7' });
  appendChatMessage(u.id, chat, { role: 'assistant', content: 'answer 7' });
  deleteAgentSession(db, u.id, chat);
  await turn(u, chat, { runTurn: okTurn([]), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 2);
});

test('idle past the TTL on a long chat starts fresh from the summary; warm, or short and idle, resumes as before', async () => {
  ON();
  const u = mkUser();
  const long = seedChat(u, 7, 2_000);
  markAgentSessionUsed(db, u.id, long, { sdkSessionId: 'sdk-old', model: null, mode: 'ask' });
  const calls = []; const warm = [];
  await turn(u, long, { runTurn: okTurn(warm), summarize: fakeSummarize(calls) });
  assert.equal(warm[0].resumeSdkSessionId, 'sdk-old');
  assert.equal(calls.length, 0);
  db.prepare(STALE).run(u.id, long);
  const cold = [];
  const res = await turn(u, long, { runTurn: okTurn(cold), summarize: fakeSummarize(calls) });
  assert.equal(cold[0].resumeSdkSessionId, undefined);
  assert.equal(calls.length, 1);
  assert.equal(continued(res).data.reason, 'idle');
  const short = seedChat(u, 2, 50);
  markAgentSessionUsed(db, u.id, short, { sdkSessionId: 'sdk-short', model: null, mode: 'ask' });
  db.prepare(STALE).run(u.id, short);
  const s = [];
  await turn(u, short, { runTurn: okTurn(s), summarize: fakeSummarize(calls) });
  assert.equal(s[0].resumeSdkSessionId, 'sdk-short');
  assert.equal(calls.length, 1);
});

test('the Host API (phone, web) keeps today behaviour: it has no way to show the notice', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const calls = []; const seen = [];
  await v2.startHostTurn({ userId: u.id, chatSessionId: chat, message: 'next', onEvent: () => {}, deps: { classifyMode: async () => ({ mode: 'ask' }), runTurn: okTurn(seen), summarize: fakeSummarize(calls) } });
  assert.equal(calls.length, 0);
  assert.deepEqual(seen[0].history, []);
});

test('a failed summary call falls back to today behaviour and the turn still runs', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const seen = [];
  const res = await turn(u, chat, { runTurn: okTurn(seen), summarize: async () => { throw Object.assign(new Error('boom'), { code: 'PROVIDER_UNAVAILABLE' }); } });
  assert.deepEqual(seen[0].history, []);
  assert.equal(continued(res), undefined);
  assert.ok(res.sseEvents().some((e) => e.type === 'result'));
  assert.equal(getContinuation(u.id, chat), null);
});

test('continueMode replay: no summary; the chat record seeds the turn by the fresh-turn rule', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const seen = []; const calls = [];
  await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize(calls) }, { continueMode: 'replay' });
  assert.equal(calls.length, 0);
  assert.equal(seen[0].history.length, 14);
  assert.match(seen[0].history[0].content, /^question 0/);
});

test('no server record: the history a client sent with fresh:true is summarised (the bench, older clients)', async () => {
  ON();
  const u = mkUser();
  const history = [];
  for (let i = 0; i < 7; i += 1) history.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
  const seen = []; const calls = [];
  await turn(u, 'no-server-row', { runTurn: okTurn(seen), summarize: fakeSummarize(calls) }, { fresh: true, history });
  assert.equal(calls.length, 1);
  assert.equal(getContinuation(u.id, 'no-server-row').source, 'client');
  assert.match(seen[0].history[0].content, /Handoff note/);
});

test('the message the desktop stored before sending is not history', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  appendChatMessage(u.id, chat, { role: 'user', content: 'next question' });
  const seen = [];
  await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize([]) });
  assert.match(seen[0].history.at(-1).content, /^answer 6/);
  assert.ok(!seen[0].history.some((t) => t.content === 'next question'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/agent-v2-continuation.test.mjs`
Expected: FAIL. The first test passes. The on-tests fail (`calls.length` 0, expected 1).

- [ ] **Step 3: Wire it.** In `extension/routes/agent-v2.mjs`:

After `import { buildHandoff } from '../providers/handoff.mjs';` add:
```js
import { planContinuation } from '../providers/continuation.mjs';
import { runClaude } from '../providers/runtime.mjs';
```

Replace
```js
const DEFAULT_DEPS = { runTurn: runEngineTurn, classifyMode: classifyCodeAssistMode, expandSlash: expandUserSlashCommand };
```
with
```js
const DEFAULT_DEPS = { runTurn: runEngineTurn, classifyMode: classifyCodeAssistMode, expandSlash: expandUserSlashCommand, summarize: (prompt, opts) => runClaude(prompt, opts) };
```

In the body comment above `handleV2Stream` replace
```js
// agentContext: { chatSessionId, workspaceRoot, … }, attachments?, fresh?,
// history? (only read when fresh — see freshTurnHistory) } →
```
with
```js
// agentContext: { chatSessionId, workspaceRoot, … }, attachments?, fresh?,
// history? (only read when fresh — see freshTurnHistory), continueMode? ('replay':
// the full history instead of an ended-chat summary, providers/continuation.mjs) } →
```

Replace
```js
  const resumeSdkSessionId = freshTurn || adapterTurn ? null : row.sdk_session_id;
```
with
```js
  let resumeSdkSessionId = freshTurn || adapterTurn ? null : row.sdk_session_id;
```

Delete the line `  const turnId = randomUUID();` (and its two comment lines `// Joins this turn's tool accounting ...` / `// (usage_ledger.request_id), which were written with no request id before.`) where it sits after `emitTaskProgress`. Then, right after the `send` definition
```js
  const send = (obj) => {
    if (ac.signal.aborted) return;
    replay.push(obj);
    if (!primaryGone && !io.isGone()) io.send(obj);
  };
```
insert:
```js
  // Joins this turn's tool accounting (turn_tool_events) and the continuation summary's ledger row to the turn's
  // own ledger rows (usage_ledger.request_id).
  const turnId = randomUUID();
  // Ended-chat continuation (providers/continuation.mjs): OFF unless LLMIDE_V2_CONTINUE_SUMMARY=on, and never on a
  // provider switch (its own handoff above) or an adapter turn (handed the history every turn). Runs after the
  // abort is registered, so Stop also stops the summary call. null = exactly today's turn.
  let continuedNotice = null;
  if (!switching && !adapterTurn) {
    const plan = await planContinuation({
      userId, chatSessionId, agentContext, body, sdkSessionId: resumeSdkSessionId, provider, model,
      requestId: turnId, summarize: deps.summarize ?? DEFAULT_DEPS.summarize, signal: ac.signal,
    });
    if (plan?.kind === 'replay') {
      turnHistory = freshTurnHistory({ fresh: true, history: plan.turns });
      resumeSdkSessionId = null;
      currentSdkSessionId = null;
    } else if (plan?.kind === 'summary') {
      turnHistory = plan.history;
      resumeSdkSessionId = null;
      currentSdkSessionId = null;
      continuedNotice = plan.notice;
      // The summary call is a model call the chat caused: with the cap on it counts against the chat, like the classifier.
      if (routerCapEnabled() && plan.usage?.calls > 0) {
        try { commitTurnUsage(db, userId, chatSessionId, plan.usage, {}); } catch (e) { log.warn('continuation_tokens_not_counted', { message: String(e?.message || e).slice(0, 120) }); }
      }
    }
  }
```

In `onEvent`, replace
```js
      send({ type: 'mode_set', mode });
```
with
```js
      send({ type: 'mode_set', mode });
      if (continuedNotice) send(continuedNotice);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && node --test --experimental-strip-types tests/agent-v2-continuation.test.mjs tests/agent-v2-routes.test.mjs tests/agent-v2-router-turn.test.mjs tests/agent-v2-host-turn.test.mjs tests/turn-replay-routes.test.mjs tests/host-approval-bypass.test.mjs && npm run lint`
Expected: PASS. Lint reports 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/agent-v2.mjs extension/tests/agent-v2-continuation.test.mjs
git commit -m "feat(server): continue ended v2 chats from a summary behind LLMIDE_V2_CONTINUE_SUMMARY"
```

---

### Task 4: Contract and API version 118 (~20 min)

**Files:**
- Modify: `extension/server.mjs` (version comment list above `const SERVER_API_VERSION`, and `SERVER_API_VERSION = 117` to `118` at ~:332)
- Modify: `ui/screens/shell/core-api-floor.ts:5`
- Modify: `schema/http/agent.schema.json` (`POST /agent/v2/stream` body, after `"history"`)
- Modify: `schema/agent-v2/agent-v2.schema.json:145` (notice description)
- Create: `schema/agent-v2/fixtures/notice_chat_continued.json`
- Regenerate: `docs/reference/api/openapi.yaml`, `extension/src/lib/api-types.ts`, `schema/http/INVENTORY.md`
- Modify: `docs/spec/api-server.md` and `docs/spec/cross-cutting.md` (`SERVER_API_VERSION = 117` to `118`), `docs/spec/session-router.md` (new section 6a)
- Test: `ui/screens/shell/tests/core-api-floor.test.mjs` (existing drift test), `ui/screens/chat/tests/events.test.mjs` (one assertion)

**Interfaces:**
- Consumes: Task 3 wire behaviour.
- Produces: API 118. Request field `continueMode: 'replay'`. Notice kind `chat_continued` with `data { reason: 'fresh'|'no_session'|'idle', coveredTurns, keptTurns, cached }`.

Full bump checklist (every item is a step below): `extension/server.mjs` constant + version comment, `ui/screens/shell/core-api-floor.ts` `APP_API_VERSION`, `schema/http/*.schema.json` contract, `schema/agent-v2` description + fixture, regenerated `openapi.yaml` (`x-api-version`), regenerated `extension/src/lib/api-types.ts`, regenerated `schema/http/INVENTORY.md` (handler line numbers in `agent-v2.mjs` moved), `docs/spec/api-server.md`, `docs/spec/cross-cutting.md`, then `make contract-gates agent-v2-gates docs-check`.

- [ ] **Step 1: Write the failing test.** In `ui/screens/chat/tests/events.test.mjs`, inside `test("fixtures carry their fields through the decode", ...)`, after the `notice_session_budget` assertion add:

```js
  const cont = c.decodeEvent(by.notice_chat_continued).event;
  assert.equal(cont.kind, "chat_continued");
  assert.equal(cont.level, "info");
  assert.equal(cont.data.reason, "no_session");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/chat/tests/events.test.mjs`
Expected: FAIL with `Cannot read properties of undefined` (no fixture yet).

- [ ] **Step 3: Add the fixture and schema text.** Create `schema/agent-v2/fixtures/notice_chat_continued.json`:

```json
{
  "type": "notice",
  "kind": "chat_continued",
  "level": "info",
  "text": "Continued from a summary of 8 earlier messages and the last 6 in full. Your full history is unchanged.",
  "data": { "reason": "no_session", "coveredTurns": 8, "keptTurns": 6, "cached": false }
}
```

In `schema/agent-v2/agent-v2.schema.json` notice `description`, replace `| route_switch | session_budget (session router, K1 P6b, API 91:` with `| route_switch | session_budget | chat_continued (ended-chat continuation, API 118, only with LLMIDE_V2_CONTINUE_SUMMARY=on: level info but shown by the desktop; data {reason fresh | no_session | idle, coveredTurns, keptTurns, cached}; sent right after mode_set) (session router, K1 P6b, API 91:`.

In `schema/http/agent.schema.json`, in the `POST /agent/v2/stream` request body properties, replace
```json
              "x-optional": true,
              "description": "read only when fresh is true"
            },
```
with
```json
              "x-optional": true,
              "description": "read only when fresh is true (with LLMIDE_V2_CONTINUE_SUMMARY=on, an ended chat's older turns are summarised instead of replayed)"
            },
            "continueMode": {
              "type": "string",
              "enum": ["replay"],
              "x-optional": true,
              "description": "Ended-chat continuation (API 118): 'replay' gives this turn the chat's full history instead of a summary. Ignored unless LLMIDE_V2_CONTINUE_SUMMARY=on."
            },
```

- [ ] **Step 4: Bump the version.** In `extension/server.mjs`, directly above the line starting `//   v117 — additive: GET /kb/live/:id/capture`, add:

```js
//   v118 — additive, ended-chat continuation (bench-gated, only with LLMIDE_V2_CONTINUE_SUMMARY=on; off changes nothing): POST /agent/v2/stream accepts continueMode: 'replay' (the turn gets the chat's full history instead of a summary) and may emit notice { kind: 'chat_continued', level: 'info', data: { reason: fresh | no_session | idle, coveredTurns, keptTurns, cached } } right after mode_set when an ended chat continues from a summary. The summary call is metered as /agent/v2/stream:continuation under the turn's request id. Migration 0065 chat_continuations. Spec docs/spec/session-router.md section 6a.
```
Change `const SERVER_API_VERSION = 117;` to `const SERVER_API_VERSION = 118;`. In `ui/screens/shell/core-api-floor.ts` change `export const APP_API_VERSION = 117;` to `export const APP_API_VERSION = 118;`. In `docs/spec/api-server.md` and `docs/spec/cross-cutting.md` change `SERVER_API_VERSION = 117` to `SERVER_API_VERSION = 118`.

- [ ] **Step 5: Spec section.** In `docs/spec/session-router.md`, insert before `## §7 Routes`:

```markdown
## §6a Ended-chat continuation (X3, API 118)

Not part of the router; it shares the handoff packer. `extension/providers/continuation.mjs`, called once per
`POST /agent/v2/stream` turn from `runV2Stream`. Switch `LLMIDE_V2_CONTINUE_SUMMARY=on` (exactly `on`, read at
call time; default off until the bench). The desktop pref `continueSummary` sets it at the next backend start.

- **Ended**, in this order: `fresh` (the client sent `fresh: true`, the `SESSION_UNRESUMABLE` retry); `no_session` (no SDK session recorded: quit purge, session delete); `idle` (recorded, last used at least 5 minutes ago, and at least 24,000 characters of chat text; shorter chats resume). A core restart alone is not an end. The chat must have at least one earlier assistant turn.
- **Not applied** to `agentContext.surface: 'host-api'` (phone and web; Host API v1 cannot carry the notice), a provider switch (§6), or an adapter turn.
- **Turns read**: the server's `chat_messages` when the chat has a row (minus the message being sent), else the `history` a client sent with `fresh: true`.
- **Seed**: `buildHandoff` with the summary as its note and the last exchange plus up to 6 turns within 24,000 characters, starting on a user turn.
- **Summary**: on a hash miss only (`chat_continuations.content_hash` = `archiveHash` of the covered turns); on the turn provider's fast model (`fastModelFor`), else the chat's model, never another provider; metered by `runClaude` as `/agent/v2/stream:continuation` with the turn's request id, stored with its tokens on the chat's row, and counted against the cap with `LLMIDE_ROUTER_CAP=on`. Input capped at 80,000 characters, redacted and fence-neutralised; the reply capped at 4,000 characters. The text is never logged.
- **Notice**: `chat_continued` (info, shown by the desktop) right after `mode_set`. `continueMode: 'replay'` skips the summary and seeds the turn by `freshTurnHistory` from the same record (an idle chat resumes).
- **Failure**: any error is today's turn, unchanged.
- **Storage**: `chat_continuations` (migration 0065), deleted with the chat's messages and on account delete; rows made from a client's history also at the quit purge and `DELETE /agent/v2/session`.
```

- [ ] **Step 6: Regenerate and run the gates**

Run: `node scripts/gen-openapi.mjs && node scripts/gen-api-types.mjs && node scripts/http-inventory.mjs && make contract-gates agent-v2-gates docs-check && cd desktop && node --test --experimental-strip-types ../ui/screens/chat/tests/events.test.mjs ../ui/screens/shell/tests/core-api-floor.test.mjs`
Expected: all PASS. `openapi.yaml` shows `x-api-version: 118`, and `INVENTORY.md` has the new `agent-v2.mjs` handler line numbers.

- [ ] **Step 7: Commit**

```bash
git add extension/server.mjs ui/screens/shell/core-api-floor.ts schema/http/agent.schema.json schema/agent-v2/agent-v2.schema.json schema/agent-v2/fixtures/notice_chat_continued.json docs/reference/api/openapi.yaml extension/src/lib/api-types.ts schema/http/INVENTORY.md docs/spec/api-server.md docs/spec/cross-cutting.md docs/spec/session-router.md ui/screens/chat/tests/events.test.mjs
git commit -m "feat(server): ended-chat continuation contract, API v118"
```

---

### Task 5: Desktop chat shows the continuation and offers the full history (~30 min)

**Files:**
- Modify: `ui/screens/chat/state.ts` (`Notice.visible` comment :43, `noticeOf` :220-222)
- Modify: `ui/screens/chat/MessageView.tsx` (`MessageHost` :16-23, `NoticeLine` :131-134, call site :171)
- Modify: `ui/screens/chat/MessageList.tsx` (:43, :50)
- Modify: `ui/screens/chat/ChatScreen.tsx` (:260, the `<MessageList` props :338)
- Modify: `ui/screens/chat/controller.ts` (`SendOptions`, `Runtime`, `rt()` init :118, `runTurn` :382-402, new `fullHistoryNext`)
- Test: `ui/screens/chat/tests/state.test.mjs`, `ui/screens/chat/tests/components.test.mjs`, `ui/screens/chat/tests/controller.test.mjs`

**Interfaces:**
- Consumes: Task 4 notice `chat_continued`; request field `continueMode: 'replay'`.
- Produces: `ChatController.fullHistoryNext(id: string): void`; `FULL_HISTORY_NEXT_NOTICE` (string export); `SendOptions.continueMode?: "replay"`; `MessageHost.onFullHistoryNext?: () => void`.

- [ ] **Step 1: Write the failing tests.** In `ui/screens/chat/tests/state.test.mjs` add:

```js
test("chat_continued is info but shown (the user must see the chat was continued from a summary)", () => {
  let s = start();
  s = c.reduce(s, { type: "events", events: [ev("notice", { kind: "chat_continued", level: "info", text: "Continued from a summary of 8 earlier messages", data: { reason: "no_session" } })] });
  assert.deepEqual(last(s).notices.map((x) => [x.kind, x.visible]), [["chat_continued", true]]);
});
```

In `ui/screens/chat/tests/components.test.mjs` add:

```js
test("MessageView: a chat_continued notice offers the full history only when the host can send it", () => {
  const m = asst({ notices: [{ kind: "chat_continued", level: "info", text: "Continued from a summary of 8 earlier messages", count: 1, visible: true }] });
  assert.match(html(h(c.MessageView, { host: { onFullHistoryNext: () => {} }, m })), /Send the full history with my next message/);
  const plain = html(h(c.MessageView, { host: {}, m }));
  assert.match(plain, /Continued from a summary/);
  assert.ok(!plain.includes("Send the full history"));
});
```

In `ui/screens/chat/tests/controller.test.mjs` add:

```js
test("fullHistoryNext: a marker, then exactly the next message carries continueMode replay (kept on its retry)", async () => {
  const core = fakeCore({ streams: [turn(), turn(), turn()] });
  const { ctl } = make(core);
  ctl.send("a", "one", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done");
  ctl.fullHistoryNext("a");
  ctl.fullHistoryNext("a");
  const marks = ctl.getState("a").messages.at(-1).notices.filter((x) => x.kind === "full_history_next");
  assert.equal(marks.length, 1, "asking twice adds one marker");
  assert.equal(marks[0].text, c.FULL_HISTORY_NEXT_NOTICE);
  ctl.send("a", "two", { mode: "ask" });
  await until(() => ctl.getState("a").messages.at(-1)?.status === "done" && ctl.getState("a").turnSeq === 2);
  ctl.send("a", "three", { mode: "ask" });
  await until(() => ctl.getState("a").turnSeq === 3 && ctl.getState("a").messages.at(-1)?.status === "done");
  const bodies = core.calls.filter((x) => x.method === "STREAM").map((x) => x.body);
  assert.equal(bodies[0].continueMode, undefined);
  assert.equal(bodies[1].continueMode, "replay");
  assert.equal(bodies[2].continueMode, undefined);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/chat/tests/state.test.mjs ../ui/screens/chat/tests/components.test.mjs ../ui/screens/chat/tests/controller.test.mjs`
Expected: FAIL. `visible` is `false`, the button is missing, and `ctl.fullHistoryNext is not a function`.

- [ ] **Step 3: Implement.**

`ui/screens/chat/state.ts`: change the `visible` doc comment in `interface Notice` to `/** Shown to the user: warning/error, plus the info kinds in SHOWN_INFO_KINDS. Other \`info\` is bookkeeping. */`, and replace
```ts
function noticeOf(ev: Extract<AgentEvent, { type: "notice" }>): Notice {
  return { kind: ev.kind, level: ev.level, text: ev.text, count: 1, visible: ev.level !== "info" || ev.kind === "workspace_trust" };
}
```
with
```ts
/** Info notices the user must see: the folder-trust prompt, and a chat continued from a summary (API 118). */
const SHOWN_INFO_KINDS: ReadonlySet<string> = new Set(["workspace_trust", "chat_continued"]);

function noticeOf(ev: Extract<AgentEvent, { type: "notice" }>): Notice {
  return { kind: ev.kind, level: ev.level, text: ev.text, count: 1, visible: ev.level !== "info" || SHOWN_INFO_KINDS.has(ev.kind) };
}
```

`ui/screens/chat/MessageView.tsx`: in `MessageHost`, after `onRetry?: () => void;` add
```ts
  /** On a "continued from a summary" notice: send the full history with the next message (one message). */
  onFullHistoryNext?: () => void;
```
Replace
```tsx
function NoticeLine({ n }: { n: Notice }) {
  const text = n.count > 1 ? `${n.text} (x${n.count})` : n.text;
  return <StatusBanner severity={n.level === "error" ? "error" : n.level === "warning" ? "warning" : "info"} message={text} />;
}
```
with
```tsx
function NoticeLine({ n, host }: { n: Notice; host: MessageHost }) {
  const text = n.count > 1 ? `${n.text} (x${n.count})` : n.text;
  const message = n.kind === "chat_continued" && host.onFullHistoryNext
    ? <>{text} <button type="button" className="chat-link-btn" onClick={host.onFullHistoryNext}>Send the full history with my next message</button></>
    : text;
  return <StatusBanner severity={n.level === "error" ? "error" : n.level === "warning" ? "warning" : "info"} message={message} />;
}
```
and change `{m.notices.filter((n) => n.visible).map((n, i) => <NoticeLine key={i} n={n} />)}` to `{m.notices.filter((n) => n.visible).map((n, i) => <NoticeLine key={i} n={n} host={host} />)}`.

`ui/screens/chat/MessageList.tsx`: change the signature to `export function MessageList({ messages, hasMoreOlder, onLoadOlder, initialScrollTop, onScrollState, onOpenLink, onCopy, files, onFullHistoryNext, empty }: Props) {` and the host line to
```ts
  const host = useMemo<MessageHost>(() => ({ onOpenLink, onCopy, files, onFullHistoryNext }), [onOpenLink, onCopy, files, onFullHistoryNext]);
```

`ui/screens/chat/ChatScreen.tsx`: after the `onLoadOlder` line add
```ts
  const onFullHistoryNext = useCallback(() => { if (activeId) controller.fullHistoryNext(activeId); }, [activeId, controller]);
```
and in the `<MessageList ... />` props, after `onRetry={() => controller.retry(activeId)}`, add `onFullHistoryNext={onFullHistoryNext}`.

`ui/screens/chat/controller.ts`:
- In `SendOptions`, after `effort?: string;` add
```ts
  /** "replay": the core sends this turn the chat's full history instead of an ended-chat summary (API 118). */
  continueMode?: "replay";
```
- After `export const PROJECT_CHANGED_NOTICE = ...;` add
```ts
export const FULL_HISTORY_NEXT_NOTICE = "Your next message will carry the full history.";
```
- In `interface Runtime`, after `attachedTurn: string | null;` add
```ts
  /** The user asked for the full history on the next message (one message, then cleared). */
  fullHistoryNext: boolean;
```
- In `rt()`, change the initialiser's end `reattached: false, attachedTurn: null };` to `reattached: false, attachedTurn: null, fullHistoryNext: false };`.
- After `clearError(id: string): void { ... }` add
```ts
  /** The next message of this chat asks the core for its full history instead of a summary (the chat_continued action). */
  fullHistoryNext(id: string): void {
    const r = this.rt(id);
    if (r.fullHistoryNext) return;
    r.fullHistoryNext = true;
    this.dispatch(id, { type: "marker", kind: "full_history_next", level: "info", text: FULL_HISTORY_NEXT_NOTICE });
  }
```
- In `runTurn`, replace
```ts
    const r = this.rt(id);
    const ac = new AbortController();
```
with
```ts
    const r = this.rt(id);
    // Taken into the options (so a retry of this message keeps it) and cleared: one message only.
    if (r.fullHistoryNext) { opts = { ...opts, continueMode: "replay" }; r.fullHistoryNext = false; }
    const ac = new AbortController();
```
and in `attemptBody`, after `...(opts.attachments?.length ? { attachments: opts.attachments } : {}), ...(opts.planExecute ? { planExecute: true } : {}),` add `...(opts.continueMode ? { continueMode: opts.continueMode } : {}),`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/chat/tests/*.test.mjs && npx tsc --noEmit`
Expected: PASS, and tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add ui/screens/chat/state.ts ui/screens/chat/MessageView.tsx ui/screens/chat/MessageList.tsx ui/screens/chat/ChatScreen.tsx ui/screens/chat/controller.ts ui/screens/chat/tests/state.test.mjs ui/screens/chat/tests/components.test.mjs ui/screens/chat/tests/controller.test.mjs
git commit -m "feat(desktop): show a continued-from-summary chat and offer its full history"
```

---

### Task 6: Desktop switch, from the `continueSummary` pref to `LLMIDE_V2_CONTINUE_SUMMARY=on` (~20 min)

**Files:**
- Modify: `desktop/src-tauri/src/prefs.rs` (`Prefs` :125-155, `Default` :157-165, `PrefsPatch` :170-187, `patched` :203-226, `core_env_pairs` :318-331, tests ~:455-480)
- Modify: `ui/screens/shell/host-prefs.ts` (`HostPrefs`, `decodePrefs`)
- Modify: `ui/screens/shell/settings-adapter.ts:77`
- Modify: `ui/screens/settings/host.ts:130-132`
- Modify: `ui/screens/settings/routing-model.ts` (`SWITCH_TEXT`)
- Modify: `ui/screens/settings/sections/RoutingSection.tsx:184-204`
- Test: `desktop/src-tauri/src/prefs.rs` (unit tests), `ui/screens/shell/tests/host-prefs.test.mjs`

**Interfaces:**
- Consumes: Task 3's env switch name `LLMIDE_V2_CONTINUE_SUMMARY`.
- Produces: pref `continueSummary: boolean` (JSON, camelCase), default `false`. The core env gets `LLMIDE_V2_CONTINUE_SUMMARY=on` at the next backend start. `getExtraPrefs()` returns `{ compress, learn, terminal, continueSummary }`.

- [ ] **Step 1: Write the failing tests.** In `desktop/src-tauri/src/prefs.rs` tests, in `defaults_are_off_for_every_token_affecting_switch` change `assert!(!d.router && !d.cap && !d.compress && !d.learn);` to `assert!(!d.router && !d.cap && !d.compress && !d.learn && !d.continue_summary);`, and add:

```rust
    #[test]
    fn continue_summary_reaches_the_core_as_exactly_on() {
        let p = Prefs { continue_summary: true, ..Prefs::default() };
        assert_eq!(core_env_pairs(&p, None), vec![("LLMIDE_V2_CONTINUE_SUMMARY", "on".to_string())]);
        let off = p.patched(&PrefsPatch { continue_summary: Some(false), ..Default::default() });
        assert!(core_env_pairs(&off, None).is_empty());
        let old: Prefs = serde_json::from_str(r#"{"ltaMode":"off","router":false,"cap":false,"compress":false,"learn":false,"terminal":true,"theme":"dark"}"#).unwrap();
        assert!(!old.continue_summary, "an older prefs file reads as off");
    }
```

In `ui/screens/shell/tests/host-prefs.test.mjs`, add `continueSummary: false,` to the `P` object after `learn: false,`. Then replace
```js
  await host.setExtraPrefs({ learn: true });
  assert.deepEqual(await host.getExtraPrefs(), { compress: false, learn: true, terminal: true });
  assert.equal(state.stored.learn, true);
```
with
```js
  await host.setExtraPrefs({ learn: true });
  assert.deepEqual(await host.getExtraPrefs(), { compress: false, learn: true, terminal: true, continueSummary: false });
  assert.equal(state.stored.learn, true);
  await host.setExtraPrefs({ continueSummary: true });
  assert.deepEqual(calls.at(-1), ["set_prefs", { patch: { continueSummary: true } }]);
  assert.equal((await host.getExtraPrefs()).continueSummary, true);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd desktop/src-tauri && cargo test prefs:: ; cd .. && node --test --experimental-strip-types ../ui/screens/shell/tests/host-prefs.test.mjs`
Expected: cargo fails to compile (`no field continue_summary`). The node test fails on the `getExtraPrefs` deepEqual.

- [ ] **Step 3: Implement the Rust side.** In `desktop/src-tauri/src/prefs.rs`:
- In `struct Prefs`, after `pub learn: bool,` add
```rust
    /// Continue an ended chat from a summary (bench-gated, beta): `LLMIDE_V2_CONTINUE_SUMMARY=on` at the next backend start.
    pub continue_summary: bool,
```
- In `Default for Prefs`, change `learn: false, terminal: true,` to `learn: false, continue_summary: false, terminal: true,`.
- In `struct PrefsPatch`, after `pub learn: Option<bool>,` add `pub continue_summary: Option<bool>,`.
- In `patched`, after `if let Some(v) = p.learn { n.learn = v; }` add `if let Some(v) = p.continue_summary { n.continue_summary = v; }`.
- In `core_env_pairs`, after `if p.learn { v.push(("LLMIDE_ROUTER_LEARN", "on".to_string())); }` add `if p.continue_summary { v.push(("LLMIDE_V2_CONTINUE_SUMMARY", "on".to_string())); }`.

- [ ] **Step 4: Implement the TS side.**

`ui/screens/shell/host-prefs.ts`: in `interface HostPrefs`, after `learn: boolean;` add
```ts
  /** Continue ended chats from a summary (beta, bench-gated); read at the next backend start. */
  continueSummary: boolean;
```
In `decodePrefs`, after `const updateChecks = raw.updateChecks !== false;` add `const continueSummary = raw.continueSummary === true;`, and in its `return { ... }` change `learn: learn as boolean,` to `learn: learn as boolean, continueSummary,`.

`ui/screens/settings/host.ts`: change both extra-prefs types to `{ compress: boolean; learn: boolean; terminal: boolean; continueSummary: boolean }` (`getExtraPrefs?(): Promise<...>` and `setExtraPrefs?(prefs: Partial<...>)`). Extend the doc comment: `/** Further host prefs read when the app/backend next starts: prompt compression, learned limits, the Terminal feature, ended-chat continuation. */`.

`ui/screens/shell/settings-adapter.ts:77`: change to
```ts
        getExtraPrefs: async () => { const p = (await readPrefs()).stored; return { compress: p.compress, learn: p.learn, terminal: p.terminal, continueSummary: p.continueSummary }; },
```

`ui/screens/settings/routing-model.ts`, in `SWITCH_TEXT` after the `learn:` entry add
```ts
  continueSummary: `Off by default: a chat you come back to after it ended continues from a short summary made on the provider's fast model plus its last messages, instead of the whole history. The chat says when this happened and lets you send the full history. ${NEXT_START_NOTE}`,
```

`ui/screens/settings/sections/RoutingSection.tsx`, in `ExtraPrefs`: change `useState<{ compress: boolean; learn: boolean; terminal: boolean } | null>(null)` to `useState<{ compress: boolean; learn: boolean; terminal: boolean; continueSummary: boolean } | null>(null)`, and after the `Learn provider limits (beta)` `<Switch ... />` add
```tsx
      <Switch label="Continue ended chats from a summary (beta)" checked={prefs.continueSummary} hint={SWITCH_TEXT.continueSummary} onChange={(v) => save({ continueSummary: v })} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd desktop/src-tauri && cargo test prefs:: && cd .. && node --test --experimental-strip-types ../ui/screens/shell/tests/host-prefs.test.mjs ../ui/screens/settings/tests/*.test.* && npx tsc --noEmit`
Expected: PASS, and tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/prefs.rs ui/screens/shell/host-prefs.ts ui/screens/shell/settings-adapter.ts ui/screens/settings/host.ts ui/screens/settings/routing-model.ts ui/screens/settings/sections/RoutingSection.tsx ui/screens/shell/tests/host-prefs.test.mjs
git commit -m "feat(desktop): beta switch for ended-chat continuation (off by default)"
```

---

### Task 7: Bench hook (long scenario, per-turn `continued`, fake summary) + status docs (~25 min)

**Files:**
- Modify: `extension/llm_agent/sdk/bench-fake-engine.mjs` (`runBenchFakeTurn` args + fresh-session cost; new `benchFakeSummary`)
- Modify: `extension/routes/agent-v2.mjs` (`DEFAULT_DEPS.summarize` becomes bench-aware)
- Modify: `scripts/token-bench.mjs` (`streamTurn` ~:606-640, `runSample` turns push ~:788, `perTurn` ~:865)
- Modify: `schema/bench/scenarios.json` (comment, `version` 5, `compatibleWith` [2, 3, 4], new scenario)
- Modify: `docs/how-to/run-the-token-bench.md`, `docs/superpowers/MASTER-PLAN.md:496`
- Test: `extension/tests/token-bench.test.mjs`

**Interfaces:**
- Consumes: Task 3 notice and `deps.summarize`; Task 2 `SUMMARY_ENDPOINT`.
- Produces: `benchFakeSummary(prompt, { userId, provider, model, endpoint, requestId }) -> Promise<string>` (writes one ledger row, no model call). Results `perTurn[i].continued: boolean`. Scenario `ended-chat-continue-long` (11 turns, `dropSessionBefore: [10]`).

- [ ] **Step 1: Write the failing tests.** In `extension/tests/token-bench.test.mjs`:
- After `const V4_IDS = [...]` add `const V5_IDS = ['ended-chat-continue-long'];`.
- In the `loadScenarios reads the committed set` test: change the title to `'loadScenarios reads the committed set (version 5 = the v4 sixteen unchanged + the long ended-chat scenario) with tool scenarios marked'`, `assert.equal(version, 4);` to `assert.equal(version, 5);`, `assert.deepEqual(compatibleWith, [2, 3]);` to `assert.deepEqual(compatibleWith, [2, 3, 4]);`, and `[...V2_IDS, ...V3_IDS, ...V4_IDS]` to `[...V2_IDS, ...V3_IDS, ...V4_IDS, ...V5_IDS]`.
- Add:

```js
test('runBench --fake: with LLMIDE_V2_CONTINUE_SUMMARY=on the long ended chat continues from a metered summary', async () => {
  const { scenarios } = loadScenarios(SCENARIOS);
  const pick = scenarios.filter((s) => s.id === 'ended-chat-continue-long');
  assert.equal(pick[0].turns.length, 11);
  assert.deepEqual(pick[0].dropSessionBefore, [10]);
  const off = await runBench({ fake: true, model: FAKE_MODEL, scenarios: pick, scenariosVersion: 5, repeat: 1 });
  const on = await runBench({ fake: true, model: FAKE_MODEL, scenarios: pick, scenariosVersion: 5, repeat: 1, extraEnv: { LLMIDE_V2_CONTINUE_SUMMARY: 'on' } });
  const a = off.scenarios[0].perTurn.at(-1);
  const b = on.scenarios[0].perTurn.at(-1);
  assert.equal(a.continued, false);
  assert.equal(b.continued, true);
  assert.ok(b.input > a.input, 'the summary call is counted inside the continued turn');
  assert.ok(b.cacheWrite < a.cacheWrite, 'summary + recent turns write less than the replayed history');
  assert.equal(on.scenarios[0].helperCalls, 0, 'the summary is not a helper call');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --experimental-strip-types tests/token-bench.test.mjs`
Expected: FAIL (`version` 4 ≠ 5, and the new test cannot find the scenario).

- [ ] **Step 3: Fake engine.** In `extension/llm_agent/sdk/bench-fake-engine.mjs`:
- After `import { randomUUID } from 'node:crypto';` add
```js
import { recordUsage } from '../../kb/usage.mjs';
import { getDb } from '../../kb/db.mjs';
```
- Change the `runBenchFakeTurn` parameter list `message = '', model, mode, resumeSdkSessionId, onEvent,` to `message = '', model, mode, resumeSdkSessionId, onEvent, history = [],`.
- Replace
```js
  const newPromptTokens = approxTokens(message);
```
with
```js
  // A fresh session also writes the history it was seeded with (a replay, or an ended-chat summary + recent turns).
  const seedTokens = resumed || !Array.isArray(history) ? 0 : approxTokens(history.map((t) => t?.content ?? '').join('\n'));
  const newPromptTokens = approxTokens(message) + seedTokens;
```
- At the end of the file (before `__resetBenchFakeForTest` or after it) add
```js
/**
 * Stand-in for the ended-chat summary call (providers/continuation.mjs `summarize` seam): no model call, one
 * deterministic ledger row under the caller's endpoint and request id, exactly where runClaude would write it.
 */
export async function benchFakeSummary(prompt, { userId, provider = 'anthropic', model, endpoint, requestId } = {}) {
  const text = `Bench summary of ${approxTokens(prompt)} prompt tokens.`;
  recordUsage(getDb(), { userId, provider, model: model || 'bench-fake', source: 'api', endpoint, requestId, inputTokens: approxTokens(prompt), outputTokens: approxTokens(text) });
  return text;
}
```

In `extension/routes/agent-v2.mjs`, replace `summarize: (prompt, opts) => runClaude(prompt, opts) };` in `DEFAULT_DEPS` with `summarize: defaultSummarize };`, and above `DEFAULT_DEPS` add
```js
// The ended-chat summary call: runClaude, or under the token bench's fake engine a metered stand-in (no model call).
async function defaultSummarize(prompt, opts) {
  if (benchFakeEngineEnabled()) {
    const { benchFakeSummary } = await import('../llm_agent/sdk/bench-fake-engine.mjs');
    return benchFakeSummary(prompt, opts);
  }
  return runClaude(prompt, opts);
}
```

- [ ] **Step 4: Bench runner.** In `scripts/token-bench.mjs`:
- In `streamTurn`, after `let reply = '';` add `let continued = false;`, and after `if (ev.type === 'init' && ev.sessionId) sdkSessionId = ev.sessionId;` add `if (ev.type === 'notice' && ev.kind === 'chat_continued') continued = true;`. In the object `streamTurn` returns, add `continued` next to `reply`.
- In `runSample`, in `turns.push({ hops: ..., raw, ... })` add `continued: t.continued === true,`.
- In the `perTurn` map, change `cacheRead: t.raw.cacheRead, cacheWrite: t.raw.cacheWrite,` to `cacheRead: t.raw.cacheRead, cacheWrite: t.raw.cacheWrite, continued: t.continued === true,`.

In `schema/bench/scenarios.json`: change the first comment line to `"Fixed scenario set for scripts/token-bench.mjs (Phase 1 P17). Version 5."`, and after the `"Version 4 = ..."` line add `"Version 5 = the sixteen version-4 scenarios, UNCHANGED, plus ended-chat-continue-long (X3): ten facts, the SDK session dropped, then a recall turn. A/B it with --env LLMIDE_V2_CONTINUE_SUMMARY=on; perTurn[].continued says whether a turn was continued from a summary.",`. Set `"version": 5`, set `"compatibleWith": [2, 3, 4]`, and append this scenario as the last entry of `"scenarios"`:

```json
    {
      "id": "ended-chat-continue-long",
      "mode": "ask",
      "dropSessionBefore": [10],
      "turns": [
        "Remember the code word is 'maple'. Reply with OK only.",
        "Remember the colour is 'teal'. Reply with OK only.",
        "Remember the city is 'Lisbon'. Reply with OK only.",
        "Remember the number is 42. Reply with OK only.",
        "Remember the animal is 'otter'. Reply with OK only.",
        "Remember the fruit is 'quince'. Reply with OK only.",
        "Remember the tool is 'chisel'. Reply with OK only.",
        "Remember the planet is 'Neptune'. Reply with OK only.",
        "Remember the metal is 'cobalt'. Reply with OK only.",
        "Remember the river is 'Danube'. Reply with OK only.",
        "List the code word, the colour and the city I asked you to remember, comma-separated, nothing else."
      ]
    }
```

- [ ] **Step 5: Docs.** In `docs/how-to/run-the-token-bench.md`, append:

```markdown
## Ended-chat continuation (scenario set version 5)

`ended-chat-continue-long` seeds ten facts, drops the chat's SDK session, then asks for three of them back (what
a restart after a quit purge looks like). Run the A/B for the X3 switch on the same model and `--repeat`:

    node scripts/token-bench.mjs --only ended-chat-continue-long,ended-chat-continue --repeat 5 --out a.json
    node scripts/token-bench.mjs --only ended-chat-continue-long,ended-chat-continue --repeat 5 --env LLMIDE_V2_CONTINUE_SUMMARY=on --out b.json
    node scripts/token-bench.mjs --compare a.json b.json

The summary call is metered inside the continued turn (`/agent/v2/stream:continuation`, same request id), so the
billable numbers compare like for like. `perTurn[].continued` marks the continued turn. Gate (agent-kit plan 3.4):
on the long scenario the continued turn's billable tokens with the switch are at most 30% of the replay's, and
the 3-turn `ended-chat-continue` is unchanged (nothing is old enough to summarise). Check the recall answer by hand.
A `--fake` run shows the plumbing only.
```

In `docs/superpowers/MASTER-PLAN.md:496`, change `- [ ] Ended-chat continuation: per-chat summary on a cheap model plus last turns (X3, bench-gated) (me)` to `- [~] Ended-chat continuation: per-chat summary on a cheap model plus last turns (X3), built OFF behind \`LLMIDE_V2_CONTINUE_SUMMARY\` / desktop pref \`continueSummary\` (API 118, migration 0065, \`plans/2026-11-07-ended-chat-continuation.md\`); bench A/B \`ended-chat-continue-long\` pending Y1 (me, then you)`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd extension && node --test --experimental-strip-types tests/token-bench.test.mjs tests/agent-v2-continuation.test.mjs && npm run lint && cd .. && make token-bench-fake`
Expected: PASS. The fake bench exits 0 and lists the new scenario as "new" against the committed version-2 baseline.

- [ ] **Step 7: Full gate, then commit**

Run: `make regression`
Expected: PASS.

```bash
git add extension/llm_agent/sdk/bench-fake-engine.mjs extension/routes/agent-v2.mjs scripts/token-bench.mjs schema/bench/scenarios.json extension/tests/token-bench.test.mjs docs/how-to/run-the-token-bench.md docs/superpowers/MASTER-PLAN.md
git commit -m "feat(bench): ended-chat continuation scenario and per-turn continued flag"
```

---

## Decisions for the user (secure default first)

**User answer (2026-11-07):** all decisions = the defaults as written (ships off until the Y1 bench). Use the API version and migration numbers in `2026-11-07-day-run.md`.

| # | Decision | Default in this plan (secure first) | Alternatives |
|---|---|---|---|
| D1 | Ship state | **OFF** until your bench (Y1) passes the 3.4 gate (long seed at most 30% of replay, short seed unchanged) and a manual recall check | On by default after the gate |
| D2 | Switch name and home | Env `LLMIDE_V2_CONTINUE_SUMMARY=on` (exactly `on`, like the router switches) plus desktop pref `continueSummary` under Settings > Routing (beta), applied at the next backend start | The kit plan's `LLMIDE_V2_CONTINUE=replay\|summary` (breaks the "only ever `on`" prefs rule); env only, no pref |
| D3 | Surfaces | Desktop and clients that send history (bench, older clients). **Phone and web (Host API) excluded** because Host API v1 cannot show the "continued" notice, and a silent summary would hide that the model lost detail | Include Host API once v1 gets a continuation event (a Host API contract change plus iOS and web work) |
| D4 | When the summary is made | Lazily, on the first turn after the chat ended, cached by content hash (your brief) | At archive/quit time (the kit plan Q2 wording): no wait on the turn, but it pays for chats never reopened |
| D5 | "Ended" thresholds | Idle 5 min (cache TTL) **and** at least 24,000 chars of text; else resume | 60 min idle; only `fresh`/`no_session` (never pre-empt a resume) |
| D6 | Recent window | The last exchange always, then up to 6 turns within about 6,000 tokens | 4 turns; a larger budget |
| D7 | Summary model and data path | The **turn's own provider** at its fast tier (Haiku on Anthropic); a custom provider uses the chat's model; never another provider | Always Haiku (would send a custom-provider chat to Anthropic) |
| D8 | "Offer the full history" | Notice plus a one-shot "Send the full history with my next message" (`continueMode: 'replay'`, today's 60k-char replay); the chat view always keeps the whole history | A per-chat "never summarise" toggle; a re-run of the turn with full history |
| D9 | Older detail on demand | Not built: the summary keeps every user request, and the agent can ask the user | `search-kb` over chats or a `read-archived-chat` tool (kit Q-T5) |
| D10 | Storage | Main DB `chat_continuations`, redacted, deleted with the chat's messages and on account delete; client-made rows also at the quit purge | Do not store, regenerate each time (one model call per ended turn) |

## Self-review

- **Spec coverage:** S1 is in Task 2 (`endedReason`) and Task 3 (idle/warm/short tests). S2 is in Task 2 (`planContinuation` host-api) and Task 3 (`!switching && !adapterTurn`, host test). S3 is `recentCount` + `buildHandoff`. S4 is `summaryPrompt` + `fastModelFor(provider)`. S5 is Task 1 + the hash test. S6 is the `requestId` passthrough, the `SUMMARY_ENDPOINT` test, `commitTurnUsage`, and the bench `helperCalls` 0. S7 is the Task 3 notice test and Task 5 UI. S8 is the Task 1 deletes and redaction, and log fields that are counts only. S9 is the fallback test. S10 is Task 2 `continuationEnabled` and Task 6. S11 is Task 7. S12 is Task 4 with the full checklist.
- **Placeholder scan:** none. Every code step has the code. Task 1 Step 7 names the one test that may need its expected key list extended (`note-index-migration.test.mjs`), with the exact key.
- **Type consistency:** `planContinuation` returns `kind` `'replay' | 'summary'` as used in Task 3. `continuedNotice.data` keys `{ reason, coveredTurns, keptTurns, cached }` match the fixture, the schema text and the tests. `SUMMARY_ENDPOINT` is `/agent/v2/stream:continuation` everywhere and matches the bench's `LIKE '/agent/v2/stream:%'`. `continueMode: 'replay'` is the same in the schema, the route, the controller and the tests. The pref is `continue_summary` in Rust and `continueSummary` in JSON/TS.
- **Known limits (shortcut comments in code):** server chats are read up to their newest 2,000 messages. The idle size check counts chat text, not SDK tool output, so a tool-heavy short chat may still cold-resume. The summary's tokens are not subtracted from the same turn's `capRemaining`. The notice is not persisted with the reply, so it shows on the live turn only.
