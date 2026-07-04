# Gmail via Google Sign-In (OAuth2 / XOAUTH2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Sign in with Google" as an alternative Email auth method (bring-your-own OAuth Desktop client) so Gmail/Workspace accounts that block app passwords can still fetch mail over IMAP via XOAUTH2.

**Architecture:** A backend Google-OAuth helper + three `/auth/google/*` routes drive a loopback PKCE flow: the Mac opens the browser, the public callback exchanges the code and stores a refresh token in the vault, and the email connector authenticates IMAP with a fresh access token (XOAUTH2). App Password stays unchanged; the method is chosen per source.

**Tech Stack:** Node ESM (`node:test`, `node:crypto`, global `fetch`), imapflow (supports `auth:{user,accessToken}`); Swift/SwiftUI (swift-testing, `NSWorkspace.open`). Backend tests: `cd extension && node --test tests/<file>`. Mac: `cd mac && swift build && swift test --filter <Name>` (dangerouslyDisableSandbox for swift build/test).

## Global Constraints

- Auth method is per-source: `SavedEmailSource.authMethod` ∈ `"password"` (default, unchanged) | `"google"`.
- Bring-your-own client: user supplies a Google Cloud **Desktop-app** OAuth client id+secret. No shared/shipped client.
- Redirect is loopback through the running backend: `http://127.0.0.1:3456/auth/google/callback` (Desktop clients auto-allow `127.0.0.1` — no redirect-URI registration).
- OAuth scope: `https://mail.google.com/`; `access_type=offline`, `prompt=consent`, PKCE `S256`, a `state` nonce.
- Vault keys (add to `ALLOWED_KEYS` in `extension/server/vault.mjs`): `google.email.clientId`, `google.email.clientSecret`, `google.email.refreshToken`. `getSecret`/`setSecret` take `db` first.
- Secrets (client secret, refresh token, tokens) live only in the vault; never in AppConfig/UserDefaults/logs/HTML. Redact via `redactWithKey` where an error could echo one.
- `/auth/google/callback` is PUBLIC (browser GET, no JWT) — place it in handleAuth BEFORE the auth gate (`auth-routes.mjs` ~line 309 "every route below has req.user"). `/auth/google/start` + `/auth/google/status` are AUTHED — place them after the gate.
- New endpoints must be added to `server.mjs` ENDPOINTS + `docs/reference/api/openapi.yaml` + the rate-limit row in `docs/spec/api-server.md` (or `make docs-check` fails).
- imapflow: `auth:{user, accessToken}` for XOAUTH2 (vs `auth:{user, pass}`).

---

### Task 1: `google-oauth.mjs` helper + state store

**Files:**
- Create: `extension/agents/google-oauth.mjs`
- Test: `extension/tests/google-oauth.test.mjs`

**Interfaces (all exported):**
- `pkcePair()` → `{ verifier, challenge }` (challenge = base64url(SHA256(verifier))).
- `buildAuthUrl({ clientId, redirectUri, state, challenge })` → string.
- `exchangeCode({ clientId, clientSecret, code, verifier, redirectUri })` → `{ accessToken, refreshToken, expiresIn }`.
- `refreshAccessToken({ clientId, clientSecret, refreshToken })` → `{ accessToken, expiresIn }`.
- `fetchEmailAddress(accessToken)` → `string` (the account email).
- State store: `putState(state, data)`, `getState(state)`, `completeState(state, patch)`, `takeStatus(state)`.

