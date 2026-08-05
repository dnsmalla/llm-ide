# Gmail One-Click OAuth Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Email's "create your own Google Cloud OAuth client, paste Client ID + Secret" setup with a single "Connect Google" button — a hosted OAuth app (Testing mode), backward-compatible with every existing bring-your-own (BYO) user.

**Architecture:** Reuses the existing PKCE OAuth module (`agents/google-oauth.mjs`) and the existing `/auth/google/{start,callback,status}` routes almost unchanged — `POST /auth/google/start`'s body becomes optional (present = BYO, exactly as today; absent = hosted, using server env vars) and the resolved `clientId`/`clientSecret` are carried in the OAuth state entry so the callback never needs to re-derive them. `agents/email-source.mjs`'s token-refresh call prefers a user's own stored client (BYO) and falls back to the server's hosted client — this is not a style choice, Google requires the *same* client that minted a refresh token to be used when refreshing it.

**Tech Stack:** Node 20+ (server, `node --test`), Swift 6 / SwiftUI (Mac, `swift build`/`swift test`), no new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-05-gmail-oauth-connect-design.md`](../specs/2026-08-05-gmail-oauth-connect-design.md)

## Global Constraints

- **Hosted client credentials via env var, never hardcoded.** `LLMIDE_GOOGLE_CLIENT_ID` / `LLMIDE_GOOGLE_CLIENT_SECRET` in `extension/core/config.mjs`, mirroring `slackClientId`/`slackClientSecret` exactly.
- **Backward compatibility is mandatory and load-bearing, not just nice-to-have.** An existing BYO user's refresh token is cryptographically bound to their own Google Cloud OAuth client — using the wrong client to refresh it fails outright (Google returns `invalid_grant`). Every place that resolves which client to use must prefer the per-user vault value when present.
- **No new vault key.** The hosted flow writes to the same `google.email.refreshToken` key BYO already uses. `SourceLinkStore` needs no change (out of scope for this plan; it already recognizes this key).
- **`/auth/google/callback` is already public** (`server/auth.mjs` `PUBLIC_PATHS`) and already registered in `isAuthRoute()` (`server/auth-routes.mjs`) — no routing-gate changes needed, unlike the Slack plan which had to add brand-new paths.
- **Follow the existing BYO pattern exactly** where it isn't changing: state TTL/single-use semantics, PKCE, `redactWithKey`-before-surfacing, the `oauthCallbackHtml` shared helper (already extracted during the Slack work — reuse it, don't duplicate).
- **Conventional Commits, one concern per commit.**

## File Structure

- **Modify** `extension/core/config.mjs` — add `googleClientId`/`googleClientSecret`.
- **Modify** `extension/server/auth-routes.mjs` — `POST /auth/google/start`'s body becomes optional (BYO vs hosted resolution); `GET /auth/google/callback` reads `clientId`/`clientSecret` from the state entry instead of the vault.
- **Modify** `extension/tests/google-oauth-routes.test.mjs` — add hosted-path tests; existing BYO tests must keep passing unchanged (regression gate).
- **Create** `extension/tests/google-oauth-routes-unconfigured.test.mjs` — the 503 path when hosted isn't configured (needs its own process — `config.mjs` freezes at first import, same reasoning as the Slack plan's split file).
- **Modify** `extension/agents/email-source.mjs` — `getGoogleAccessToken()`'s client resolution gains the vault-then-config fallback.
- **Create** `extension/tests/email-google-token.test.mjs`.
- **Modify** `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Email.swift` — add `googleConnectStart()`.
- **Modify** `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift` — primary "Connect Google" button; existing IMAP host/port/SSL/email/auth-method fields (App Password + BYO Client ID/Secret) relocate, unchanged internally, under a collapsed "Advanced" disclosure. Mailbox/Lookback/Unread/Mark-read/From-filter/Enabled stay always-visible (they apply regardless of connection method).

---

### Task 1: Hosted-vs-BYO resolution in `/auth/google/{start,callback}`

**Files:**
- Modify: `extension/core/config.mjs`
- Modify: `extension/server/auth-routes.mjs`
- Modify: `extension/tests/google-oauth-routes.test.mjs`
- Create: `extension/tests/google-oauth-routes-unconfigured.test.mjs`

**Interfaces:**
- Produces: `config.googleClientId`/`config.googleClientSecret` (`undefined` when env vars unset); `POST /auth/google/start` accepts an optional body; the OAuth state entry gains `clientId`/`clientSecret` fields (the existing generic state store in `agents/google-oauth.mjs` already accepts arbitrary patch fields via `{...data}` — no change needed to that module itself).
- Consumes: existing `pkcePair`, `buildAuthUrl`, `exchangeCode`, `fetchEmailAddress`, `putState`, `getState`, `completeState`, `takeStatus`, `oauthCallbackHtml`, `redactWithKey`, `setSecret`.

- [ ] **Step 1: Write the failing tests**

In `extension/tests/google-oauth-routes.test.mjs`, add this line right after the existing `process.env.LLMIDE_LOG_FILE = 'none';` line (near the top, before the DB path setup):

```javascript
process.env.LLMIDE_GOOGLE_CLIENT_ID = 'test-hosted-client-id';
process.env.LLMIDE_GOOGLE_CLIENT_SECRET = 'test-hosted-client-secret';
```

Then append these new tests at the end of the file (after the existing `GET /auth/google/status forbids reading another user's pending state` test):

