# Slack Source — Phase 2a (Server Connector) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server-side Slack input connector — a Slack Web API fetcher + `/kb/slack/{test,fetch,seen}` routes + forward-only per-channel dedup tables — mirroring the email connector.

**Architecture:** `extension/agents/slack-source.mjs` is a pure transport+normalization layer over the Slack Web API (bot token passed in, never logged). `kb/router.mjs` exposes test/fetch/seen routes that read the token from the vault and own forward-only per-channel high-water + a seen-ledger in new SQLite tables. The Mac client (Phase 2b) turns returned messages into notes.

**Tech Stack:** Node ESM, `node:test` (`npm test`, runs locally), better-sqlite3 (via `kb/db.mjs`). Slack Web API over `https://slack.com/api/*` (fixed host — no SSRF surface, unlike IMAP). No new npm deps (uses global `fetch`).

**Spec:** `docs/superpowers/specs/2026-06-23-slack-source-design.md`

> **Twin reference:** every component mirrors the email connector — `extension/agents/email-source.mjs`, the `/kb/email/*` routes in `kb/router.mjs`, the `getEmailHighWater/setEmailHighWater/getEmailSeenIds/markEmailSeen` helpers in `kb/db.mjs`, and `kb/migrations/0013_email_state.sql`. Slack differs in: per-CHANNEL high-water (`last_ts` keyed by channel), Slack `ts` strings instead of message-ids, and a fixed API host (no DNS/SSRF code).

---

### Task 1: Migration + DB helpers for Slack dedup/high-water

Per-channel forward-only high-water + a seen-ledger, twinning `email_state`/`email_seen`.

**Files:**
- Create: `extension/kb/migrations/0017_slack_state.sql`
- Modify: `extension/kb/db.mjs` (add 4 helpers + a `SLACK_SEEN_MAX_PER_CALL` const)
- Test: `extension/tests/slack-state.test.mjs`

- [ ] **Step 1: Confirm the migration number**

Run: `ls extension/kb/migrations/ | sort | tail -1`
Expected: `0016_token_epoch.sql` → so the new file is `0017_slack_state.sql`. If the tail is higher than `0016`, use the next number instead and adjust the filename below.

- [ ] **Step 2: Write the migration**

Create `extension/kb/migrations/0017_slack_state.sql`:

```sql
-- Server-side Slack dedup + forward-only per-channel high-water (twin of
-- 0013_email_state.sql). Per CHANNEL because Slack `ts` ordering is
-- per-conversation; each channel advances its own watermark.
--
-- slack_seen   — one row per (user, message ts) already imported. Composite
--                PK gives INSERT OR IGNORE dedup for free.
-- slack_state  — one row per (user, channel) holding the last imported `ts`,
--                used as the `oldest` lower bound on the next fetch.

CREATE TABLE IF NOT EXISTS slack_seen (
  user_id    TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, message_ts)
);

CREATE TABLE IF NOT EXISTS slack_state (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_ts    TEXT,
  PRIMARY KEY (user_id, channel_id)
);
```

- [ ] **Step 3: Write the failing test**

Create `extension/tests/slack-state.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_slack-state-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');

function fresh() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

test('slack high-water is per-channel and round-trips', () => {
  fresh();
  try {
    assert.equal(db.getSlackHighWater('u1', 'C1'), null);
    db.setSlackHighWater('u1', 'C1', '1718900000.000100');
    db.setSlackHighWater('u1', 'C2', '1718900001.000200');
    assert.equal(db.getSlackHighWater('u1', 'C1'), '1718900000.000100');
    assert.equal(db.getSlackHighWater('u1', 'C2'), '1718900001.000200');
    // upsert advances in place
    db.setSlackHighWater('u1', 'C1', '1718900099.000300');
    assert.equal(db.getSlackHighWater('u1', 'C1'), '1718900099.000300');
  } finally { db.closeDb(); for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
});

test('slack seen-ledger dedups by ts', () => {
  fresh();
  try {
    assert.deepEqual(db.getSlackSeenTs('u1'), []);
    db.markSlackSeen('u1', ['1.1', '2.2', '1.1']); // dup ignored
    assert.deepEqual(db.getSlackSeenTs('u1').sort(), ['1.1', '2.2']);
    db.markSlackSeen('u1', ['2.2', '3.3']);        // re-mark is a no-op + add
    assert.deepEqual(db.getSlackSeenTs('u1').sort(), ['1.1', '2.2', '3.3']);
  } finally { db.closeDb(); for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd extension && node --test tests/slack-state.test.mjs 2>&1 | tail -15`