- [ ] **Step 1: Write failing tests** — `extension/tests/google-oauth.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pkcePair, buildAuthUrl, exchangeCode, refreshAccessToken, putState, getState, completeState, takeStatus } from '../agents/google-oauth.mjs';

test('pkcePair: challenge is base64url(SHA256(verifier))', () => {
  const { verifier, challenge } = pkcePair();
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
});

test('buildAuthUrl includes scope, offline, consent, S256, state, challenge', () => {
  const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:3456/auth/google/callback', state: 'st', challenge: 'ch' }));
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('scope'), 'https://mail.google.com/');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('code_challenge'), 'ch');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'st');
  assert.equal(u.searchParams.get('response_type'), 'code');
});

test('exchangeCode posts and parses tokens', async () => {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code_verifier'), 'ver');
    return { ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) };
  };
  try {
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'CODE', verifier: 'ver', redirectUri: 'http://127.0.0.1:3456/auth/google/callback' });
    assert.deepEqual(t, { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 });
  } finally { global.fetch = orig; }
});

test('refreshAccessToken posts refresh grant', async () => {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'RT');
    return { ok: true, json: async () => ({ access_token: 'AT2', expires_in: 3599 }) };
  };
  try {
    const t = await refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'RT' });
    assert.equal(t.accessToken, 'AT2');
  } finally { global.fetch = orig; }
});

test('exchangeCode throws a clean error on non-ok', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }) });
  try {
    await assert.rejects(() => exchangeCode({ clientId: 'c', clientSecret: 's', code: 'x', verifier: 'v', redirectUri: 'r' }), /invalid_grant|bad code/);
  } finally { global.fetch = orig; }
});

test('state store: put/get/complete/take with single-use status', () => {
  putState('S1', { userId: 'u1', verifier: 'v1' });
  assert.equal(getState('S1').userId, 'u1');
  completeState('S1', { status: 'complete', email: 'a@b.com' });
  assert.deepEqual(takeStatus('S1'), { status: 'complete', email: 'a@b.com' });
  // status is single-read: after take it's gone (or pending→unknown)
  assert.equal(getState('S1'), undefined);
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test tests/google-oauth.test.mjs`) — module missing.

- [ ] **Step 3: Implement** `extension/agents/google-oauth.mjs`:

```js
// Google OAuth2 (PKCE) for Gmail IMAP via XOAUTH2. Bring-your-own Desktop
// client. Network is global fetch to fixed Google hosts (no SSRF surface).
import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const SCOPE = 'https://mail.google.com/';
const STATE_TTL_MS = 10 * 60 * 1000;

export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 chars, URL-safe
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge }) {
  const u = new URL(AUTH_ENDPOINT);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return u.toString();
}

async function tokenPost(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export async function exchangeCode({ clientId, clientSecret, code, verifier, redirectUri }) {
  const d = await tokenPost({
    grant_type: 'authorization_code',
    client_id: clientId, client_secret: clientSecret,
    code, code_verifier: verifier, redirect_uri: redirectUri,
  });
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in };
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const d = await tokenPost({
    grant_type: 'refresh_token',
    client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken,
  });
  return { accessToken: d.access_token, expiresIn: d.expires_in };
}

export async function fetchEmailAddress(accessToken) {
  const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json().catch(() => ({}));
  return d.email || '';
}

// In-memory OAuth state store (single-node; TTL-swept). Never holds the
// client secret — the callback reads that from the vault by userId.
const _states = new Map();
function sweep() {
  const now = Date.now();
  for (const [k, v] of _states) if (now - v.createdAt > STATE_TTL_MS) _states.delete(k);
}
export function putState(state, data) { sweep(); _states.set(state, { ...data, status: 'pending', createdAt: Date.now() }); }
export function getState(state) { const v = _states.get(state); if (!v) return undefined; if (Date.now() - v.createdAt > STATE_TTL_MS) { _states.delete(state); return undefined; } return v; }
export function completeState(state, patch) { const v = _states.get(state); if (v) _states.set(state, { ...v, ...patch }); }
// Read the terminal status once and remove it (single-use).
export function takeStatus(state) { const v = _states.get(state); if (!v) return { status: 'unknown' }; if (v.status !== 'pending') _states.delete(state); return { status: v.status, email: v.email, message: v.message }; }
```

- [ ] **Step 4: Run — expect PASS** (`node --test tests/google-oauth.test.mjs`, 6 tests).
- [ ] **Step 5: Commit** — `git add extension/agents/google-oauth.mjs extension/tests/google-oauth.test.mjs && git commit -m "feat(email): Google OAuth2 PKCE helper + state store"`

---

### Task 2: `/auth/google/{start,callback,status}` routes + vault keys