```javascript
// ---- POST /auth/google/start (hosted path, no body) --------------------

test('POST /auth/google/start with an empty body uses the hosted server config, no per-user vault write', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/google/start', user: { id: user.id }, body: {} });
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  assert.ok(body.authUrl.includes('test-hosted-client-id'), 'authUrl carries the hosted client id');
  assert.ok(!body.authUrl.includes('test-hosted-client-secret'), 'client secret must never appear in the authUrl');
  // No per-user vault write for the hosted path.
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.clientId'), null);
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.clientSecret'), null);
});

test('POST /auth/google/start rejects a partial BYO body (only one of clientId/clientSecret)', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/google/start', user: { id: user.id }, body: { clientId: 'only-one' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');
});

test('full hosted flow: start (no body) -> callback (token exchange + userinfo stubbed) -> status complete, no per-user client vault write', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/google/start', user: { id: user.id }, body: {} });
  assert.equal(start.statusCode, 200, start._body);
  const { state } = start.json();

  const originalFetch = global.fetch;
  const email = 'hosted-user@example.com';
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, json: async () => ({ access_token: 'hosted-access-tok', refresh_token: 'hosted-refresh-tok', expires_in: 3600 }) };
    }
    if (u.includes('openidconnect.googleapis.com/v1/userinfo')) {
      return { ok: true, json: async () => ({ email }) };
    }
    throw new Error(`Unexpected fetch to ${u}`);
  };

  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/google/callback?code=hosted-auth-code&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.match(cb._body, /Signed in to Google/i);
  } finally {
    global.fetch = originalFetch;
  }

  // Refresh token persisted (same vault key BYO already uses).
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.refreshToken'), 'hosted-refresh-tok');
  // But no per-user clientId/clientSecret — those are hosted, never per-user.
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.clientId'), null);
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.clientSecret'), null);

  const status = await callAuth({ method: 'GET', url: `/auth/google/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.statusCode, 200, status._body);
  const statusBody = status.json();
  assert.equal(statusBody.status, 'complete');
  assert.equal(statusBody.email, email);
});
```

Create `extension/tests/google-oauth-routes-unconfigured.test.mjs` (no `LLMIDE_GOOGLE_CLIENT_ID`/`SECRET` set — proves the 503 path AND that BYO still works even when hosted isn't configured; kept in its own file/process because `core/config.mjs` freezes its config object at first import):

```javascript
// HTTP-level test for /auth/google/start when the server has no hosted Google
// OAuth client configured. Kept in its own file/process — config.mjs freezes
// its config object at first import, so this env-var state can't coexist
// with the "configured" tests in google-oauth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
delete process.env.LLMIDE_GOOGLE_CLIENT_ID;
delete process.env.LLMIDE_GOOGLE_CLIENT_SECRET;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_google-oauth-routes-unconfigured-test.db');
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
    socket: { remoteAddress: `10.40.0.${++ipCounter}` },
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
  const email = `google-unconfigured-${Date.now()}@example.com`;
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: 'CorrectHorseBattery', displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: 'CorrectHorseBattery' } });
  assert.equal(login.statusCode, 200, login._body);
  return { ...login.json() };
}

test('POST /auth/google/start with an empty body returns 503 CONFIG_MISSING when the server has no hosted Google OAuth client', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/google/start', user: { id: user.id }, body: {} });
  assert.equal(res.statusCode, 503, res._body);
  assert.equal(res.json().error.code, 'CONFIG_MISSING');
});