Expected: FAIL — `db.getSlackHighWater is not a function`.

- [ ] **Step 5: Add the DB helpers**

In `extension/kb/db.mjs`, near the email helpers (search for `getEmailHighWater`), add — and add the cap constant next to `EMAIL_SEEN_MAX_PER_CALL` (search it; use the same value):

```javascript
// --- Slack input state (twin of the email helpers; per-channel high-water) ---

export function getSlackHighWater(userId, channelId) {
  requireUser(userId);
  const db = getDb();
  const row = lazyPrepare(db,
    'SELECT last_ts FROM slack_state WHERE user_id = ? AND channel_id = ?',
  ).get(userId, channelId);
  return row?.last_ts ?? null;
}

export function setSlackHighWater(userId, channelId, ts) {
  requireUser(userId);
  const db = getDb();
  lazyPrepare(db, `
    INSERT INTO slack_state (user_id, channel_id, last_ts) VALUES (?, ?, ?)
    ON CONFLICT(user_id, channel_id) DO UPDATE SET last_ts = excluded.last_ts
  `).run(userId, channelId, typeof ts === 'string' ? ts : null);
}

export function getSlackSeenTs(userId) {
  requireUser(userId);
  const db = getDb();
  return lazyPrepare(db,
    'SELECT message_ts FROM slack_seen WHERE user_id = ?',
  ).all(userId).map((r) => r.message_ts);
}

export function markSlackSeen(userId, tsList) {
  requireUser(userId);
  if (!Array.isArray(tsList)) return;
  const ids = tsList
    .filter((x) => typeof x === 'string' && x)
    .slice(0, SLACK_SEEN_MAX_PER_CALL);
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = lazyPrepare(db,
    'INSERT OR IGNORE INTO slack_seen (user_id, message_ts) VALUES (?, ?)',
  );
  const tx = db.transaction((rows) => { for (const ts of rows) stmt.run(userId, ts); });
  tx(ids);
}
```

Add the cap constant near `EMAIL_SEEN_MAX_PER_CALL` (mirror its value, e.g. 5000):

```javascript
const SLACK_SEEN_MAX_PER_CALL = 5000;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd extension && node --test tests/slack-state.test.mjs 2>&1 | tail -8`
Expected: PASS — `pass 2`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add extension/kb/migrations/0017_slack_state.sql extension/kb/db.mjs extension/tests/slack-state.test.mjs
git commit -m "feat(server): Slack dedup/high-water tables + db helpers" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `slack-source.mjs` — the Slack Web API fetcher

Pure transport + normalization over the Slack Web API. Token passed in, never logged. Fixed host `slack.com` (no SSRF/DNS code).

**Files:**
- Create: `extension/agents/slack-source.mjs`
- Test: `extension/tests/slack-source.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `extension/tests/slack-source.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMrkdwn, normalizeMessage } from '../agents/slack-source.mjs';

test('stripMrkdwn unwraps links and decodes entities', () => {
  // Slack mrkdwn link forms: <url|label> and <url>, plus &amp;/&lt;/&gt;.
  assert.equal(stripMrkdwn('see <https://x.com|the docs> &amp; more'), 'see the docs & more');
  assert.equal(stripMrkdwn('raw <https://x.com>'), 'raw https://x.com');
  assert.equal(stripMrkdwn('a &lt;b&gt; c'), 'a <b> c');
  assert.equal(stripMrkdwn(''), '');
});