**Files:**
- Modify: `extension/server/vault.mjs` (ALLOWED_KEYS), `extension/server/auth-routes.mjs` (isAuthRoute + handlers), `extension/server.mjs` (ENDPOINTS + rate-limit), `docs/reference/api/openapi.yaml`, `docs/spec/api-server.md`
- Test: `extension/tests/google-oauth-routes.test.mjs`

**Interfaces:**
- Consumes Task 1's helper + state store; `getSecret`/`setSecret` (`server/vault.mjs`).
- Produces: `POST /auth/google/start` → `{authUrl, state}`; `GET /auth/google/callback` → HTML; `GET /auth/google/status?state=` → `{status, email?, message?}`.

- [ ] **Step 1: Vault keys** — add `'google.email.clientId'`, `'google.email.clientSecret'`, `'google.email.refreshToken'` to `ALLOWED_KEYS` in `vault.mjs`.

- [ ] **Step 2: Failing route tests** — `extension/tests/google-oauth-routes.test.mjs`. Reuse the authed-`handleAuth` harness from an existing auth-route test (`grep -l "handleAuth\|/auth/me" tests/*.test.mjs`; read `tests/auth-routes.test.mjs` for the makeReq/makeRes + JWT helpers — reuse them verbatim, temp DB set at top + `await import`). Assertions define the contract:
  - `POST /auth/google/start` (authed) with `{clientId,clientSecret}` → 200, body has `authUrl` (contains the clientId + `code_challenge`) and a `state`; and `getSecret(db,userId,'google.email.clientSecret')` now returns the secret.
  - `GET /auth/google/callback?code=CODE&state=<state from start>` (public, no auth) with global.fetch stubbed to return tokens + userinfo email → 200 HTML; afterwards `getSecret(db,userId,'google.email.refreshToken')` is set.
  - `GET /auth/google/status?state=<state>` (authed) → `{status:'complete', email}`.
  - callback with an unknown state → HTML error page, no throw.
  (If the full harness is heavy, at minimum cover start validation + status; do NOT ship a stub assertion.)

- [ ] **Step 3: Implement handlers** in `auth-routes.mjs`.

Add to `isAuthRoute` (so all three dispatch to handleAuth): `/auth/google/start`, `/auth/google/callback`, `/auth/google/status`.

Import at top: `import { pkcePair, buildAuthUrl, exchangeCode, fetchEmailAddress, putState, getState, completeState, takeStatus } from '../agents/google-oauth.mjs';` and `import { getSecret, setSecret } from './vault.mjs';` (confirm not already imported), and `redactWithKey` from `../core/redact-secrets.mjs`.

**Public callback** — place BEFORE the auth gate (~line 309, alongside `/auth/reset-confirm`):
```js
  if (method === 'GET' && url.split('?')[0] === '/auth/google/callback') {
    const q = new URL(url, 'http://127.0.0.1').searchParams;
    const html = (msg) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;padding:2rem"><p>${msg}</p><p>You can close this tab and return to LLM IDE.</p><script>setTimeout(()=>window.close(),1500)</script>`); };
    const state = q.get('state') || '';
    const st = getState(state);
    if (q.get('error')) { if (st) completeState(state, { status: 'error', message: 'Sign-in cancelled.' }); return html('Sign-in cancelled.'), true; }
    if (!st) { html('This sign-in link has expired — start again from the app.'); return true; }
    const clientId = getSecret(db, st.userId, 'google.email.clientId');
    const clientSecret = getSecret(db, st.userId, 'google.email.clientSecret');
    try {
      const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/google/callback';
      const tok = await exchangeCode({ clientId, clientSecret, code: q.get('code') || '', verifier: st.verifier, redirectUri });
      if (!tok.refreshToken) throw new Error('Google did not return a refresh token — remove the app under myaccount.google.com/permissions and try again.');
      setSecret(db, st.userId, 'google.email.refreshToken', tok.refreshToken);
      const email = await fetchEmailAddress(tok.accessToken).catch(() => '');
      completeState(state, { status: 'complete', email });
      html('Signed in to Google.');
    } catch (e) {
      completeState(state, { status: 'error', message: redactWithKey(e.message, clientSecret) });
      html('Sign-in failed: ' + redactWithKey(e.message, clientSecret));
    }
    return true;
  }