test('POST /auth/google/start still works with a BYO body even when hosted config is unset', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({
    method: 'POST', url: '/auth/google/start', user: { id: user.id },
    body: { clientId: 'byo-client-id', clientSecret: 'byo-client-secret' },
  });
  assert.equal(res.statusCode, 200, res._body);
  assert.ok(res.json().authUrl.includes('byo-client-id'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/google-oauth-routes.test.mjs tests/google-oauth-routes-unconfigured.test.mjs`
Expected: FAIL — the hosted-path tests fail because `/auth/google/start` still requires `clientId`/`clientSecret` in the body; the unconfigured tests fail because `config.googleClientId`/`googleClientSecret` don't exist yet.

- [ ] **Step 3: Write the implementation**

In `extension/core/config.mjs`, add this block right after the existing Slack section (after the `slackClientSecret: envStr('LLMIDE_SLACK_CLIENT_SECRET'),` line):

```javascript
  // Gmail hosted OAuth app (agents/google-oauth.mjs). LLM-IDE owns ONE
  // Google Cloud OAuth client (Testing-mode) — these are the app's own
  // client id/secret, never per-user, never in the vault. Optional:
  // /auth/google/start falls back to per-request BYO credentials (the
  // existing bring-your-own path) when unset, and returns a clear
  // "not configured" error only if BOTH the request has no BYO body
  // AND this is unset.
  googleClientId:     envStr('LLMIDE_GOOGLE_CLIENT_ID'),
  googleClientSecret: envStr('LLMIDE_GOOGLE_CLIENT_SECRET'),
```

In `extension/server/auth-routes.mjs`, replace the entire `POST /auth/google/start` block:

```javascript
  if (method === 'POST' && url === '/auth/google/start') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const clientId = (body.clientId || '').trim();
    const clientSecret = (body.clientSecret || '').trim();
    if (!clientId || !clientSecret) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'clientId and clientSecret are required' } }); return; }
    setSecret(db, req.user.id, 'google.email.clientId', clientId);
    setSecret(db, req.user.id, 'google.email.clientSecret', clientSecret);
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(24).toString('base64url');
    putState(state, { userId: req.user.id, verifier });
    const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/google/callback';
    send(res, 200, { authUrl: buildAuthUrl({ clientId, redirectUri, state, challenge }), state });
    return;
  }
```

with:

```javascript
  // POST /auth/google/start { clientId?, clientSecret? }
  //   Both fields present → bring-your-own: persists the user's own OAuth
  //   client credentials to the vault, exactly as before. Both absent →
  //   hosted: LLM-IDE's own Testing-mode Google Cloud OAuth client (env
  //   vars), nothing to paste, 503 if the operator hasn't configured it.
  //   Either way, the resolved clientId/clientSecret are carried in the
  //   state entry itself so the callback below never needs to re-derive
  //   them (uniform code path for both BYO and hosted).
  if (method === 'POST' && url === '/auth/google/start') {
    let body;
    try { body = await readJson(req, bodyLimit); }
    catch (err) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: err.message } }); return; }
    const bodyClientId = (body?.clientId || '').trim();
    const bodyClientSecret = (body?.clientSecret || '').trim();
    const isByo = !!(bodyClientId || bodyClientSecret);
    let clientId, clientSecret;
    if (isByo) {
      if (!bodyClientId || !bodyClientSecret) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'clientId and clientSecret are required' } }); return; }
      clientId = bodyClientId;
      clientSecret = bodyClientSecret;
      setSecret(db, req.user.id, 'google.email.clientId', clientId);
      setSecret(db, req.user.id, 'google.email.clientSecret', clientSecret);
    } else {
      if (!config.googleClientId || !config.googleClientSecret) {
        send(res, 503, { error: { code: 'CONFIG_MISSING', message: "Google connect isn't set up on this server yet." } });
        return;
      }
      clientId = config.googleClientId;
      clientSecret = config.googleClientSecret;
    }
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(24).toString('base64url');
    putState(state, { userId: req.user.id, verifier, clientId, clientSecret });
    const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/google/callback';
    send(res, 200, { authUrl: buildAuthUrl({ clientId, redirectUri, state, challenge }), state });
    return;
  }