test('normalizeMessage produces the stable shape with resolved user name', () => {
  const raw = { ts: '1718900000.000100', user: 'U123', text: 'hi <@U999>', thread_ts: '1718900000.000100' };
  const out = normalizeMessage(raw, 'C1', 'Alice');
  assert.equal(out.ts, '1718900000.000100');
  assert.equal(out.channelId, 'C1');
  assert.equal(out.user, 'Alice');
  assert.equal(out.threadTs, '1718900000.000100');
  assert.ok(out.text.includes('hi'));
});

test('normalizeMessage falls back to the user id when no name is known', () => {
  const out = normalizeMessage({ ts: '1.1', user: 'U7', text: 'x' }, 'C1', null);
  assert.equal(out.user, 'U7');
  assert.equal(out.threadTs, null); // no thread_ts → null
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && node --test tests/slack-source.test.mjs 2>&1 | tail -15`
Expected: FAIL — cannot find module `../agents/slack-source.mjs`.

- [ ] **Step 3: Write the connector**

Create `extension/agents/slack-source.mjs`:

```javascript
// Slack input source — a thin Slack Web API fetcher (twin of email-source.mjs).
// The server connects to Slack with the user's bot token, pulls recent channel
// messages, and hands back normalized JSON. The Mac client turns those rows
// into notes; zero note-domain logic lives here.
//
// Split: stripMrkdwn/normalizeMessage are PURE (unit-tested); testConnection/
// fetchChannelHistory own the network. The bot token flows in as an argument
// (resolved from the vault by the caller) and is NEVER logged.
//
// Host is fixed (https://slack.com/api/*), so unlike the IMAP connector there
// is no DNS resolution / SSRF surface.

const API = 'https://slack.com/api';

// Caps mirroring email: bound the payload + per-message text.
const MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 20000;
const FETCH_DEADLINE_MS = 90_000;

// PURE. Slack mrkdwn → plain text: unwrap <url|label> and <url>, strip the
// leftover angle brackets on <@U…>/<#C…> mentions, decode the three entities
// Slack escapes (& < >). Dependency-free; exported for unit testing.
export function stripMrkdwn(text) {
  if (!text) return '';
  return String(text)
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')   // <url|label> → label
    .replace(/<([^>|]+)>/g, '$1')            // <url> / <@U..> / <#C..> → inner
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// PURE. Normalize a raw Slack message + a resolved display name into the stable
// shape the client expects. `userName` is the resolved name or null (→ fall
// back to the raw user id). Missing thread_ts → null.
export function normalizeMessage(raw, channelId, userName) {
  let text = stripMrkdwn(raw.text || '');
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[...truncated]';
  return {
    ts: String(raw.ts),
    channelId,
    user: userName || raw.user || 'unknown',
    text,
    threadTs: raw.thread_ts ? String(raw.thread_ts) : null,
  };
}

// Call a Slack Web API method with the bot token. Slack returns HTTP 200 with
// `{ ok: false, error }` on logical failures, so we check `ok` and throw a
// clean Error. `signal` bounds the call.
async function slackCall(method, token, params, signal) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}/${method}?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'invalid_response' }));
  if (!data.ok) throw new Error(friendlyError(data.error));
  return data;
}

// Map Slack error codes to human-readable messages.
function friendlyError(code) {
  switch (code) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':   return 'Slack auth failed — check the bot token';
    case 'not_in_channel':
    case 'channel_not_found': return 'The bot is not in that channel (invite it, or check the channel id)';
    case 'ratelimited':     return 'Slack rate limit hit — try again shortly';
    default:                return `Slack API error: ${code || 'unknown'}`;
  }
}

// Verify the token. Used by the client's "Test connection" button.
export async function testConnection({ token }) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const r = await slackCall('auth.test', token, {}, ctrl.signal);
    return { ok: true, team: r.team || '', user: r.user || '' };
  } finally { clearTimeout(killer); }
}

