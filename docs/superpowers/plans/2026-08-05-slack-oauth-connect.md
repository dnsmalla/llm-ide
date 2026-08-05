# Slack One-Click OAuth Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Slack's manual "paste a bot token, type channel IDs, invite the bot" setup with a single "Connect Slack" button — hosted OAuth (LLM-IDE owns one Slack App), a user-token flow (reads channels the user already belongs to, no bot invite), and an auto-discovered channel checklist.

**Architecture:** Mirrors the existing Google OAuth loopback-and-poll pattern (`agents/google-oauth.mjs` + `/auth/google/{start,callback,status}`) file-for-file, with one structural difference: Google's flow is bring-your-own (client id/secret come from the user, stored per-user); Slack's is hosted (client id/secret live in server env vars, never per-user, never on the wire to the Mac). `agents/slack-source.mjs`'s existing Web API calls are already Bearer-token-shape-agnostic, so the fetch path needs only an added channel-listing call, not a rewrite.

**Tech Stack:** Node 20+ (server, `node --test`), Swift 6 / SwiftUI (Mac, `swift build`/`swift test`), no new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-05-slack-oauth-connect-design.md`](../specs/2026-08-05-slack-oauth-connect-design.md)

## Global Constraints

- **Client secret stays server-side, via env var, never hardcoded.** `LLMIDE_SLACK_CLIENT_ID` / `LLMIDE_SLACK_CLIENT_SECRET` in `extension/core/config.mjs`. Never in the vault, never in a config file, never sent to the Mac.
- **Backward compatibility is mandatory.** Existing users with a stored `slack.botToken` must keep working unmodified. Every place that reads a Slack token resolves `slack.userToken` first, falling back to `slack.botToken`.
- **Follow the existing Google OAuth pattern exactly** where it applies (state store shape, TTL, single-use, redact-before-surfacing, ownership check on `/status`). Don't invent a different shape for Slack.
- **Per the invariants doc:** any new `/kb/*` route gets added to `server.mjs`'s `ENDPOINTS` array and bumps `SERVER_API_VERSION`. `/auth/*` routes are NOT added there — confirmed by checking `server.mjs`: no existing `/auth/google/*` route appears in `ENDPOINTS` either, so `/auth/slack/*` follows the same precedent.
- **Conventional Commits, one concern per commit.**

## File Structure

- **Create** `extension/agents/slack-oauth.mjs` — pure OAuth mechanics (authorize URL, code exchange, state store), mirrors `agents/google-oauth.mjs`.
- **Create** `extension/tests/slack-oauth.test.mjs`.
- **Modify** `extension/core/config.mjs` — add `slackClientId`/`slackClientSecret`.
- **Modify** `extension/server/vault.mjs` — add `slack.userToken` to `ALLOWED_KEYS`.
- **Modify** `extension/server/auth.mjs` — add `/auth/slack/callback` to `PUBLIC_PATHS`.
- **Modify** `extension/tests/vault.test.mjs` — round-trip test for the new key.
- **Modify** `extension/server/auth-routes.mjs` — three new routes: `POST /auth/slack/start`, `GET /auth/slack/callback`, `GET /auth/slack/status`.
- **Create** `extension/tests/slack-oauth-routes.test.mjs` (client id/secret configured — happy + error paths).
- **Create** `extension/tests/slack-oauth-routes-unconfigured.test.mjs` (client id/secret NOT set — 503 path). Separate file/process because `config.mjs` freezes its object at first import; this is the only way to exercise both the configured and unconfigured branch with Node's per-file test-process model.
- **Modify** `extension/agents/slack-source.mjs` — add `listUserConversations()`; generalize one error message.
- **Modify** `extension/tests/slack-source.test.mjs` — tests for `listUserConversations()`.
- **Modify** `extension/kb/router.mjs` — add `resolveSlackToken()` helper, use it in the existing `/kb/slack/test`/`/kb/slack/fetch` handler, add `GET /kb/slack/conversations`.
- **Create** `extension/tests/kb-router-slack.test.mjs`.
- **Modify** `extension/server.mjs` — add `/kb/slack/conversations` to `ENDPOINTS`, bump `SERVER_API_VERSION` 21 → 22.
- **Modify** `mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift` — `secretKeys(.slack)` gains `"slack.userToken"`.
- **Modify** `mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift` — new test case.
- **Modify** `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift` — add `slackConnectStart()`, `slackConnectStatus(state:)`, `fetchSlackConversations()`, `SlackConversation`.
- **Modify** `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift` — inject `sourceLinks` into the Slack sheet presentation.
- **Modify** `mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift` — full rework: Connect button, channel checklist, collapsed Advanced manual-token fallback.

---

### Task 1: `agents/slack-oauth.mjs` — pure OAuth mechanics

**Files:**
- Create: `extension/agents/slack-oauth.mjs`
- Test: `extension/tests/slack-oauth.test.mjs`

**Interfaces:**
- Produces: `buildAuthUrl({clientId, redirectUri, state})`, `exchangeCode({clientId, clientSecret, code, redirectUri}) -> {accessToken, teamName}`, `putState/getState/completeState/takeStatus` (state store, mirrors `agents/google-oauth.mjs`'s but with no PKCE verifier and carrying `teamName`/`channels` instead of `email`).
- **Post-review update:** Task 1's code quality review renamed `team` → `teamName` (avoids colliding with `slack-source.mjs`'s existing `team` = team **ID** convention) and split the token-exchange error into two branches (transport/API failure vs. missing `authed_user`, with a message naming the real cause). The code blocks below in Tasks 3/5 already reflect `teamName`.
- Consumed by: Task 3 (`auth-routes.mjs`).

- [ ] **Step 1: Write the failing test**

Create `extension/tests/slack-oauth.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthUrl, exchangeCode, putState, getState, completeState, takeStatus } from '../agents/slack-oauth.mjs';

test('buildAuthUrl includes client_id, redirect_uri, user_scope (no bot scope), state', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:3456/auth/slack/callback', state: 'st' }));
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:3456/auth/slack/callback');
  assert.equal(u.searchParams.get('user_scope'), 'channels:history,groups:history,channels:read,groups:read,users:read');
  assert.equal(u.searchParams.get('scope'), null, 'no bot scope requested — no bot user should be installed');
  assert.equal(u.searchParams.get('state'), 'st');
});

test('exchangeCode posts and parses the user token + team name', async () => {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://slack.com/api/oauth.v2.access');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'CODE');
    assert.equal(body.get('client_id'), 'c');
    assert.equal(body.get('client_secret'), 's');
    return {
      ok: true,
      json: async () => ({ ok: true, authed_user: { access_token: 'xoxp-abc' }, team: { name: 'Acme' } }),
    };
  };
  try {
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'CODE', redirectUri: 'http://127.0.0.1:3456/auth/slack/callback' });
    assert.deepEqual(t, { accessToken: 'xoxp-abc', team: 'Acme' });
  } finally { global.fetch = orig; }
});

test('exchangeCode throws a clean error when Slack reports ok:false', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'invalid_code' }) });
  try {
    await assert.rejects(
      () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'bad', redirectUri: 'r' }),
      /invalid_code/,
    );
  } finally { global.fetch = orig; }
});

test('exchangeCode throws when the HTTP request itself fails', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await assert.rejects(
      () => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }),
      /500/,
    );
  } finally { global.fetch = orig; }
});

test('state store: put/get/complete/take with single-use status, carrying team + channels', () => {
  putState('S1', { userId: 'u1' });
  assert.equal(getState('S1').userId, 'u1');
  completeState('S1', { status: 'complete', team: 'Acme', channels: [{ id: 'C1', name: 'general' }] });
  assert.deepEqual(takeStatus('S1'), { status: 'complete', team: 'Acme', channels: [{ id: 'C1', name: 'general' }] });
  // status is single-read: after take it's gone (or pending→unknown)
  assert.equal(getState('S1'), undefined);
});

test('getState returns undefined for an unknown state', () => {
  assert.equal(getState('does-not-exist'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/slack-oauth.test.mjs`
Expected: FAIL — `Cannot find module '../agents/slack-oauth.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `extension/agents/slack-oauth.mjs`:

```javascript
// Slack OAuth v2 (user-token flow, hosted app). LLM-IDE owns a single Slack
// App registration — client_id/client_secret live in server env vars
// (config.slackClientId/slackClientSecret), never per-user, never on the
// wire to the Mac. Requests `user_scope` only (no bot `scope`), so no bot
// user gets installed — the resulting authed_user.access_token (xoxp-...)
// reads channels/groups the individual user already belongs to.

const AUTHORIZE_ENDPOINT = 'https://slack.com/oauth/v2/authorize';
const TOKEN_ENDPOINT = 'https://slack.com/api/oauth.v2.access';
const USER_SCOPE = 'channels:history,groups:history,channels:read,groups:read,users:read';
const STATE_TTL_MS = 10 * 60 * 1000;

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const u = new URL(AUTHORIZE_ENDPOINT);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    user_scope: USER_SCOPE,
    state,
  }).toString();
  return u.toString();
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId, client_secret: clientSecret,
      code, redirect_uri: redirectUri,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || !data.authed_user?.access_token) {
    throw new Error(`Slack token exchange failed: ${data.error || res.status}`);
  }
  return { accessToken: data.authed_user.access_token, team: data.team?.name || '' };
}

// In-memory OAuth state store (single-node; TTL-swept). Mirrors
// agents/google-oauth.mjs's store; kept as its own module (not shared) so
// each provider's state shape stays isolated — this one carries no PKCE
// verifier and completes with team/channels instead of email.
const _states = new Map();
function sweep() {
  const now = Date.now();
  for (const [k, v] of _states) if (now - v.createdAt > STATE_TTL_MS) _states.delete(k);
}
export function putState(state, data) { sweep(); _states.set(state, { ...data, status: 'pending', createdAt: Date.now() }); }
export function getState(state) { const v = _states.get(state); if (!v) return undefined; if (Date.now() - v.createdAt > STATE_TTL_MS) { _states.delete(state); return undefined; } return v; }
export function completeState(state, patch) { const v = _states.get(state); if (v) _states.set(state, { ...v, ...patch }); }
// Read the terminal status once and remove it (single-use).
export function takeStatus(state) {
  const v = _states.get(state);
  if (!v) return { status: 'unknown' };
  if (v.status !== 'pending') _states.delete(state);
  const out = { status: v.status };
  if (v.team !== undefined) out.team = v.team;
  if (v.channels !== undefined) out.channels = v.channels;
  if (v.message !== undefined) out.message = v.message;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/slack-oauth.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/agents/slack-oauth.mjs extension/tests/slack-oauth.test.mjs
git commit -m "feat(server): Slack OAuth v2 mechanics (agents/slack-oauth.mjs)"
```

---

### Task 2: Vault key, config env vars, public-path allowlist

**Files:**
- Modify: `extension/server/vault.mjs`
- Modify: `extension/core/config.mjs`
- Modify: `extension/server/auth.mjs`
- Modify: `extension/tests/vault.test.mjs`

**Interfaces:**
- Produces: `'slack.userToken'` as an allowed vault key; `config.slackClientId`/`config.slackClientSecret` (`undefined` when the env vars are unset); `/auth/slack/callback` recognized as public.
- Consumed by: Task 3 (routes read `config.slackClientId/slackClientSecret`, write `slack.userToken`).

- [ ] **Step 1: Write the failing test**

In `extension/tests/vault.test.mjs`, add this test immediately after the existing `test('slack.botToken is an allowed vault key and round-trips', ...)` block (after its closing `});`, currently ending at line 42):

```javascript
// The hosted Slack OAuth flow (agents/slack-oauth.mjs, /auth/slack/callback)
// stores the connected user's token under `slack.userToken`. If the key is
// not allow-listed, the callback's setSecret throws and every "Connect
// Slack" attempt fails after a successful browser consent.
test('slack.userToken is an allowed vault key and round-trips', () => {
  assert.ok(VAULT_KEYS.includes('slack.userToken'), 'slack.userToken must be allow-listed');
  const db = secretsDb();
  const userId = 'user-slack-2';
  assert.doesNotThrow(() => setSecret(db, userId, 'slack.userToken', 'xoxp-abc-123'));
  assert.equal(getSecret(db, userId, 'slack.userToken'), 'xoxp-abc-123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/vault.test.mjs`
Expected: FAIL — `slack.userToken must be allow-listed` (setSecret throws "Unknown vault key").

- [ ] **Step 3: Write the implementation**

In `extension/server/vault.mjs`, in the `ALLOWED_KEYS` set, add the new key right after `'slack.botToken',`:

```javascript
  // Slack bot token (xoxb-…) for the Slack input source. The Mac client stores
  // it here via /auth/me/secrets (SlackSourceSheet); the server reads it back in
  // /kb/slack/test and /kb/slack/fetch to read channel messages.
  'slack.botToken',
  // Slack user token (xoxp-…), minted by the hosted OAuth flow
  // (agents/slack-oauth.mjs, /auth/slack/callback) after the user connects via
  // "Connect Slack". Preferred over slack.botToken when both are present (see
  // kb/router.mjs resolveSlackToken) — reads channels/groups the user already
  // belongs to, no bot-invite step required.
  'slack.userToken',
```

In `extension/core/config.mjs`, insert this block right after the `// Vault` section (after the `vaultKey: _vaultKey,` line):

```javascript
  // Slack hosted OAuth app (agents/slack-oauth.mjs). LLM-IDE owns ONE Slack
  // App registration — these are the app's own client id/secret, never
  // per-user, never in the vault. Optional: /auth/slack/start returns a
  // clear "not configured" error when unset instead of proceeding with
  // undefined credentials.
  slackClientId:     envStr('LLMIDE_SLACK_CLIENT_ID'),
  slackClientSecret: envStr('LLMIDE_SLACK_CLIENT_SECRET'),
```

In `extension/server/auth.mjs`, in `PUBLIC_PATHS`, add the new entry right after `'/auth/google/callback',`:

```javascript
  '/auth/google/callback',             // Google's OAuth redirect carries no bearer token
  '/auth/slack/callback',              // Slack's OAuth redirect carries no bearer token
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/vault.test.mjs`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add extension/server/vault.mjs extension/core/config.mjs extension/server/auth.mjs extension/tests/vault.test.mjs
git commit -m "feat(server): slack.userToken vault key + hosted Slack app config"
```

---

### Task 3: `/auth/slack/{start,callback,status}` routes

**Files:**
- Modify: `extension/server/auth-routes.mjs`
- Test: `extension/tests/slack-oauth-routes.test.mjs` (create)
- Test: `extension/tests/slack-oauth-routes-unconfigured.test.mjs` (create)

**Interfaces:**
- Consumes: `buildAuthUrl`, `exchangeCode`, `putState`, `getState`, `completeState`, `takeStatus` from `agents/slack-oauth.mjs` (Task 1); `listUserConversations` from `agents/slack-source.mjs` (added in Task 4 — see note below); `config.slackClientId`/`slackClientSecret` (Task 2); `setSecret` (existing); `redactWithKey` (existing).
- Produces: `POST /auth/slack/start` (authed), `GET /auth/slack/callback` (public), `GET /auth/slack/status` (authed).

> **Note on ordering:** `listUserConversations` is implemented in Task 4, but the callback route calls it. Task 3's tests stub the channel-listing behavior at the HTTP level (via `global.fetch`), so this task does not require Task 4 to exist first — the import is added now and Task 4 fills in the function body. If running tasks out of order, complete Task 4 before Task 3 to avoid a temporarily-missing export; the steps below assume in-order execution and import a not-yet-defined-until-Task-4 export, which is fine because Task 4 lands before this task's tests run in the full regression pass (Task 7). To keep each task's own test run green in isolation, do Task 4 before Task 3 if executing out of order.
>
> **Post-review update:** Task 4's code quality review changed `listUserConversations({token})`'s return shape from a bare `[{id,name}]` array to `{ channels: [{id,name}], complete: boolean }` (so a partial/failed fetch is distinguishable from "zero channels"). The callback code below already reflects this (`const { channels } = await listUserConversations(...)`).

- [ ] **Step 1: Write the failing tests**

Create `extension/tests/slack-oauth-routes-unconfigured.test.mjs` (no `LLMIDE_SLACK_CLIENT_ID`/`SECRET` set — proves the 503 path; kept in its own file because `core/config.mjs` freezes its config object at first import, so the configured/unconfigured branches can't share a process):

```javascript
// HTTP-level test for /auth/slack/start when the server has no hosted Slack
// App credentials configured. Kept in its own file/process — config.mjs
// freezes its config object at first import, so this env-var state can't
// coexist with the "configured" tests in slack-oauth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
delete process.env.LLMIDE_SLACK_CLIENT_ID;
delete process.env.LLMIDE_SLACK_CLIENT_SECRET;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_slack-oauth-routes-unconfigured-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const { handleAuth } = await import('../server/auth-routes.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, headers: {}, user,
    socket: { remoteAddress: `10.20.0.${++ipCounter}` },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
async function callAuth(reqOpts) {
  const req = makeReq(reqOpts);
  const res = makeRes();
  await handleAuth(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });
  return res;
}

async function registerAndLogin() {
  const email = `slack-unconfigured-${Date.now()}@example.com`;
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: 'CorrectHorseBattery', displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: 'CorrectHorseBattery' } });
  assert.equal(login.statusCode, 200, login._body);
  return { ...login.json() };
}

test('POST /auth/slack/start returns 503 CONFIG_MISSING when the server has no Slack App credentials', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  assert.equal(res.statusCode, 503, res._body);
  assert.equal(res.json().error.code, 'CONFIG_MISSING');
});
```

Create `extension/tests/slack-oauth-routes.test.mjs` (client id/secret set — happy path + error paths, mirrors `google-oauth-routes.test.mjs`'s structure):

```javascript
// HTTP-level tests for the /auth/slack/{start,callback,status} routes in
// server/auth-routes.mjs, with the hosted Slack App credentials configured.
// Follows the same req/res double pattern as google-oauth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
process.env.LLMIDE_SLACK_CLIENT_ID = 'test-slack-client-id';
process.env.LLMIDE_SLACK_CLIENT_SECRET = 'test-slack-client-secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_slack-oauth-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const { handleAuth } = await import('../server/auth-routes.mjs');
const { getSecret } = await import('../server/vault.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, headers: {}, user,
    socket: { remoteAddress: `10.30.0.${++ipCounter}` },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
async function callAuth(reqOpts) {
  const req = makeReq(reqOpts);
  const res = makeRes();
  await handleAuth(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });
  return res;
}

let emailCounter = 0;
function uniqueEmail() { return `slack-oauth-routes-${Date.now()}-${++emailCounter}@example.com`; }
const PASSWORD = 'CorrectHorseBattery';

async function registerAndLogin() {
  const email = uniqueEmail();
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD, displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login._body);
  return { email, ...login.json() };
}

function stubSlackFetch({ tokenOk = true, conversationsOk = true } = {}) {
  const orig = global.fetch;
  let tokenExchangeCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth.v2.access')) {
      tokenExchangeCalls++;
      if (!tokenOk) return { ok: true, json: async () => ({ ok: false, error: 'invalid_code' }) };
      return { ok: true, json: async () => ({ ok: true, authed_user: { access_token: 'xoxp-flow-token' }, team: { name: 'Acme' } }) };
    }
    if (u.includes('users.conversations')) {
      if (!conversationsOk) return { ok: true, json: async () => ({ ok: false, error: 'ratelimited' }) };
      return { ok: true, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }], response_metadata: { next_cursor: '' } }) };
    }
    throw new Error(`Unexpected fetch to ${u}`);
  };
  return { restore: () => { global.fetch = orig; }, callCount: () => tokenExchangeCalls };
}

// ---- POST /auth/slack/start (authed) -----------------------------------

test('POST /auth/slack/start requires auth', async () => {
  const res = await callAuth({ method: 'POST', url: '/auth/slack/start' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');
});

test('POST /auth/slack/start returns authUrl+state carrying the configured client id, no client secret', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  assert.ok(typeof body.state === 'string' && body.state.length > 10, 'state issued');
  assert.ok(body.authUrl.includes('client_id=test-slack-client-id'));
  assert.ok(!body.authUrl.includes('test-slack-client-secret'), 'client secret must never appear in the authUrl');
});

// ---- GET /auth/slack/callback (public) ---------------------------------

test('GET /auth/slack/callback with unknown state → error HTML, no throw', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/slack/callback?code=abc&state=does-not-exist' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'] || '', /text\/html/);
  assert.match(res._body, /expired|start again/i);
});

test('GET /auth/slack/callback?error=... marks a known state as cancelled', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  const { state } = start.json();

  const cb = await callAuth({ method: 'GET', url: `/auth/slack/callback?error=access_denied&state=${state}` });
  assert.equal(cb.statusCode, 200);
  assert.match(cb._body, /cancelled/i);

  const status = await callAuth({ method: 'GET', url: `/auth/slack/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, 'error');
});

test('full flow: start -> callback (token exchange + channel prefetch) -> status complete with team + channels', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  assert.equal(start.statusCode, 200, start._body);
  const { state } = start.json();

  const stub = stubSlackFetch();
  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=auth-code-789&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.match(cb._body, /Connected to Slack/i);
  } finally { stub.restore(); }

  // Side effect: user token persisted to vault under slack.userToken.
  assert.equal(getSecret(kb.getDb(), user.id, 'slack.userToken'), 'xoxp-flow-token');

  const status = await callAuth({ method: 'GET', url: `/auth/slack/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.statusCode, 200, status._body);
  const statusBody = status.json();
  assert.equal(statusBody.status, 'complete');
  assert.equal(statusBody.teamName, 'Acme');
  assert.deepEqual(statusBody.channels, [{ id: 'C1', name: 'general' }]);
});

test('GET /auth/slack/callback still completes when channel prefetch fails (fail-soft)', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  const { state } = start.json();

  const stub = stubSlackFetch({ conversationsOk: false });
  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=auth-code&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.match(cb._body, /Connected to Slack/i);
  } finally { stub.restore(); }

  assert.equal(getSecret(kb.getDb(), user.id, 'slack.userToken'), 'xoxp-flow-token');
  const status = await callAuth({ method: 'GET', url: `/auth/slack/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.json().status, 'complete');
  assert.deepEqual(status.json().channels, [], 'empty channel list on prefetch failure, not an error status');
});

test('GET /auth/slack/callback rejects a second callback that reuses an already-completed state', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  const { state } = start.json();

  const stub = stubSlackFetch();
  try {
    const cb1 = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=first&state=${state}` });
    assert.equal(cb1.statusCode, 200, cb1._body);
    assert.match(cb1._body, /Connected to Slack/i);
    assert.equal(stub.callCount(), 1);

    const cb2 = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=second&state=${state}` });
    assert.equal(cb2.statusCode, 200, cb2._body);
    assert.match(cb2._body, /already been used/i);
    assert.equal(stub.callCount(), 1, 'token exchange must not be re-run for a non-pending state');
  } finally { stub.restore(); }
});

test('GET /auth/slack/callback surfaces a clean error and redacts the client secret on exchange failure', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  const { state } = start.json();

  const stub = stubSlackFetch({ tokenOk: false });
  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=bad&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.match(cb._body, /failed/i);
    assert.ok(!cb._body.includes('test-slack-client-secret'), 'client secret must never leak into the error HTML');
  } finally { stub.restore(); }
});

// ---- GET /auth/slack/status (authed) -----------------------------------

test('GET /auth/slack/status requires auth', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/slack/status?state=whatever' });
  assert.equal(res.statusCode, 401);
});

test('GET /auth/slack/status for an unknown state → {status:"unknown"}', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'GET', url: '/auth/slack/status?state=nope-not-real', user: { id: user.id } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'unknown');
});

test('GET /auth/slack/status forbids reading another user\'s pending state', async () => {
  const { user: owner } = await registerAndLogin();
  const { user: intruder } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: owner.id } });
  const { state } = start.json();

  const res = await callAuth({ method: 'GET', url: `/auth/slack/status?state=${state}`, user: { id: intruder.id } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FORBIDDEN');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/slack-oauth-routes.test.mjs tests/slack-oauth-routes-unconfigured.test.mjs`
Expected: FAIL — no route matches `/auth/slack/*` yet (404/undefined behavior from `handleAuth`).

- [ ] **Step 3: Write the implementation**

In `extension/server/auth-routes.mjs`, update the import block (top of file) to add the Slack imports aliased to avoid colliding with the existing Google ones:

```javascript
import {
  pkcePair, buildAuthUrl, exchangeCode, fetchEmailAddress,
  putState, getState, completeState, takeStatus,
} from '../agents/google-oauth.mjs';
import {
  buildAuthUrl as buildSlackAuthUrl, exchangeCode as exchangeSlackCode,
  putState as putSlackState, getState as getSlackState,
  completeState as completeSlackState, takeStatus as takeSlackStatus,
} from '../agents/slack-oauth.mjs';
import { listUserConversations } from '../agents/slack-source.mjs';
import { redactWithKey } from '../core/redact-secrets.mjs';
```

Immediately after the existing Google callback block (the block ending `if (q.get('error')) { ... } if (!st) { ... } ... } return; }` for `/auth/google/callback`, right before the `// ---- Authenticated -------------------------------------------------` comment), insert the public Slack callback route:

```javascript
  // ---- Slack Connect callback (public) --------------------------------
  //
  // GET /auth/slack/callback?code=...&state=...
  //   Slack redirects the user's browser here after consent — no bearer
  //   token on this request, so it stays public (allow-listed in
  //   server/auth.mjs PUBLIC_PATHS). Unlike Google, LLM-IDE owns the Slack
  //   App itself: client id/secret come from config (env vars), never from
  //   the vault or the query string.
  if (method === 'GET' && url.split('?')[0] === '/auth/slack/callback') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const html = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem"><p>${escHtml(msg)}</p><p>You can close this tab and return to LLM-IDE.</p><script>setTimeout(()=>window.close(),1500)</script>`); };
    const state = q.get('state') || '';
    const st = getSlackState(state);
    if (q.get('error')) { if (st) completeSlackState(state, { status: 'error', message: 'Sign-in cancelled.' }); html('Sign-in cancelled.'); return; }
    if (!st) { html('This sign-in link has expired — start again from the app.'); return; }
    if (st.status !== 'pending') { html('This sign-in link has already been used — start again from the app.'); return; }
    try {
      const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/slack/callback';
      const tok = await exchangeSlackCode({
        clientId: config.slackClientId, clientSecret: config.slackClientSecret,
        code: q.get('code') || '', redirectUri,
      });
      setSecret(db, st.userId, 'slack.userToken', tok.accessToken);
      // Prefetch the channel list so the Mac sheet renders the checklist
      // immediately. Fail-soft: listUserConversations never throws (it
      // degrades to []), so a transient Slack hiccup here never fails the
      // connect itself — the sheet's "Refresh channels" retries later.
      const { channels } = await listUserConversations({ token: tok.accessToken });
      completeSlackState(state, { status: 'complete', teamName: tok.teamName, channels });
      html('Connected to Slack.');
    } catch (e) {
      completeSlackState(state, { status: 'error', message: redactWithKey(e.message, config.slackClientSecret) });
      html('Connection failed: ' + redactWithKey(e.message, config.slackClientSecret));
    }
    return;
  }

```

Immediately after the existing `GET /auth/google/status` block (right after its closing `return; }`, before `if (method === 'GET' && url === '/auth/me')`), insert the authed Slack start/status routes:

```javascript
  // ---- Slack Connect: start + status (authed) --------------------------
  //
  // POST /auth/slack/start
  //   LLM-IDE owns a single hosted Slack App — nothing to paste. Returns
  //   503 if the operator hasn't configured LLMIDE_SLACK_CLIENT_ID/SECRET.
  if (method === 'POST' && url === '/auth/slack/start') {
    if (!config.slackClientId || !config.slackClientSecret) {
      send(res, 503, { error: { code: 'CONFIG_MISSING', message: "Slack connect isn't set up on this server yet." } });
      return;
    }
    const state = crypto.randomBytes(24).toString('base64url');
    putSlackState(state, { userId: req.user.id });
    const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/slack/callback';
    send(res, 200, { authUrl: buildSlackAuthUrl({ clientId: config.slackClientId, redirectUri, state }), state });
    return;
  }

  // GET /auth/slack/status?state=...
  //   Polled by the client while the browser tab is open. Ownership check:
  //   only the user who initiated the flow may read its status.
  if (method === 'GET' && url.split('?')[0] === '/auth/slack/status') {
    const state = new URL(url, 'http://127.0.0.1').searchParams.get('state') || '';
    const s = getSlackState(state);
    if (s && s.userId !== req.user.id) { send(res, 403, { error: { code: 'FORBIDDEN', message: 'not your sign-in' } }); return; }
    send(res, 200, takeSlackStatus(state));
    return;
  }

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/slack-oauth-routes.test.mjs tests/slack-oauth-routes-unconfigured.test.mjs`
Expected: PASS (12 tests across both files). If `listUserConversations` isn't defined yet (Task 4 not done), this fails with an import error — complete Task 4 first, then return here.

- [ ] **Step 5: Commit**

```bash
git add extension/server/auth-routes.mjs extension/tests/slack-oauth-routes.test.mjs extension/tests/slack-oauth-routes-unconfigured.test.mjs
git commit -m "feat(server): /auth/slack/{start,callback,status} hosted OAuth routes"
```

---

### Task 4: Channel discovery + token-resolution fallback

**Files:**
- Modify: `extension/agents/slack-source.mjs`
- Modify: `extension/tests/slack-source.test.mjs`
- Modify: `extension/kb/router.mjs`
- Test: `extension/tests/kb-router-slack.test.mjs` (create)
- Modify: `extension/server.mjs`

**Interfaces:**
- Produces: `listUserConversations({token}) -> {channels: [{id, name}], complete: boolean}` (exported from `slack-source.mjs`; post-review the return shape gained `complete` so a partial/failed fetch is distinguishable from "zero channels" — see the note in Task 3); `GET /kb/slack/conversations` (authed); `resolveSlackToken(userId)` (module-scope in `kb/router.mjs`, prefers `slack.userToken` over `slack.botToken`).
- Consumes: existing `slackCall` helper (already in `slack-source.mjs`), `getSecret` (existing import in `kb/router.mjs`).

- [ ] **Step 1: Write the failing tests**

In `extension/tests/slack-source.test.mjs`, update the import line at the top to add `listUserConversations`:

```javascript
import { stripMrkdwn, normalizeMessage, fetchChannelHistory, resolveOldestTs, listUserConversations } from '../agents/slack-source.mjs';
```

Then append these two tests at the end of the file:

```javascript
test('listUserConversations paginates and returns {id, name} pairs', async () => {
  const orig = global.fetch;
  global.fetch = async (urlStr) => {
    const url = String(urlStr);
    const json = (o) => ({ ok: true, json: async () => o });
    if (url.includes('users.conversations')) {
      if (url.includes('cursor=page2')) {
        return json({ ok: true, channels: [{ id: 'C3', name: 'random' }], response_metadata: { next_cursor: '' } });
      }
      return json({ ok: true, channels: [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'eng' }], response_metadata: { next_cursor: 'page2' } });
    }
    return json({ ok: false, error: 'unexpected' });
  };
  try {
    const out = await listUserConversations({ token: 't' });
    assert.deepEqual(out, [
      { id: 'C1', name: 'general' },
      { id: 'C2', name: 'eng' },
      { id: 'C3', name: 'random' },
    ]);
  } finally { global.fetch = orig; }
});

test('listUserConversations degrades to an empty list on failure (never throws)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const out = await listUserConversations({ token: 't' });
    assert.deepEqual(out, []);
  } finally { global.fetch = orig; }
});
```

Create `extension/tests/kb-router-slack.test.mjs`:

```javascript
// HTTP-layer tests for GET /kb/slack/conversations and the slack.userToken
// vs slack.botToken resolution used by the existing /kb/slack/test|fetch
// handlers. Mirrors tests/kb-router-scip.test.mjs's setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-slack-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
}
function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
  };
}

test('GET /kb/slack/conversations 400 SLACK_NO_TOKEN when neither token is saved', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `sc-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  const res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/slack/conversations', userId: u.id }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'SLACK_NO_TOKEN');
});

test('GET /kb/slack/conversations prefers slack.userToken over slack.botToken', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `sc2-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(db.getDb(), u.id, 'slack.botToken', 'xoxb-old');
  setSecret(db.getDb(), u.id, 'slack.userToken', 'xoxp-new');

  const orig = global.fetch;
  const seenTokens = [];
  global.fetch = async (urlStr, init) => {
    seenTokens.push(init?.headers?.Authorization || '');
    return { ok: true, json: async () => ({ ok: true, channels: [], response_metadata: { next_cursor: '' } }) };
  };
  try {
    const res = makeRes();
    await handleKB(makeReq({ method: 'GET', url: '/kb/slack/conversations', userId: u.id }), res);
    assert.equal(res.statusCode, 200, res._body);
    assert.ok(seenTokens.some((h) => h.includes('xoxp-new')), 'must use slack.userToken, not slack.botToken, when both are present');
  } finally { global.fetch = orig; }
});

test('GET /kb/slack/conversations falls back to slack.botToken when no user token is saved', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `sc3-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(db.getDb(), u.id, 'slack.botToken', 'xoxb-only');

  const orig = global.fetch;
  const seenTokens = [];
  global.fetch = async (urlStr, init) => {
    seenTokens.push(init?.headers?.Authorization || '');
    return { ok: true, json: async () => ({ ok: true, channels: [{ id: 'C9', name: 'legacy' }], response_metadata: { next_cursor: '' } }) };
  };
  try {
    const res = makeRes();
    await handleKB(makeReq({ method: 'GET', url: '/kb/slack/conversations', userId: u.id }), res);
    assert.equal(res.statusCode, 200, res._body);
    assert.deepEqual(JSON.parse(res._body).channels, [{ id: 'C9', name: 'legacy' }]);
    assert.ok(seenTokens.some((h) => h.includes('xoxb-only')));
  } finally { global.fetch = orig; }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/slack-source.test.mjs tests/kb-router-slack.test.mjs`
Expected: FAIL — `listUserConversations` is not exported yet; `/kb/slack/conversations` doesn't exist yet (404-equivalent / falls through `handleKB`, `res.statusCode` stays default and assertions fail).

- [ ] **Step 3: Write the implementation**

In `extension/agents/slack-source.mjs`, add a pagination cap constant next to the existing ones (near `MAX_USER_LIST_PAGES`):

```javascript
const MAX_CONVERSATIONS_PAGES = 20;  // bound users.conversations pagination on big workspaces
```

Update `friendlyError`'s first case (token may now be a user token, not always a bot token):

```javascript
function friendlyError(code) {
  switch (code) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':     return 'Slack auth failed — check your Slack connection';
    case 'not_in_channel':
    case 'channel_not_found': return 'The bot is not in that channel (invite it, or check the channel id)';
    case 'ratelimited':       return 'Slack rate limit hit — try again shortly';
    default:                  return `Slack API error: ${code || 'unknown'}`;
  }
}
```

Add `listUserConversations` at the end of the file (after `fetchChannelHistory`):

```javascript
// List the channels/groups this token's user already belongs to — powers
// the "Connect Slack" channel checklist so the user never has to look up or
// type a channel ID. Bounded pagination; a failure partway through returns
// whatever was gathered rather than throwing, so a transient Slack hiccup
// never fails the whole OAuth connect (the callback that calls this is
// fail-soft by design — see auth-routes.mjs).
export async function listUserConversations({ token }) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), FETCH_DEADLINE_MS);
  try {
    const out = [];
    let cursor = '';
    for (let page = 0; page < MAX_CONVERSATIONS_PAGES; page++) {
      const params = { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200' };
      if (cursor) params.cursor = cursor;
      let r;
      try { r = await slackCall('users.conversations', token, params, ctrl.signal); }
      catch { break; } // degrade to whatever was gathered so far
      for (const c of r.channels || []) {
        if (c?.id && c?.name) out.push({ id: c.id, name: c.name });
      }
      cursor = r.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
    return out;
  } finally { clearTimeout(killer); }
}
```

In `extension/kb/router.mjs`, update the import line (currently `import { testConnection as slackTest, fetchChannelHistory } from '../agents/slack-source.mjs';`) to:

```javascript
import { testConnection as slackTest, fetchChannelHistory, listUserConversations } from '../agents/slack-source.mjs';
```

Add `resolveSlackToken` right before the `// Slack input (twin of /kb/email/*) ---` comment block:

```javascript
// Prefer the OAuth-issued user token; fall back to a manually-pasted bot
// token so Slack connections set up before the OAuth flow shipped keep
// working unmodified.
function resolveSlackToken(userId) {
  return getSecret(kb.getDb(), userId, 'slack.userToken') || getSecret(kb.getDb(), userId, 'slack.botToken');
}

```

In that same block, replace the token lookup line:

```javascript
      const token = getSecret(kb.getDb(), userId, 'slack.botToken');
      if (!token) {
        sendJSON(res, 400, { error: { code: 'SLACK_NO_TOKEN', message: 'No Slack bot token saved. Save one first.' } });
        return true;
      }
```

with:

```javascript
      const token = resolveSlackToken(userId);
      if (!token) {
        sendJSON(res, 400, { error: { code: 'SLACK_NO_TOKEN', message: 'No Slack connection saved. Connect Slack first.' } });
        return true;
      }
```

Add the new route right after that block's closing (after the `/kb/slack/test`/`/kb/slack/fetch` `if` block's final `return true; }`, before `if (req.method === 'POST' && url === '/kb/slack/seen')`):

```javascript
    if (req.method === 'GET' && url === '/kb/slack/conversations') {
      const token = resolveSlackToken(userId);
      if (!token) {
        sendJSON(res, 400, { error: { code: 'SLACK_NO_TOKEN', message: 'No Slack connection saved. Connect Slack first.' } });
        return true;
      }
      const channels = await listUserConversations({ token });
      sendJSON(res, 200, { channels });
      return true;
    }

```

In `extension/server.mjs`, add the new endpoint to `ENDPOINTS` right after `'/kb/slack/seen',`:

```javascript
  '/kb/slack/seen',
  '/kb/slack/conversations',
```

and bump the version:

```javascript
const SERVER_API_VERSION = 22;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/slack-source.test.mjs tests/kb-router-slack.test.mjs`
Expected: PASS (all tests in both files).

Then re-run Task 3's tests, which depend on `listUserConversations` existing:

Run: `cd extension && node --test tests/slack-oauth-routes.test.mjs tests/slack-oauth-routes-unconfigured.test.mjs`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/agents/slack-source.mjs extension/tests/slack-source.test.mjs extension/kb/router.mjs extension/tests/kb-router-slack.test.mjs extension/server.mjs
git commit -m "feat(server): Slack channel auto-discovery + userToken/botToken fallback"
```

---

### Task 5: Mac — `SourceLinkStore` + `LlmIdeAPIClient+Slack` wrappers

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift`
- Modify: `mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift`

**Interfaces:**
- Produces: `SourceLinkStore.secretKeys(.slack)` includes `"slack.userToken"`; `LlmIdeAPIClient.slackConnectStart()`, `.slackConnectStatus(state:)`, `.fetchSlackConversations()`, `SlackConversation`.
- Consumed by: Task 6 (`SlackSourceSheet.swift`).

- [ ] **Step 1: Write the failing test**

In `mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift`, add this test right after `testBoxAndSlackSecretKeys`:

```swift
    func testSlackLinkedViaUserToken() {
        XCTAssertEqual(SourceLinkStore.linkState(.slack, configured: true, presentKeys: ["slack.userToken"]), .linked)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter LlmIdeMacTests.SourceLinkStoreTests`
Expected: FAIL — `slack.userToken` is not yet one of `secretKeys(.slack)`, so `linkState` returns `.credentialsNeeded`, not `.linked`.

- [ ] **Step 3: Write the implementation**

In `mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift`, change:

```swift
        case .slack: return ["slack.botToken"]
```

to:

```swift
        case .slack: return ["slack.userToken", "slack.botToken"]
```

In `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift`, add this new extension at the end of the file (after the existing `postClassification` extension):

```swift
extension LlmIdeAPIClient {

    /// One channel/group the connected Slack user already belongs to.
    struct SlackConversation: Decodable, Identifiable {
        let id: String
        let name: String
    }

    /// Result of `/auth/slack/start` — the browser URL to open plus the
    /// opaque state token used to poll for completion.
    struct SlackConnectStartResult: Decodable { let authUrl: String; let state: String }

    /// Result of `/auth/slack/status` — `status` is one of
    /// pending|complete|error; `teamName` populates once complete. No
    /// `channels` here (post-review, Task 3 dropped the channel prefetch
    /// from the OAuth callback — it was blocking the public redirect page
    /// for up to 90s under Slack rate-limiting); callers fetch the channel
    /// list separately via `fetchSlackConversations()` right after seeing
    /// `status == "complete"`.
    struct SlackConnectStatusResult: Decodable {
        let status: String
        let teamName: String?
        let message: String?
    }

    /// Kick off the hosted Slack OAuth flow (LLM-IDE's own Slack App — no
    /// client id/secret from the user). Returns a browser URL to open plus a
    /// state token to poll via `slackConnectStatus`.
    func slackConnectStart() async throws -> SlackConnectStartResult {
        struct Req: Encodable {}
        return try await post("/auth/slack/start", body: Req(), authenticated: true)
    }

    /// Poll the state of an in-flight Slack connect started via `slackConnectStart`.
    func slackConnectStatus(state: String) async throws -> SlackConnectStatusResult {
        let encoded = state.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? state
        return try await get("/auth/slack/status?state=\(encoded)", authenticated: true)
    }

    /// Channels/groups the connected Slack user belongs to, for the
    /// "Connect Slack" checklist. Requires slack.userToken or slack.botToken
    /// to already be saved.
    func fetchSlackConversations() async throws -> [SlackConversation] {
        struct Resp: Decodable { let channels: [SlackConversation] }
        let r: Resp = try await get("/kb/slack/conversations", authenticated: true)
        return r.channels
    }
}
```

In `mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift`, change the Slack sheet presentation:

```swift
                .sheet(isPresented: $showSlackSheet) {
                    SlackSourceSheet(api: api)
                        .environmentObject(theme)
                        .environmentObject(config)
                }
```

to:

```swift
                .sheet(isPresented: $showSlackSheet) {
                    SlackSourceSheet(api: api)
                        .environmentObject(theme)
                        .environmentObject(config)
                        .environmentObject(sourceLinks)
                }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter LlmIdeMacTests.SourceLinkStoreTests`
Expected: PASS (all `SourceLinkStoreTests`, including the new one).

Then build to catch any compile error from the API client / Connections section changes:

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -10`
Expected: `Build of product 'LlmIdeMac' complete!` — `SlackSourceSheet.swift` doesn't reference `sourceLinks` yet, so this should already compile cleanly before Task 6.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/SourceLinkStore.swift mac/Tests/LlmIdeMacTests/SourceLinkStoreTests.swift mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Slack.swift mac/Sources/LlmIdeMac/Views/Settings/ConnectionsSettingsSection.swift
git commit -m "feat(mac): Slack connect API client wrappers + userToken link state"
```

---

### Task 6: Mac — `SlackSourceSheet` rework (Connect button + channel checklist)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift` (full-file rewrite — more than half the file changes)

**Interfaces:**
- Consumes: `SourceLinkStore` (Task 5, injected via `.environmentObject`), `LlmIdeAPIClient.slackConnectStart/slackConnectStatus/fetchSlackConversations/SlackConversation` (Task 5).
- Produces: the reworked sheet UI. No new types consumed elsewhere.

- [ ] **Step 1: Replace the file**

Overwrite `mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift` with:

```swift
import SwiftUI
import AppKit

/// Configure / edit the Slack source. Connecting goes through LLM-IDE's
/// hosted Slack OAuth app (agents/slack-oauth.mjs, /auth/slack/*) — the user
/// clicks "Connect Slack", approves in the browser, and gets back a user
/// token (vault key slack.userToken) plus a checklist of channels/groups
/// they already belong to. No bot to invite, no token to paste. A manual
/// bot-token paste stays available behind "Advanced" for a workspace that
/// blocks new app installs; it writes to the older slack.botToken key,
/// which the server prefers slack.userToken over but falls back to.
struct SlackSourceSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var sourceLinks: SourceLinkStore
    @Environment(\.dismiss) private var dismiss

    /// Draft seeded from the existing source (or defaults for first setup).
    @State private var draft: SavedSlackSource
    /// True when we're editing an already-saved source.
    private let isEditing: Bool

    @State private var selectedChannelIds: Set<String>
    @State private var availableChannels: [LlmIdeAPIClient.SlackConversation] = []
    @State private var channelsIncomplete = false
    @State private var loadingChannels = false
    @State private var connecting = false
    @State private var connectError: String?

    @State private var showAdvanced = false
    @State private var token: String = ""
    @State private var tokenVisible = false
    @State private var testing = false
    @State private var testStatus: String?
    @State private var testWasError = false

    init(api: LlmIdeAPIClient) {
        self.api = api
        let existing = AppConfig.shared.slackSource
        _draft = State(initialValue: existing ?? SavedSlackSource())
        isEditing = existing != nil
        _selectedChannelIds = State(initialValue: Set(existing?.channels ?? []))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(isEditing ? "Edit Slack Source" : "Add Slack Source")
                .font(Typography.title)
                .padding(Spacing.lg)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    field("Display name") {
                        TextField("My workspace (optional)", text: $draft.displayName)
                            .textFieldStyle(.roundedBorder)
                    }

                    if sourceLinks.hasSecret(.slack) {
                        SettingsHint("✓ Connected to Slack.")
                        channelChecklist
                    } else {
                        Button(connecting ? "Connecting…" : "Connect Slack") {
                            Task { await connectSlack() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(connecting)
                        if let err = connectError {
                            Text(err)
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        SettingsHint("Opens Slack in your browser to approve access. Reads channels you already belong to — no bot to invite.")
                    }

                    DisclosureGroup("Advanced: paste a token manually", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: Spacing.md) {
                            field("Bot token") {
                                ZStack(alignment: .trailing) {
                                    Group {
                                        if tokenVisible {
                                            TextField("", text: $token)
                                        } else {
                                            SecureField("", text: $token)
                                        }
                                    }
                                    .textFieldStyle(.roundedBorder)
                                    .font(Typography.mono)
                                    .disableAutocorrection(true)
                                    Button { tokenVisible.toggle() } label: {
                                        Image(systemName: tokenVisible ? "eye.slash" : "eye")
                                            .font(.system(size: 11))
                                            .foregroundStyle(theme.current.textMuted)
                                    }
                                    .buttonStyle(.plain)
                                    .padding(.trailing, 8)
                                    .help(tokenVisible ? "Hide token" : "Show token")
                                    .accessibilityLabel(tokenVisible ? "Hide token" : "Show token")
                                }
                            }
                            SettingsHint("Leave blank to keep the current one. The bot must be invited to each channel you select above.")
                            if let s = testStatus {
                                Text(s)
                                    .font(Typography.caption)
                                    .foregroundStyle(testWasError ? theme.current.danger : theme.current.accent3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Button(testing ? "Testing…" : "Test token") {
                                Task { await test() }
                            }
                            .buttonStyle(.bordered)
                            .disabled(token.isEmpty || testing)
                        }
                        .padding(.top, Spacing.sm)
                    }

                    field("Lookback days") {
                        Stepper(value: $draft.lookbackDays, in: 1...60) {
                            Text("\(draft.lookbackDays) day\(draft.lookbackDays == 1 ? "" : "s")")
                                .font(Typography.body)
                        }
                        .frame(width: 200)
                    }
                    field("Enabled") {
                        Toggle("", isOn: $draft.enabled)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                }
                .padding(Spacing.lg)
            }

            Divider()

            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if isEditing {
                    Button("Disconnect", role: .destructive) {
                        Task { await disconnect() }
                    }
                    .help("Remove this source and delete the stored Slack credentials.")
                }
                Spacer()
                Button("Save") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!sourceLinks.hasSecret(.slack) && token.isEmpty)
            }
            .padding(Spacing.lg)
        }
        .frame(minWidth: 460, idealWidth: 500, minHeight: 520)
        .background(theme.current.body)
        .task {
            if sourceLinks.hasSecret(.slack) { await loadChannels() }
        }
    }

    // MARK: - Channel checklist

    @ViewBuilder
    private var channelChecklist: some View {
        HStack {
            Text("Channels")
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
            Spacer()
            Button(loadingChannels ? "Refreshing…" : "Refresh channels") {
                Task { await loadChannels() }
            }
            .buttonStyle(.plain)
            .font(Typography.caption)
            .disabled(loadingChannels)
        }
        if availableChannels.isEmpty && !loadingChannels {
            SettingsHint("Couldn't load channels — tap Refresh channels to try again.")
        } else if channelsIncomplete {
            SettingsHint("Showing \(availableChannels.count) channels — the list may be incomplete (large workspace or Slack rate limit). Tap Refresh channels to try again.")
        }
        VStack(alignment: .leading, spacing: 4) {
            ForEach(availableChannels) { ch in
                Toggle("#\(ch.name)", isOn: Binding(
                    get: { selectedChannelIds.contains(ch.id) },
                    set: { on in
                        if on { selectedChannelIds.insert(ch.id) } else { selectedChannelIds.remove(ch.id) }
                    }
                ))
                .toggleStyle(.checkbox)
            }
        }
        .frame(maxHeight: 220)
    }

    // MARK: - Field row

    @ViewBuilder
    private func field<Content: View>(_ label: String,
                                      @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: Spacing.md) {
            Text(label)
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
                .frame(width: 120, alignment: .leading)
            content()
            Spacer(minLength: 0)
        }
    }

    // MARK: - Actions

    /// Drive the Slack OAuth loopback flow: ask the server (which owns its
    /// own Slack App credentials — nothing to paste) to start the flow,
    /// open the returned consent URL in the default browser, then poll
    /// `/auth/slack/status` until it reports complete/error or ~3 minutes
    /// elapse.
    private func connectSlack() async {
        connecting = true
        connectError = nil
        defer { connecting = false }
        do {
            let r = try await api.slackConnectStart()
            if let u = URL(string: r.authUrl) { NSWorkspace.shared.open(u) }
            for _ in 0..<90 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await api.slackConnectStatus(state: r.state)
                if s.status == "complete" {
                    await sourceLinks.refresh(api: api)
                    await loadChannels()
                    selectedChannelIds = Set(availableChannels.map(\.id))
                    return
                }
                if s.status != "pending" {
                    connectError = s.message ?? "Connection failed"
                    return
                }
            }
            connectError = "Connecting timed out — try again."
        } catch {
            connectError = error.localizedDescription
        }
    }

    /// Refresh the channel checklist from the currently-saved Slack
    /// connection (user token, or a manually-pasted bot token).
    private func loadChannels() async {
        loadingChannels = true
        defer { loadingChannels = false }
        do {
            let result = try await api.fetchSlackConversations()
            availableChannels = result.channels
            channelsIncomplete = !result.complete
        } catch {
            availableChannels = []
            channelsIncomplete = false
        }
    }

    /// Write the token to the vault FIRST (so the server can read it), then
    /// run the connectivity probe. Advanced/manual fallback path only.
    private func test() async {
        testing = true
        testStatus = nil
        defer { testing = false }
        do {
            try await api.setSecret(key: "slack.botToken", value: token)
            let r = try await api.testSlack()
            testWasError = !r.ok
            testStatus = r.ok
                ? "Connected to \(r.team)"
                : "Test failed."
            if r.ok { await sourceLinks.refresh(api: api) }
        } catch {
            testWasError = true
            testStatus = error.localizedDescription
        }
    }

    /// Persist the source. The manual token (if the user typed one in
    /// Advanced) is saved as slack.botToken; the OAuth-issued slack.userToken
    /// (if present) already lives in the vault from `connectSlack()`.
    private func save() async {
        if !token.isEmpty {
            do {
                try await api.setSecret(key: "slack.botToken", value: token)
                await sourceLinks.refresh(api: api)
            } catch {
                testWasError = true
                testStatus = "Couldn't save token: \(error.localizedDescription)"
                return
            }
        }
        draft.channels = Array(selectedChannelIds)
        config.slackSource = draft
        dismiss()
    }

    /// Remove the source and delete BOTH possible stored credentials
    /// (OAuth user token + manual bot token — deleting an absent key is a
    /// harmless no-op) so a reconnect starts clean.
    private func disconnect() async {
        do {
            try await api.setSecret(key: "slack.userToken", value: "")
            try await api.setSecret(key: "slack.botToken", value: "")
        } catch {
            testWasError = true
            testStatus = "Couldn't remove the stored Slack credentials: \(error.localizedDescription)"
            return
        }
        await sourceLinks.refresh(api: api)
        config.slackSource = nil
        dismiss()
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -10`
Expected: `Build of product 'LlmIdeMac' complete!` with no errors.

- [ ] **Step 3: Run the Mac unit tests (no regression)**

Run: `cd mac && swift test --filter LlmIdeMacTests 2>&1 | tail -10`
Expected: all tests PASS. (Note: per existing project knowledge, `swift test` may no-op with "no such module 'XCTest'" in some local CLI toolchains — if so, rely on the build succeeding plus manual verification in Task 7, same caveat as the rest of the Mac test suite.)

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Sources/SlackSourceSheet.swift
git commit -m "feat(mac): Slack source sheet — one-click connect + channel checklist"
```

---

### Task 7: Full regression + real-Slack-App manual verification

**Files:** none (verification only).

- [ ] **Step 1: Full server test suite**

Run: `cd extension && npm test 2>&1 | tail -20`
Expected: all tests PASS, including every new file from Tasks 1–4.

- [ ] **Step 2: Lint**

Run: `cd extension && npx eslint agents/slack-oauth.mjs agents/slack-source.mjs server/auth-routes.mjs server/vault.mjs server/auth.mjs core/config.mjs kb/router.mjs server.mjs tests/slack-oauth.test.mjs tests/slack-oauth-routes.test.mjs tests/slack-oauth-routes-unconfigured.test.mjs tests/slack-source.test.mjs tests/kb-router-slack.test.mjs tests/vault.test.mjs --max-warnings 0`
Expected: no errors/warnings on these files (pre-existing warnings elsewhere in the repo are out of scope).

- [ ] **Step 3: Full Mac build + test**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -10`
Expected: `Build of product 'LlmIdeMac' complete!`

Run: `cd mac && swift test 2>&1 | tail -10`
Expected: all tests PASS, no regressions in the existing suite.

- [ ] **Step 4: Register a real Slack App (one-time, by the operator)**

1. Go to `https://api.slack.com/apps` → **Create New App** → **From scratch**.
2. Under **OAuth & Permissions**, add a **Redirect URL**: `http://127.0.0.1:3456/auth/slack/callback` (match `LLMIDE_PORT` if it's not the default 3456).
3. Under the same page's **User Token Scopes** (not Bot Token Scopes), add: `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`.
4. Under **Basic Information**, copy the **Client ID** and **Client Secret**.
5. Set them in the server's environment before starting it:

```bash
export LLMIDE_SLACK_CLIENT_ID="<client id>"
export LLMIDE_SLACK_CLIENT_SECRET="<client secret>"
cd extension && node server.mjs
```

- [ ] **Step 5: Manual success criterion (the feature's proof)**

With the server running (Step 3) and the Mac app launched:

1. Open **Settings → Connections → Slack → Configure…**. No token field is shown by default — only a **"Connect Slack"** button.
2. Click **Connect Slack** → the default browser opens Slack's real consent screen for the app created in Step 3 → approve.
3. Back in the Mac app, the sheet should show **"✓ Connected to Slack"** and a checklist of the real channels/groups the signed-in user belongs to, pre-checked.
4. Uncheck a channel, **Save**. Re-open the sheet — the checklist reflects the saved selection.
5. Trigger a fetch (Connections card "Fetch" or wait for Auto-Tasks) for a checked channel and confirm messages arrive without ever inviting a bot anywhere in the workspace.
6. **Disconnect** in the sheet → badge reverts to **Not configured**; re-open **Connect Slack** and confirm the flow works again cleanly.
7. **Backward-compat check:** on a separate test user (or after manually clearing `slack.userToken` via SQL/`/auth/me/secrets`), use the collapsed **"Advanced: paste a token manually"** section with a real bot token + manually invited channel, confirm **Test token** and **Save** still work exactly as before this change.

If any step instead shows a "—" unknown badge or a clear error message, that's the designed fail-soft behavior (server unreachable, session not authenticated, or Slack App not yet approved) — not a bug, per the spec's error-handling section.

- [ ] **Step 6: (Optional) commit any regression-driven fixups**

```bash
git commit -am "fix(mac/server): <specific tweak found during Slack connect regression>"
```

## Notes / Out of scope

- Box and Email/Google hosted-OAuth upgrades are separate, later plans (per the spec).
- Migrating Slack onto the `SourceConnectorManifest` engine (`2026-07-31-slack-connector-engine-design.md`) is orthogonal and untouched by this plan.
- DM/multi-person-DM history and "select all channels without a checklist" are explicitly out of scope per the spec.