```

**Authed start + status** — place AFTER the auth gate (req.user is set; use `req.user.id`):
```js
  if (method === 'POST' && url === '/auth/google/start') {
    const body = parseAuthBody ? await parseAuthBody(req) : JSON.parse(await readBody(req) || '{}'); // use this file's existing body reader
    const clientId = (body.clientId || '').trim();
    const clientSecret = (body.clientSecret || '').trim();
    if (!clientId || !clientSecret) { send(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'clientId and clientSecret are required' } }); return true; }
    setSecret(db, req.user.id, 'google.email.clientId', clientId);
    setSecret(db, req.user.id, 'google.email.clientSecret', clientSecret);
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(24).toString('base64url');
    putState(state, { userId: req.user.id, verifier });
    const redirectUri = 'http://127.0.0.1:' + config.port + '/auth/google/callback';
    send(res, 200, { authUrl: buildAuthUrl({ clientId, redirectUri, state, challenge }), state });
    return true;
  }
  if (method === 'GET' && url.split('?')[0] === '/auth/google/status') {
    const state = new URL(url, 'http://127.0.0.1').searchParams.get('state') || '';
    const s = getState(state); // ownership: only the initiating user may read
    if (s && s.userId !== req.user.id) { send(res, 403, { error: { code: 'FORBIDDEN', message: 'not your sign-in' } }); return true; }
    send(res, 200, takeStatus(state));
    return true;
  }