// Resolve a set of user ids → display names, caching within this fetch so we
// call users.info at most once per distinct user. Failures degrade to null.
async function resolveUserNames(ids, token, signal) {
  const names = new Map();
  for (const id of new Set(ids)) {
    if (!id) continue;
    try {
      const r = await slackCall('users.info', token, { user: id }, signal);
      names.set(id, r.user?.profile?.display_name || r.user?.real_name || r.user?.name || null);
    } catch { names.set(id, null); }
  }
  return names;
}

// Fetch messages in `channelId` newer than `oldestTs` (forward-only). Drops
// already-seen ts's, caps the count (newest kept), resolves user names, and
// normalizes. Returns { messages, skipped: { overCap } }.
export async function fetchChannelHistory({ token, channelId, oldestTs, seenTs }) {
  const seen = seenTs instanceof Set ? seenTs : new Set(seenTs || []);
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const params = { channel: channelId, limit: String(MAX_MESSAGES + 50) };
    if (oldestTs) params.oldest = oldestTs;
    const r = await slackCall('conversations.history', token, params, ctrl.signal);
    const raw = (r.messages || [])
      .filter((m) => m.type === 'message' && !m.subtype) // skip joins/bot/system
      .filter((m) => !seen.has(String(m.ts)));
    // Newest-first from Slack; cap to MAX_MESSAGES.
    const skipped = { overCap: Math.max(0, raw.length - MAX_MESSAGES) };
    const selected = raw.slice(0, MAX_MESSAGES);
    const names = await resolveUserNames(selected.map((m) => m.user), token, ctrl.signal);
    const messages = selected.map((m) => normalizeMessage(m, channelId, names.get(m.user) ?? null));
    return { messages, skipped };
  } finally { clearTimeout(killer); }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd extension && node --test tests/slack-source.test.mjs 2>&1 | tail -8`
Expected: PASS — `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add extension/agents/slack-source.mjs extension/tests/slack-source.test.mjs
git commit -m "feat(server): slack-source — Slack Web API fetcher + normalization" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `/kb/slack/{test,fetch,seen}` routes + endpoint registration

Wire the connector behind routes mirroring the email routes; token from the vault, forward-only per-channel high-water owned server-side.

**Files:**
- Modify: `extension/kb/router.mjs` (import the connector + db helpers; add the three routes next to the email routes)
- Modify: `extension/server.mjs` (add the three paths to the `ENDPOINTS` list + the rate-limit buckets, mirroring `/kb/email/*`)

- [ ] **Step 1: Import the connector + helpers in `router.mjs`**

At the top of `kb/router.mjs`, alongside the email-source import (search `email-source.mjs`), add:

```javascript
import { testConnection as slackTest, fetchChannelHistory } from '../agents/slack-source.mjs';
```