```

Then update the `GET /auth/google/callback` block. Replace:

```javascript
    const clientId = getSecret(db, st.userId, 'google.email.clientId');
    const clientSecret = getSecret(db, st.userId, 'google.email.clientSecret');
    try {
```

with:

```javascript
    const { clientId, clientSecret } = st;
    try {
```

(The rest of the callback body — the `try`/`catch`, `exchangeCode`, `setSecret(db, st.userId, 'google.email.refreshToken', ...)`, `fetchEmailAddress`, `completeState`, `oauthCallbackHtml` calls — is unchanged.)

Also update the callback block's leading comment (currently says "we look up the user's own clientId/clientSecret from the vault rather than trusting anything in the query string") to:

```javascript
  // GET /auth/google/callback?code=...&state=...
  //   Google redirects the user's browser here after consent — there is
  //   no Authorization header on this request, so it must stay public
  //   (also allow-listed in server/auth.mjs PUBLIC_PATHS). The state
  //   token (minted by POST /auth/google/start) carries the userId, PKCE
  //   verifier, and the already-resolved clientId/clientSecret (BYO or
  //   hosted) — never re-derived here, so this code path is identical
  //   for both.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/google-oauth-routes.test.mjs tests/google-oauth-routes-unconfigured.test.mjs`
Expected: PASS — all existing BYO tests (unchanged) plus the new hosted-path and unconfigured tests.

- [ ] **Step 5: Commit**

```bash
git add extension/core/config.mjs extension/server/auth-routes.mjs extension/tests/google-oauth-routes.test.mjs extension/tests/google-oauth-routes-unconfigured.test.mjs
git commit -m "feat(server): hosted Gmail OAuth — /auth/google/start accepts an optional BYO body"
```

---

### Task 2: Backward-compatible token refresh in `agents/email-source.mjs`

**Files:**
- Modify: `extension/agents/email-source.mjs`
- Create: `extension/tests/email-google-token.test.mjs`

**Interfaces:**
- Produces: `getGoogleAccessToken(db, userId)` now falls back to `config.googleClientId`/`googleClientSecret` when the per-user vault has no stored client (hosted users); unchanged behavior when the per-user vault DOES have one (BYO users).
- Consumes: existing `getSecret`, `refreshAccessToken`; new import of `config`.

- [ ] **Step 1: Write the failing tests**

Create `extension/tests/email-google-token.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_GOOGLE_CLIENT_ID = 'hosted-cid';
process.env.LLMIDE_GOOGLE_CLIENT_SECRET = 'hosted-csecret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_email-google-token-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { getGoogleAccessToken } = await import('../agents/email-source.mjs');

function stubTokenFetch(expectClientId) {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('client_id'), expectClientId, `expected token refresh to use client_id=${expectClientId}`);
    return { ok: true, json: async () => ({ access_token: `AT-for-${expectClientId}`, expires_in: 3600 }) };
  };
  return () => { global.fetch = orig; };
}

test('getGoogleAccessToken uses the per-user BYO client when one is stored (not the hosted config)', async () => {
  const u = users.registerUser(kb.getDb(), { email: `byo-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.clientId', 'byo-cid');
  setSecret(kb.getDb(), u.id, 'google.email.clientSecret', 'byo-csecret');
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');

  const restore = stubTokenFetch('byo-cid');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-byo-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken falls back to the hosted config when no per-user client is stored', async () => {
  const u = users.registerUser(kb.getDb(), { email: `hosted-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(kb.getDb(), u.id, 'google.email.refreshToken', 'RT');
  // Deliberately NOT setting google.email.clientId/clientSecret for this user.

  const restore = stubTokenFetch('hosted-cid');
  try {
    const accessToken = await getGoogleAccessToken(kb.getDb(), u.id);
    assert.equal(accessToken, 'AT-for-hosted-cid');
  } finally { restore(); }
});

test('getGoogleAccessToken throws when no refresh token is stored, regardless of client config', async () => {
  const u = users.registerUser(kb.getDb(), { email: `none-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  await assert.rejects(() => getGoogleAccessToken(kb.getDb(), u.id), /not signed in/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && node --test tests/email-google-token.test.mjs`
Expected: FAIL — the hosted-fallback test fails because `getGoogleAccessToken` currently passes `undefined`/`null` for `clientId`/`clientSecret` when nothing is stored per-user (the stub's assertion on `client_id` fails).

- [ ] **Step 3: Write the implementation**

In `extension/agents/email-source.mjs`, add this import near the top (alongside the existing `import { getSecret } from '../server/vault.mjs';` line):

```javascript
import { config } from '../core/config.mjs';
```

Replace the `getGoogleAccessToken` function:

```javascript
export async function getGoogleAccessToken(db, userId) {
  const clientId = getSecret(db, userId, 'google.email.clientId');
  const clientSecret = getSecret(db, userId, 'google.email.clientSecret');
  const refreshToken = getSecret(db, userId, 'google.email.refreshToken');
  if (!refreshToken) throw new Error('Not signed in to Google — use Sign in with Google.');
  const { accessToken } = await refreshAccessToken({ clientId, clientSecret, refreshToken });
  return accessToken;
}
```

with:

```javascript
// Prefer the user's own stored OAuth client (BYO — Google requires the SAME
// client that minted a refresh token to be used when refreshing it, this is
// not a preference), falling back to the server's hosted client for users
// who connected via the hosted "Connect Google" flow and never had per-user
// client fields written.
export async function getGoogleAccessToken(db, userId) {
  const clientId = getSecret(db, userId, 'google.email.clientId') || config.googleClientId;
  const clientSecret = getSecret(db, userId, 'google.email.clientSecret') || config.googleClientSecret;
  const refreshToken = getSecret(db, userId, 'google.email.refreshToken');
  if (!refreshToken) throw new Error('Not signed in to Google — use Sign in with Google.');
  const { accessToken } = await refreshAccessToken({ clientId, clientSecret, refreshToken });
  return accessToken;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && node --test tests/email-google-token.test.mjs`
Expected: PASS (3 tests).

Then run the existing email-source test suite to confirm no regression:

Run: `cd extension && node --test tests/email-source.test.mjs`
Expected: PASS (all existing tests, unaffected — they only exercise pure helpers, not `getGoogleAccessToken`).

- [ ] **Step 5: Commit**

```bash
git add extension/agents/email-source.mjs extension/tests/email-google-token.test.mjs
git commit -m "fix(server): Gmail token refresh falls back to hosted client for non-BYO users"
```

---

### Task 3: Mac — `LlmIdeAPIClient+Email` hosted-connect wrapper

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Email.swift`

**Interfaces:**
- Produces: `googleConnectStart() async throws -> GoogleStartResult` (reuses the existing `GoogleStartResult` type — no new Swift types needed; `googleSignInStatus(state:)` is reused unchanged for polling both the hosted and BYO flows).
- Consumed by: Task 4 (`EmailSourceSheet.swift`).

- [ ] **Step 1: Add the method**

In `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Email.swift`, add this method right after the existing `googleSignInStart(clientId:clientSecret:)` method (find it by searching for `func googleSignInStart`):

```swift
    /// Kick off the hosted Google OAuth flow (LLM-IDE's own Google Cloud
    /// OAuth client, Testing-mode — no client id/secret from the user).
    /// Returns a browser URL to open plus a state token to poll via
    /// `googleSignInStatus`.
    func googleConnectStart() async throws -> GoogleStartResult {
        struct Req: Encodable {}
        return try await post("/auth/google/start", body: Req(), authenticated: true)
    }
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -15`

If you hit `sandbox-exec: sandbox_apply: Operation not permitted`, that's a known sandbox quirk in this environment (not a code problem) — retry the same command with sandbox disabled.

Expected: `Build of product 'LlmIdeMac' complete!` with no errors.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Email.swift
git commit -m "feat(mac): googleConnectStart() hosted OAuth wrapper for Email"
```

---

### Task 4: Mac — `EmailSourceSheet` rework (Connect Google + Advanced)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift` (full-file rewrite — more than half the file changes)

**Interfaces:**
- Consumes: `LlmIdeAPIClient.googleConnectStart()` (Task 3), the existing `googleSignInStart(clientId:clientSecret:)`/`googleSignInStatus(state:)`/`testEmail`/`setSecret`/`markEmailSeen`.
- Produces: the reworked sheet UI. No new types consumed elsewhere.

- [ ] **Step 1: Replace the file**

Overwrite `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift` with:

```swift
import SwiftUI
import AppKit

/// Configure / edit the Email source. Connecting goes through LLM-IDE's
/// hosted Google OAuth app (agents/google-oauth.mjs, /auth/google/*) — the
/// user clicks "Connect Google", approves in the browser, and gets back a
/// refresh token (vault key google.email.refreshToken) for ongoing Gmail
/// IMAP access via XOAUTH2. A manual App Password, or your own Google Cloud
/// OAuth client (Client ID/Secret), stay available behind "Advanced" for a
/// non-Gmail IMAP host or a workspace past the hosted app's Testing-mode
/// user cap; BYO writes to the same vault keys as before and the server
/// prefers a user's own stored client over the hosted one when refreshing.
struct EmailSourceSheet: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(\.dismiss) private var dismiss

    /// Draft seeded from the existing source (or defaults for first setup).
    @State private var draft: SavedEmailSource
    /// True when we're editing an already-saved source (drives the
    /// "leave blank to keep current" password hint + save semantics).
    private let isEditing: Bool

    @State private var connecting = false
    @State private var connectError: String?
    @State private var connectTask: Task<Void, Never>?
    @State private var showAdvanced = false

    @State private var password: String = ""
    @State private var passwordVisible = false
    @State private var testing = false
    @State private var testStatus: String?
    @State private var testWasError = false

    /// "password" | "google" — mirrors `draft.authMethod`, kept in a
    /// separate @State because `draft` can't be read inside its own
    /// stored-property initializer.
    @State private var authMethod: String
    @State private var clientId: String = ""
    @State private var clientSecret: String = ""
    @State private var signingIn = false
    @State private var signInError: String?

    init(api: LlmIdeAPIClient) {
        self.api = api
        let existing = AppConfig.shared.emailSource
        _draft = State(initialValue: existing ?? SavedEmailSource())
        isEditing = existing != nil
        _authMethod = State(initialValue: existing?.authMethod ?? "password")
    }

    /// Test only makes sense once we have somewhere to connect + a password
    /// to authenticate with. In Google mode "Test" isn't the primary path
    /// (sign-in itself proves connectivity), so it's gated on host/user only.
    private var canTest: Bool {
        guard !draft.host.trimmingCharacters(in: .whitespaces).isEmpty,
              !draft.user.trimmingCharacters(in: .whitespaces).isEmpty,
              !testing else { return false }
        return authMethod == "google" || !password.isEmpty
    }

    /// True once a Google OAuth connect has produced an email address —
    /// gates the primary "Connect Google" button vs. a "Connected" hint.
    private var isConnectedViaGoogle: Bool {
        draft.authMethod == "google" && !draft.user.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(isEditing ? "Edit Email Source" : "Add Email Source")
                .font(Typography.title)
                .padding(Spacing.lg)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    field("Display name") {
                        TextField("My inbox (optional)", text: $draft.displayName)
                            .textFieldStyle(.roundedBorder)
                    }

                    if isConnectedViaGoogle {
                        SettingsHint("✓ Connected as \(draft.user).")
                    } else {
                        Button(connecting ? "Connecting…" : "Connect Google") {
                            connectTask = Task { await connectGoogle() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(connecting)
                        if let err = connectError {
                            Text(err)
                                .font(Typography.caption)
                                .foregroundStyle(theme.current.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        SettingsHint("Opens Google in your browser to approve Gmail access. Google will show an \"unverified app\" notice the first time — click Advanced → Go to LLM-IDE to continue.")
                    }

                    DisclosureGroup("Advanced: IMAP settings, App Password, or your own Google OAuth client", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: Spacing.md) {
                            field("IMAP host") {
                                TextField("imap.gmail.com", text: $draft.host)
                                    .textFieldStyle(.roundedBorder)
                                    .disableAutocorrection(true)
                            }
                            field("Port") {
                                TextField("993", value: $draft.port, format: .number.grouping(.never))
                                    .textFieldStyle(.roundedBorder)
                                    .frame(width: 90)
                            }
                            field("Use SSL") {
                                Toggle("", isOn: $draft.secure)
                                    .toggleStyle(.switch)
                                    .labelsHidden()
                            }
                            field("Email address") {
                                TextField("you@example.com", text: $draft.user)
                                    .textFieldStyle(.roundedBorder)
                                    .disableAutocorrection(true)
                            }
                            field("Sign-in method") {
                                Picker("", selection: $authMethod) {
                                    Text("App password").tag("password")
                                    Text("Your own Google OAuth client").tag("google")
                                }
                                .labelsHidden()
                                .pickerStyle(.segmented)
                                .frame(width: 280)
                                .onChange(of: authMethod) { _, newValue in
                                    draft.authMethod = newValue
                                }
                            }

                            if authMethod == "password" {
                                field("App password") {
                                    ZStack(alignment: .trailing) {
                                        Group {
                                            if passwordVisible {
                                                TextField("", text: $password)
                                            } else {
                                                SecureField("", text: $password)
                                            }
                                        }
                                        .textFieldStyle(.roundedBorder)
                                        .font(Typography.mono)
                                        .disableAutocorrection(true)
                                        Button { passwordVisible.toggle() } label: {
                                            Image(systemName: passwordVisible ? "eye.slash" : "eye")
                                                .font(.system(size: 11))
                                                .foregroundStyle(theme.current.textMuted)
                                        }
                                        .buttonStyle(.plain)
                                        .padding(.trailing, 8)
                                        .help(passwordVisible ? "Hide password" : "Show password")
                                        .accessibilityLabel(passwordVisible ? "Hide password" : "Show password")
                                    }
                                }
                                if isEditing {
                                    SettingsHint("Leave the password blank to keep the current one.")
                                }
                                SettingsHint("Gmail: enable 2-Step Verification, then create an App Password (myaccount.google.com → Security → App passwords).")
                            } else {
                                field("Client ID") {
                                    TextField("xxxx.apps.googleusercontent.com", text: $clientId)
                                        .textFieldStyle(.roundedBorder)
                                        .disableAutocorrection(true)
                                }
                                field("Client secret") {
                                    SecureField("", text: $clientSecret)
                                        .textFieldStyle(.roundedBorder)
                                        .font(Typography.mono)
                                        .disableAutocorrection(true)
                                }
                                field("") {
                                    Button(signingIn ? "Signing in…" : "Sign in with Google") {
                                        Task { await signInWithGoogle() }
                                    }
                                    .buttonStyle(.bordered)
                                    .disabled(signingIn
                                              || clientId.trimmingCharacters(in: .whitespaces).isEmpty
                                              || clientSecret.trimmingCharacters(in: .whitespaces).isEmpty)
                                }
                                if let err = signInError {
                                    Text(err)
                                        .font(Typography.caption)
                                        .foregroundStyle(theme.current.danger)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                SettingsHint("One-time setup: Google Cloud console → OAuth consent screen (External, add yourself as a test user) → Credentials → Create OAuth client ID → Desktop app → paste the client ID + secret here. Enable IMAP in Gmail.")
                            }
                        }
                        .padding(.top, Spacing.sm)
                    }

                    field("Mailbox") {
                        TextField("INBOX", text: $draft.mailbox)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Lookback days") {
                        Stepper(value: $draft.lookbackDays, in: 1...60) {
                            Text("\(draft.lookbackDays) day\(draft.lookbackDays == 1 ? "" : "s")")
                                .font(Typography.body)
                        }
                        .frame(width: 200)
                    }
                    field("Unread only") {
                        Toggle("", isOn: $draft.unreadOnly)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                    field("Mark as read") {
                        Toggle("", isOn: $draft.markRead)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                    field("From filter") {
                        TextField("sender@example.com (optional)", text: $draft.fromFilter)
                            .textFieldStyle(.roundedBorder)
                            .disableAutocorrection(true)
                    }
                    field("Enabled") {
                        Toggle("", isOn: $draft.enabled)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                    SettingsHint("On connect, Email captures mail from now on (like meeting capture) — it won't import your whole backlog. \"Lookback days\" only caps how far back a catch-up fetch reaches.")

                    if let s = testStatus {
                        Text(s)
                            .font(Typography.caption)
                            .foregroundStyle(testWasError ? theme.current.danger : theme.current.accent3)
                            .fixedSize(horizontal: false, vertical: true)
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
                    .help("Remove this source and delete the stored app password.")
                }
                Spacer()
                Button(testing ? "Testing…" : "Test") {
                    Task { await test() }
                }
                .buttonStyle(.bordered)
                .disabled(!canTest)
                Button("Save") {
                    Task { await save() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
            .padding(Spacing.lg)
        }
        .frame(minWidth: 440, idealWidth: 480, minHeight: 560)
        .background(theme.current.body)
        .onDisappear {
            connectTask?.cancel()
        }
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

    /// Drive the hosted Google OAuth loopback flow: ask the server (which
    /// owns its own Google Cloud OAuth client — nothing to paste) to start
    /// the flow, open the returned consent URL in the default browser, then
    /// poll `/auth/google/status` until it reports complete/error or ~3
    /// minutes elapse. Cancellable — if the sheet is dismissed mid-connect,
    /// `onDisappear` cancels this task so it doesn't keep polling (and
    /// potentially mutating state) after the view is gone.
    private func connectGoogle() async {
        connecting = true
        connectError = nil
        defer { connecting = false }
        do {
            let r = try await api.googleConnectStart()
            guard let u = URL(string: r.authUrl) else {
                connectError = "Couldn't open the Google sign-in link."
                return
            }
            NSWorkspace.shared.open(u)
            for _ in 0..<90 {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await api.googleSignInStatus(state: r.state)
                if s.status == "complete" {
                    draft.authMethod = "google"
                    draft.host = "imap.gmail.com"
                    draft.port = 993
                    draft.secure = true
                    if let e = s.email, !e.isEmpty { draft.user = e }
                    await initHighWaterMarkIfNeeded()
                    config.emailSource = draft
                    dismiss()
                    return
                }
                if s.status != "pending" {
                    connectError = s.message ?? "Connection failed"
                    return
                }
            }
            connectError = "Connecting timed out — try again."
        } catch is CancellationError {
            // Sheet was dismissed mid-connect — nothing to update on a gone view.
        } catch {
            connectError = error.localizedDescription
        }
    }

    /// Write the password to the vault FIRST (so the server can read it),
    /// then run the connectivity probe.
    private func test() async {
        testing = true
        testStatus = nil
        defer { testing = false }
        do {
            try await api.setSecret(key: "email.imapPassword", value: password)
            let r = try await api.testEmail(draft)
            testWasError = !r.ok
            testStatus = r.ok
                ? "Connected · \(r.total) messages in \(r.mailbox)"
                : "Test failed."
        } catch {
            testWasError = true
            testStatus = error.localizedDescription
        }
    }

    /// Persist the source. Only re-send the password when the user typed
    /// one (blank on edit = keep the stored secret untouched).
    private func save() async {
        if !password.isEmpty {
            do {
                try await api.setSecret(key: "email.imapPassword", value: password)
            } catch {
                testWasError = true
                testStatus = "Couldn't save password: \(error.localizedDescription)"
                return
            }
        }
        await initHighWaterMarkIfNeeded()
        config.emailSource = draft
        dismiss()
    }

    /// Initialize the server-side forward-only high-water mark to "now" on
    /// first connect — and when an edit switches to a DIFFERENT account
    /// (host/user/mailbox), so the previous account's mark can't suppress
    /// the new one's mail. Best-effort; if it fails the per-run cap still
    /// bounds any catch-up.
    private func initHighWaterMarkIfNeeded() async {
        let prev = config.emailSource
        let identityChanged = prev?.host != draft.host
            || prev?.user != draft.user
            || prev?.mailbox != draft.mailbox
        if !isEditing || identityChanged {
            try? await api.markEmailSeen(messageIds: [], lastFetchedAt: Date())
        }
    }

    /// Drive the BYO Google OAuth loopback flow (Advanced fallback): sends
    /// the user's own client id/secret to the server, which persists them
    /// to the per-user vault before running the same PKCE flow. `clientId`/
    /// `clientSecret` never touch AppConfig — they're only sent to the
    /// server, which owns persisting them in the vault.
    private func signInWithGoogle() async {
        signingIn = true
        signInError = nil
        defer { signingIn = false }
        do {
            let r = try await api.googleSignInStart(clientId: clientId, clientSecret: clientSecret)
            guard let u = URL(string: r.authUrl) else {
                signInError = "Couldn't open the Google sign-in link."
                return
            }
            NSWorkspace.shared.open(u)
            for _ in 0..<90 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let s = try await api.googleSignInStatus(state: r.state)
                if s.status == "complete" {
                    draft.authMethod = "google"
                    if let e = s.email, !e.isEmpty { draft.user = e }
                    await initHighWaterMarkIfNeeded()
                    config.emailSource = draft
                    dismiss()
                    return
                }
                if s.status != "pending" {
                    signInError = s.message ?? "Sign-in failed"
                    return
                }
            }
            signInError = "Sign-in timed out — try again."
        } catch {
            signInError = error.localizedDescription
        }
    }

    /// Remove the source and delete the stored app password from the vault
    /// (empty value = delete, per the secrets endpoint). The dedup ledger is
    /// left intact so reconnecting the same account won't re-import old mail.
    /// If clearing the secret fails we keep the source so the password isn't
    /// silently orphaned in the vault.
    private func disconnect() async {
        do {
            try await api.setSecret(key: "email.imapPassword", value: "")
        } catch {
            testWasError = true
            testStatus = "Couldn't remove the stored password: \(error.localizedDescription)"
            return
        }
        config.emailSource = nil
        dismiss()
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -15`
Expected: `Build of product 'LlmIdeMac' complete!` with no errors.

- [ ] **Step 3: Run the Mac unit tests (no regression)**

Run: `cd mac && swift test --filter LlmIdeMacTests 2>&1 | tail -10`
Expected: all tests PASS. (Note: per prior project experience, `swift test` may fail to run at all with "no such module 'XCTest'" in some local CLI toolchains — if so, rely on the build succeeding instead.)

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift
git commit -m "feat(mac): Email source sheet — one-click Connect Google + Advanced fallback"
```

---

### Task 5: Full regression + real-Google-Cloud-client manual verification

**Files:** none (verification only).

- [ ] **Step 1: Full server test suite**

Run: `cd extension && npm test 2>&1 | tail -20`
Expected: all tests PASS, including every new file from Tasks 1–2, and every pre-existing BYO test in `google-oauth-routes.test.mjs` unchanged.

- [ ] **Step 2: Lint**

Run: `cd extension && npx eslint core/config.mjs server/auth-routes.mjs agents/email-source.mjs tests/google-oauth-routes.test.mjs tests/google-oauth-routes-unconfigured.test.mjs tests/email-google-token.test.mjs --max-warnings 0`
Expected: no errors/warnings on these files.

- [ ] **Step 3: Full Mac build + test**

Run: `cd mac && swift build --product LlmIdeMac 2>&1 | tail -10`
Expected: `Build of product 'LlmIdeMac' complete!`

Run: `cd mac && swift test 2>&1 | tail -10`
Expected: all tests PASS, no regressions in the existing suite.

- [ ] **Step 4: Register a real Google Cloud OAuth client in Testing mode (one-time, by the operator)**

1. Go to `https://console.cloud.google.com/` → create or select a project → **APIs & Services → OAuth consent screen**. User type: **External**. Publishing status: leave as **Testing**.
2. Under **Test users**, add every Google account that should be able to connect (up to 100).
3. Under **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Application type: **Desktop app** (the loopback redirect `http://127.0.0.1:<LLMIDE_PORT>/auth/google/callback` matches how the existing BYO flow already works with a Desktop-type client — no Web-application redirect-URI allowlist needed).
4. Copy the **Client ID** and **Client Secret**.
5. Set them in the server's environment before starting it:

```bash
export LLMIDE_GOOGLE_CLIENT_ID="<client id>"
export LLMIDE_GOOGLE_CLIENT_SECRET="<client secret>"
cd extension && node server.mjs
```

- [ ] **Step 5: Manual success criterion (the feature's proof)**

With the server running (Step 4) and the Mac app launched:

1. Open **Settings → Connections → Email → Configure…** (or add a new Email source). No Client ID/Secret fields are shown by default — only a **"Connect Google"** button.
2. Click **Connect Google** → the default browser opens Google's real consent screen for the app created in Step 4. The first time, Google shows an **"unverified app"** notice — click **Advanced → Go to LLM-IDE (unsafe)** → approve.
3. Back in the Mac app, the sheet should immediately show **"✓ Connected as <your Gmail address>"** and close (dismiss) automatically.
4. Re-open the sheet — it should show the connected state; the **Disconnect** button should be present and, if clicked, should remove the stored password/refresh token.
5. Trigger a fetch (Connections card "Fetch" or wait for Auto-Tasks) and confirm mail arrives.
6. **Backward-compat check:** on a Google account that was previously connected via the OLD bring-your-own flow (if one exists), confirm it keeps fetching mail successfully after this deploy with NO re-authentication required — this proves the vault-then-config fallback in `getGoogleAccessToken` is resolving the BYO user's own stored client, not silently switching them to the hosted one.
7. **Advanced fallback check:** open **Advanced**, confirm the App Password and "your own Google OAuth client" fields/flow are still present and functional exactly as before this change.

If any step instead shows a generic error or the "unconfigured" message, that's the designed fallback (server unreachable, session not authenticated, or the hosted client not yet configured) — not a bug, per the spec's error-handling section.

- [ ] **Step 6: (Optional) commit any regression-driven fixups**

```bash
git commit -am "fix(server/mac): <specific tweak found during Gmail connect regression>"
```

## Notes / Out of scope

- Full Google OAuth app verification + CASA security assessment — deferred per the spec; revisit only if LLM-IDE's user base grows toward a public product.
- Any change to the Gmail scope or a move from IMAP to the Gmail REST API — out of scope, unrelated architecture change.
- Box's hosted-OAuth upgrade — separate, later plan.
- `SourceLinkStore.swift` — no change needed; it already recognizes `google.email.refreshToken`.