```
NOTE: use THIS file's existing helpers (`send`, body reader, `config`, `crypto` import) — read the top of `auth-routes.mjs` and match them; add `import crypto from 'node:crypto'` if absent. Confirm `config.port` is the server port (else hardcode 3456 to match the constraint).

- [ ] **Step 4: Register** — `server.mjs` ENDPOINTS: add `/auth/google/start`, `/auth/google/callback`, `/auth/google/status`. Add openapi.yaml paths (mirror an existing `/auth/*` entry) + the `docs/spec/api-server.md` rate-limit row if auth routes appear there. `/auth/*` already routes to handleAuth via `isAuthRoute`; no rate-limit bucket change needed unless the mapping lists auth routes.

- [ ] **Step 5: Run tests + docs-check + full suite.** `node --test tests/google-oauth-routes.test.mjs`; `cd .. && make docs-check`; `cd extension && npm test`.
- [ ] **Step 6: Commit** — `git add extension/server/vault.mjs extension/server/auth-routes.mjs extension/server.mjs docs/reference/api/openapi.yaml docs/spec/api-server.md extension/tests/google-oauth-routes.test.mjs && git commit -m "feat(email): /auth/google/{start,callback,status} OAuth routes + vault keys"`

---

### Task 3: Email connector XOAUTH2 + route auth-method branch

**Files:**
- Modify: `extension/agents/email-source.mjs` (makeClient, testConnection, fetchRecentEmails, + `getGoogleAccessToken`), `extension/kb/router.mjs` (email test/fetch handlers)
- Test: `extension/tests/email-source.test.mjs` (extend)

**Interfaces:**
- Consumes Task 1's `refreshAccessToken`; `getSecret`.
- Produces: `makeClient`/`testConnection`/`fetchRecentEmails` accept an optional `accessToken` (mutually exclusive with `password`); `getGoogleAccessToken(db, userId)` → `string`.

- [ ] **Step 1: Failing tests** (extend `email-source.test.mjs`) — assert `makeClient({user,accessToken})` builds a client whose auth uses `accessToken` not `pass`. Since makeClient returns an ImapFlow instance, test via a thin seam: extract `buildAuthConfig({user,password,accessToken})` (pure) returning `{user,accessToken}` when accessToken present else `{user,pass:password}`, and test that:
```js
import { buildAuthConfig } from '../agents/email-source.mjs';
test('buildAuthConfig uses XOAUTH2 when an access token is present', () => {
  assert.deepEqual(buildAuthConfig({ user: 'a@b', accessToken: 'AT' }), { user: 'a@b', accessToken: 'AT' });
  assert.deepEqual(buildAuthConfig({ user: 'a@b', password: 'p' }), { user: 'a@b', pass: 'p' });
});
```

- [ ] **Step 2: Run — expect FAIL** (buildAuthConfig missing).

- [ ] **Step 3: Implement** — in `email-source.mjs`:
```js
export function buildAuthConfig({ user, password, accessToken }) {
  return accessToken ? { user, accessToken } : { user, pass: password };
}
```
Change `makeClient` to accept `accessToken` and use `auth: buildAuthConfig({ user, password, accessToken })`. Thread `accessToken` through `testConnection` and `fetchRecentEmails` params (both pass it to makeClient). Add:
```js
import { refreshAccessToken } from './google-oauth.mjs';
import { getSecret } from '../server/vault.mjs';
export async function getGoogleAccessToken(db, userId) {
  const clientId = getSecret(db, userId, 'google.email.clientId');
  const clientSecret = getSecret(db, userId, 'google.email.clientSecret');
  const refreshToken = getSecret(db, userId, 'google.email.refreshToken');
  if (!refreshToken) throw new Error('Not signed in to Google — use Sign in with Google.');
  const { accessToken } = await refreshAccessToken({ clientId, clientSecret, refreshToken });
  return accessToken;
}
```

- [ ] **Step 4: Route branch** — in `kb/router.mjs` email handler: read `authMethod` from body (default `'password'`). When `authMethod === 'google'`, obtain `const accessToken = await getGoogleAccessToken(kb.getDb(), userId)` (wrap in try→502 with a "sign in again" message) and pass `{ ...args, accessToken }` (no password) to `testConnection`/`fetchRecentEmails`; else keep the password path. Import `getGoogleAccessToken`. Keep the existing `EMAIL_NO_PASSWORD` guard only for the password path.

- [ ] **Step 5: Run** — `node --test tests/email-source.test.mjs` (+ the new test); `npm test`.
- [ ] **Step 6: Commit** — `git add extension/agents/email-source.mjs extension/kb/router.mjs extension/tests/email-source.test.mjs && git commit -m "feat(email): IMAP XOAUTH2 via Google access token + route auth-method branch"`

---

### Task 4: Mac `SavedEmailSource.authMethod`

**Files:** Modify `mac/Sources/LlmIdeMac/Models/Config.swift`; Test `mac/Tests/LlmIdeMacTests/SavedEmailSourceAuthMethodTests.swift`

- [ ] **Step 1: Failing test**:
```swift
import Testing
import Foundation
@testable import LlmIdeMac
@MainActor @Suite("SavedEmailSource authMethod")
struct SavedEmailSourceAuthMethodTests {
  @Test func defaultsToPasswordAndRoundTrips() {
    let n = "em-\(UUID().uuidString)"; let d = UserDefaults(suiteName: n)!; d.removePersistentDomain(forName: n)
    let cfg = AppConfig(userDefaults: d)
    var s = SavedEmailSource(); s.user = "a@b"; s.authMethod = "google"
    cfg.emailSource = s
    #expect(AppConfig(userDefaults: d).emailSource?.authMethod == "google")
    // A source decoded without the key defaults to "password".
    var legacy = SavedEmailSource(); #expect(legacy.authMethod == "password")
  }
}
```
- [ ] **Step 2: Run — FAIL** (no `authMethod`).
- [ ] **Step 3: Implement** — add to `SavedEmailSource`: `var authMethod: String = "password"` and in the tolerant `init(from:)`: `authMethod = try c.decodeIfPresent(String.self, forKey: .authMethod) ?? "password"`.
- [ ] **Step 4: Run — PASS**; `swift build`.
- [ ] **Step 5: Commit** — `git commit -am "feat(mac): SavedEmailSource.authMethod (password|google)"`

---

### Task 5: Mac Sign-in UI + API client

**Files:** Modify `mac/Sources/LlmIdeMac/Services/API/LlmIdeAPIClient+Email.swift`, `mac/Sources/LlmIdeMac/Views/Sources/EmailSourceSheet.swift`

**Interfaces:** Consumes `/auth/google/start` + `/auth/google/status`.

- [ ] **Step 1: API client methods** (`+Email.swift`):
```swift
struct GoogleStartResult: Decodable { let authUrl: String; let state: String }
struct GoogleStatusResult: Decodable { let status: String; let email: String? ; let message: String? }
func googleSignInStart(clientId: String, clientSecret: String) async throws -> GoogleStartResult {
    struct Req: Encodable { let clientId: String; let clientSecret: String }
    return try await post("/auth/google/start", body: Req(clientId: clientId, clientSecret: clientSecret), authenticated: true)
}
func googleSignInStatus(state: String) async throws -> GoogleStatusResult {
    try await get("/auth/google/status?state=\(state.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? state)", authenticated: true)
}
```
(Use this client's real GET helper — read `+Email.swift`/`LlmIdeAPIClient.swift` for the `get(_:authenticated:)` signature; if only `post` exists, add a `get` or reuse the existing pattern.)
- [ ] **Step 2: Build** — `swift build` clean.
- [ ] **Step 3: EmailSourceSheet** — add `@State private var authMethod = "password"` (seed from `draft.authMethod`), `@State clientId/clientSecret/signingIn/signInError`. Add a `Picker("Sign-in method", selection:)` with tags `"password"`/`"google"`. In `.google` branch: clientId + clientSecret fields + a "Sign in with Google" button:
```swift
private func signInWithGoogle() async {
    signingIn = true; defer { signingIn = false }
    do {
        let r = try await api.googleSignInStart(clientId: clientId, clientSecret: clientSecret)
        if let u = URL(string: r.authUrl) { NSWorkspace.shared.open(u) }
        // poll status up to ~3 min
        for _ in 0..<90 {
            try await Task.sleep(nanoseconds: 2_000_000_000)
            let s = try await api.googleSignInStatus(state: r.state)
            if s.status == "complete" { draft.authMethod = "google"; if let e = s.email, !e.isEmpty { draft.user = e }; config.emailSource = draft; dismiss(); return }
            if s.status == "error" { signInError = s.message ?? "Sign-in failed"; return }
        }
        signInError = "Sign-in timed out — try again."
    } catch { signInError = error.localizedDescription }
}
```
Guard `save()`/`canTest` so Google mode doesn't require the password field. Add a `SettingsHint` with the one-time Google Cloud Desktop-client setup steps.
- [ ] **Step 4: Build + full suite** — `swift build`; `swift test`.
- [ ] **Step 5: Manual (controller/human)** — real Google consent is interactive; verify the button opens the browser and, after consent, the source saves as `google`.
- [ ] **Step 6: Commit** — `git commit -am "feat(mac): Sign in with Google for the Email source"`

---

## Self-Review

**Spec coverage:** auth-method choice → T4/T5; bring-your-own client + vault → T2; loopback+PKCE+state → T1/T2; XOAUTH2 + refresh → T1/T3; routes (start authed / callback public / status authed) → T2; keep App Password → untouched password path in T3; testing → each task. ✓

**Placeholder scan:** T2/T3/T5 contain "read this file's existing `send`/`get`/harness and match it" instructions rather than guessed signatures for the auth-routes body reader, the API-client GET helper, and the auth-route test harness — these are reuse-the-existing-primitive directives (the exact helper varies and must be matched, not reinvented), each with the concrete code to add around them. No "add error handling" placeholders. The route test explicitly forbids shipping a stub.

**Type consistency:** `authMethod` values `"password"`/`"google"`; helper exports (`pkcePair`, `buildAuthUrl`, `exchangeCode`, `refreshAccessToken`, `fetchEmailAddress`, `putState/getState/completeState/takeStatus`, `buildAuthConfig`, `getGoogleAccessToken`); vault keys `google.email.{clientId,clientSecret,refreshToken}`; redirect `http://127.0.0.1:<port>/auth/google/callback`; route response shapes (`{authUrl,state}`, `{status,email?,message?}`) consistent across backend, tests, and the Mac client.