The `kb` namespace already exposes db helpers (it's `import * as kb` or similar — match how `kb.getEmailHighWater` is referenced); the new `getSlackHighWater`/`setSlackHighWater`/`getSlackSeenTs`/`markSlackSeen` are reached the same way.

- [ ] **Step 2: Add the routes**

In `kb/router.mjs`, immediately after the email `/kb/email/seen` route block, add:

```javascript
    // --- Slack input (twin of /kb/email/*) ---
    if (req.method === 'POST' && (url === '/kb/slack/test' || url === '/kb/slack/fetch')) {
      const body = parseJSON(await readBody(req)) || {};
      const token = getSecret(kb.getDb(), userId, 'slack.botToken');
      if (!token) {
        sendJSON(res, 400, { error: { code: 'SLACK_NO_TOKEN', message: 'No Slack bot token saved. Save one first.' } });
        return true;
      }

      if (url === '/kb/slack/test') {
        try {
          const r = await slackTest({ token });
          logger.info('slack_test', { userId, team: r.team });
          sendJSON(res, 200, r);
        } catch (e) {
          logger.error('slack_test_failed', { userId, reason: e.message });
          sendJSON(res, 502, { error: { code: 'SLACK_CONNECT_FAILED', message: e.message } });
        }
        return true;
      }

      // url === '/kb/slack/fetch'
      const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
      if (!channelId) {
        sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'channelId is required' } });
        return true;
      }
      const seenTs = kb.getSlackSeenTs(userId);
      const oldestTs = kb.getSlackHighWater(userId, channelId);  // server-owned, forward-only
      const started = Date.now();
      try {
        const { messages, skipped } = await fetchChannelHistory({ token, channelId, oldestTs, seenTs });
        logger.info('slack_fetch', { userId, channelId, count: messages.length, durationMs: Date.now() - started, skipped });
        sendJSON(res, 200, { messages, skipped });
      } catch (e) {
        logger.error('slack_fetch_failed', { userId, channelId, reason: e.message });
        sendJSON(res, 502, { error: { code: 'SLACK_FETCH_FAILED', message: e.message } });
      }
      return true;
    }

    // Slack dedup write-back: after the client makes notes it reports the
    // imported message ts's + advances the per-channel high-water. Local
    // writes only (no Slack call) — cheap kbWrite.
    if (req.method === 'POST' && url === '/kb/slack/seen') {
      const body = parseJSON(await readBody(req)) || {};
      const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
      const tsList = Array.isArray(body.messageTs) ? body.messageTs : [];
      kb.markSlackSeen(userId, tsList);
      if (channelId && typeof body.lastTs === 'string' && body.lastTs) {
        kb.setSlackHighWater(userId, channelId, body.lastTs);
      }
      sendJSON(res, 200, { ok: true });
      return true;
    }
```

- [ ] **Step 3: Register the endpoints + rate-limit buckets in `server.mjs`**

In `extension/server.mjs`, find the `ENDPOINTS` list and the rate-limit bucket mapping that includes `/kb/email/test`/`/kb/email/fetch` (`dispatch` bucket) and `/kb/email/seen` (`kbWrite`). Add the Slack equivalents in the same places:
- Add `/kb/slack/test`, `/kb/slack/fetch`, `/kb/slack/seen` to `ENDPOINTS`.
- Map `/kb/slack/test` + `/kb/slack/fetch` → the `dispatch` bucket (external API), `/kb/slack/seen` → `kbWrite` (local), exactly as the email routes are mapped.

Run to confirm the exact lines: `grep -n "kb/email/test\|kb/email/seen\|ENDPOINTS" extension/server.mjs`

- [ ] **Step 4: Run the full extension suite (no regression) + lint**

Run: `cd extension && npm test 2>&1 | tail -8`
Expected: all pass (includes the new `slack-state` + `slack-source` tests).
Run: `cd extension && npx eslint --max-warnings 0 kb/router.mjs server.mjs agents/slack-source.mjs kb/db.mjs 2>&1 | tail -5 && echo clean`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add extension/kb/router.mjs extension/server.mjs
git commit -m "feat(server): /kb/slack/{test,fetch,seen} routes (vault token, forward-only)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** server connector `slack-source.mjs` → Task 2; `/kb/slack/{test,fetch,seen}` routes → Task 3; vault `slack.botToken` → Task 3; `slack_state`/`slack_seen` + db helpers + migration `0017` → Task 1; rate-limit buckets + ENDPOINTS → Task 3; pure-helper + db round-trip tests → Tasks 1–2. Mac side (`SlackSource`, `+Slack`, config, sheet, card, registry) is Phase 2b (separate plan). ✔
- **Placeholder scan:** none — full code for the migration, db helpers, connector, routes; the two "match how the twin is referenced" notes (kb namespace import style, server.mjs bucket lines) point at exact greppable anchors rather than leaving content vague. ✔
- **Type consistency:** `getSlackHighWater(userId, channelId)`/`setSlackHighWater(userId, channelId, ts)`/`getSlackSeenTs(userId)`/`markSlackSeen(userId, tsList)` defined in Task 1 and called identically in Task 3; `testConnection({token})`/`fetchChannelHistory({token,channelId,oldestTs,seenTs})` defined in Task 2 and called with the same shape in Task 3; the normalized message shape `{ts,channelId,user,text,threadTs}` is what Phase 2b will consume. ✔
