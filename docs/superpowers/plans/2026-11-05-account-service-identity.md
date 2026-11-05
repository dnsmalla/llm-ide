# Account Service: Identity, Profile and Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project 1 of the accounts design: a new, independently deployable `account-service/` with email sign-up by single-use link, passkey registration and sign-in, short-lived cookie sessions, the lost-passkey email flow, profile read/update, export and delete, rate limits, no user enumeration and an audit log, with sign-up closed by default.

**Architecture:** A plain Node `http` server (no framework, as ADR 0002) bound to `127.0.0.1` behind nginx, with its own SQLite database (WAL, numbered append-only migrations), its own system user, and three runtime dependencies. It is **API only**: JSON routes under `/v1/`; the account web pages (sign-up form, the `/account/verify` link landing page, sign-in, account settings) are static files built in sub-project 4 and served from the same origin. Email links carry the token in the URL fragment and are consumed only by `POST`, so a mail scanner's `GET` consumes nothing. WebAuthn is done entirely by `@simplewebauthn/server` behind a four-function adapter so tests can inject a recording fake.

**Tech Stack:** Node 22 (ESM `.mjs`), `node:test`, `better-sqlite3` 13.0.3, `@simplewebauthn/server` 14.0.3, `nodemailer` 10.3.1, GitHub Actions, systemd, nginx.

**Spec:** [`docs/superpowers/specs/2026-11-05-accounts-and-device-linking-design.md`](../specs/2026-11-05-accounts-and-device-linking-design.md) (sections 4.1 to 4.3, 5, 6, 7, 8 item 2, 9). Decision record: [ADR 0019](../../decisions/0019-public-accounts-desktop-data.md).

## Global Constraints

- The service lives in the new top-level `account-service/` and **never imports `extension/`**; it contains no AI, agent, plugin, MCP or connector code. Enforced by `account-service/scripts/check-boundary.mjs` in CI.
- Runtime dependencies are exactly `@simplewebauthn/server` 14.0.3, `better-sqlite3` 13.0.3, `nodemailer` 10.3.1, pinned exactly (`--save-exact`), with a committed `package-lock.json`. No dev dependencies.
- `"type": "module"`, `"engines": { "node": ">=22.0.0" }`, tests with `node --test` (CI uses Node 22 like `extension-ci.yml`).
- Bind only to a loopback host; production requires an `https:` origin and the SMTP mailer (`smtps://` URL); the file mailer is refused in production.
- **Sign-up is closed unless `ACCOUNTS_SIGNUP_OPEN=1`.** It stays closed on the VPS until sub-project 5 (external review, relay D9).
- Email tokens: 256-bit random, **only `SHA-256(token)` stored**, purpose-bound, 15 minutes, single use; consuming one kills every other open token of the same address and purpose.
- Sessions: opaque 256-bit tokens, hash stored; cookie `__Host-llmide_session` on HTTPS (`llmide_session` on plain-HTTP dev), `Path=/; HttpOnly; SameSite=Strict` (+ `Secure` on HTTPS). Full session: 1 h idle, 12 h absolute. Setup session: 15 min, may only register a passkey. Fresh check: 5 min since the last passkey proof.
- Passkeys: resident key **required**, user verification **required**, attestation `none`, discoverable sign-in with empty `allowCredentials`.
- Every non-GET request needs `Origin` exactly equal to `ACCOUNTS_ORIGIN` and `Content-Type: application/json`. No CORS headers are ever sent.
- No enumeration: `POST /v1/signup` and `POST /v1/recovery` always answer `202 {"status":"check_email"}`; every sign-in failure is `400 {"error":"signin_failed"}`; mail is sent off the request path.
- Rate limits: per IP 120 requests/min overall, sign-up 10/h, recovery 10/h, link verification 20/h, sign-in options 30/min, sign-in verify 10/min; per address 3 mails/h and 10/day across all routes.
- IP addresses kept at most 72 hours (relay D5); audit rows kept 400 days; never log tokens, cookies, bodies or link fragments.
- Error bodies are `{"error":"<code>"}` only.
- Commit on `main` (user rule: no branches); Conventional Commits.

---

## File Structure

| File | Responsibility |
|---|---|
| `account-service/package.json` | Package, scripts, exact dependency pins |
| `account-service/bin/account-service.mjs` | Process entry: config, DB, mailer, listen, retention timer, shutdown |
| `account-service/src/config.mjs` | `loadConfig(env)`: validated, frozen config |
| `account-service/src/db.mjs` | `openDb(path)`, `migrate(db)`, `newId()` |
| `account-service/src/migrations/0001_init.sql` | All sub-project 1 tables |
| `account-service/src/http.mjs` | `HttpError`, `readJson`, `send` |
| `account-service/src/server.mjs` | `createApp(deps)`: context, route table, error handling |
| `account-service/src/guard.mjs` | `clientIp`, `checkOrigin` |
| `account-service/src/rate-limit.mjs` | `createRateLimiter`, `limitMailTo`, `HOUR`, `DAY` |
| `account-service/src/audit.mjs` | `createAudit(db, now)` |
| `account-service/src/mailer.mjs` | `createMailer(mail)` (file, smtp), `deliver(...)` with retries |
| `account-service/src/mail-templates.mjs` | Text-only mail bodies |
| `account-service/src/email-tokens.mjs` | `createEmailTokens(db, now)`: issue and consume hashed tokens |
| `account-service/src/sessions.mjs` | `createSessions(db, config, now)`, `parseCookies` |
| `account-service/src/validate.mjs` | Email, display name, language, time zone, closed objects |
| `account-service/src/users.mjs` | `getUser`, `getUserByEmail`, `publicAccount` |
| `account-service/src/ceremonies.mjs` | `createCeremonies(db, now)`: single-use WebAuthn challenges |
| `account-service/src/webauthn.mjs` | `simpleWebAuthn` adapter over `@simplewebauthn/server` |
| `account-service/src/retention.mjs` | `purge(db, now)` |
| `account-service/src/routes/health.mjs` | `GET /health` |
| `account-service/src/routes/signup.mjs` | `POST /v1/signup`, `POST /v1/signup/verify` |
| `account-service/src/routes/passkeys.mjs` | `POST /v1/passkeys/options`, `POST /v1/passkeys/verify` |
| `account-service/src/routes/signin.mjs` | `POST /v1/signin/options`, `POST /v1/signin/verify`, `POST /v1/signout` |
| `account-service/src/routes/recovery.mjs` | `POST /v1/recovery`, `POST /v1/recovery/verify` |
| `account-service/src/routes/account.mjs` | Profile, passkey removal, revoke others, export, delete |
| `account-service/scripts/check-boundary.mjs` | Import and dependency allowlist check |
| `account-service/tests/helpers.mjs` | In-process app, cookie client, memory mailer, fake WebAuthn |
| `account-service/tests/*.test.mjs` | One test file per task |
| `.github/workflows/account-service-ci.yml` | CI job |
| `Makefile` | `test-account-service` target, part of `make regression` |
| `deploy/vps/llmide-accounts.service` | systemd unit, unprivileged user |
| `deploy/vps/accounts.llm-ide.com.nginx` | nginx vhost |
| `deploy/vps/README.md` | Deploy note |

Why these libraries:

- **`@simplewebauthn/server` 14.0.3**: maintained, widely used, verifies challenge, origin, RP ID, user verification, signature counters and the attestation formats for us; we write no WebAuthn parsing or signature code. Registry: `engines.node >= 20`.
- **`nodemailer` 10.3.1**: the standard Node SMTP client, no runtime dependencies; used only for SMTPS to a transactional provider (spec Q1).
- **`better-sqlite3` 13.0.3**: already the core's database driver (`extension/package-lock.json`), synchronous single-writer transactions, prebuilt binaries for Node 22. `node:sqlite` was rejected: still experimental in Node 22.

The service has no OAuth code in sub-project 1 (desktop sign-in is sub-project 2).

---

### Task 1: Package skeleton, config, SQLite migrations, health, CI

**Files:**
- Create: `account-service/package.json`, `account-service/src/config.mjs`, `account-service/src/http.mjs`, `account-service/src/db.mjs`, `account-service/src/migrations/0001_init.sql`, `account-service/src/server.mjs`, `account-service/src/routes/health.mjs`, `account-service/scripts/check-boundary.mjs`, `account-service/tests/helpers.mjs`, `account-service/.gitignore`, `.github/workflows/account-service-ci.yml`
- Modify: `Makefile` (new target, regression list)
- Test: `account-service/tests/config.test.mjs`, `account-service/tests/health.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadConfig(env = process.env) -> Readonly<{ prod, origin, rpId, rpName, host, port, dbPath, signupOpen, trustProxy, secureCookies, mail: { transport, smtpUrl, dir, from, retryMs } }>`
  - `class HttpError extends Error { status: number; code: string; headers: object }` with `new HttpError(status, code, headers = {})`
  - `readJson(req, limit = 16384) -> Promise<object>`, `send(res, status, body?, headers = {})`
  - `openDb(path) -> Database`, `migrate(db)`, `newId() -> string` (128-bit base64url)
  - `createApp({ config, db, mailer, webauthn, now }) -> http.Server`; handlers have the signature `(req, res, ctx)`; route groups are `(routes: Map<string, handler>, ctx) => void` keyed `"METHOD /path"`
  - test helpers: `startApp(opts) -> { config, db, clock, mailer, webauthn, base, client(), close() }`, `createClient(base)` with `.call(method, path, body?, headers?) -> { status, headers, body }` and `.cookie`, `memoryMailer()`, `fakeWebAuthn()`, `waitForMail(mailer, count)`, `linkToken(mail)`, `insertUser(db, { id, email, status })`, `ORIGIN`

- [ ] **Step 1: Create the package and install the pinned dependencies**

`account-service/package.json`:

```json
{
  "name": "llmide-account-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "LLM-IDE public account service: identity, profile, devices, relay. No AI and no user data.",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "start": "node bin/account-service.mjs",
    "test": "node --test --test-timeout=30000 \"tests/*.test.mjs\"",
    "check:boundary": "node scripts/check-boundary.mjs"
  },
  "dependencies": {
    "@simplewebauthn/server": "14.0.3",
    "better-sqlite3": "13.0.3",
    "nodemailer": "10.3.1"
  }
}
```

`account-service/.gitignore`:

```gitignore
node_modules/
data/
```

Run: `cd account-service && npm install --save-exact --no-audit --no-fund`
Expected: `package-lock.json` created, `node_modules/` present. (If npm reports `EPERM` on `~/.npm/_cacache`, add `--cache "$TMPDIR/npmcache"`.)

- [ ] **Step 2: Write the failing config and health tests**

`account-service/tests/helpers.mjs`:

```js
import http from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

export const ORIGIN = 'http://localhost:3470';

export function memoryMailer() {
  const sent = [];
  return {
    sent,
    fail: 0, // number of upcoming sends that throw
    async send(msg) {
      if (this.fail > 0) {
        this.fail -= 1;
        throw new Error('smtp down');
      }
      sent.push(msg);
    },
  };
}

// Records every call; the real library is @simplewebauthn/server (src/webauthn.mjs).
// A test response is { id, challenge } (+ bad: true to simulate a bad signature).
export function fakeWebAuthn() {
  let n = 0;
  const calls = [];
  return {
    calls,
    async generateRegistrationOptions(opts) {
      calls.push(['generateRegistrationOptions', opts]);
      n += 1;
      return { challenge: `reg-${n}`, rp: { id: opts.rpID, name: opts.rpName }, user: { name: opts.userName } };
    },
    async verifyRegistrationResponse(opts) {
      calls.push(['verifyRegistrationResponse', opts]);
      if (opts.response.challenge !== opts.expectedChallenge) throw new Error('challenge mismatch');
      return {
        verified: true,
        registrationInfo: {
          credential: { id: opts.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      };
    },
    async generateAuthenticationOptions(opts) {
      calls.push(['generateAuthenticationOptions', opts]);
      n += 1;
      return { challenge: `auth-${n}`, rpId: opts.rpID, allowCredentials: opts.allowCredentials };
    },
    async verifyAuthenticationResponse(opts) {
      calls.push(['verifyAuthenticationResponse', opts]);
      if (opts.response.challenge !== opts.expectedChallenge) throw new Error('challenge mismatch');
      if (opts.response.bad) throw new Error('bad signature');
      return { verified: true, authenticationInfo: { newCounter: opts.credential.counter + 1 } };
    },
  };
}

export async function startApp({ env = {}, mailer = memoryMailer(), webauthn = fakeWebAuthn(), startAt = Date.UTC(2026, 10, 5, 9) } = {}) {
  const config = loadConfig({
    ACCOUNTS_ORIGIN: ORIGIN,
    ACCOUNTS_SIGNUP_OPEN: '1',
    ACCOUNTS_DB_PATH: ':memory:',
    ACCOUNTS_MAIL_RETRY_MS: '1',
    ...env,
  });
  let t = startAt;
  const clock = { now: () => t, advance(ms) { t += ms; } };
  const db = openDb(config.dbPath);
  const app = createApp({ config, db, mailer, webauthn, now: clock.now });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  return {
    config, db, clock, mailer, webauthn, base,
    client: () => createClient(base),
    async close() {
      await new Promise((resolve) => app.close(resolve));
      db.close();
    },
  };
}

export function createClient(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, path, body, headers = {}) {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const res = await rawRequest(base, method, path, data, {
        origin: ORIGIN,
        ...(data !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      });
      for (const c of res.headers['set-cookie'] ?? []) {
        const [pair] = c.split(';');
        cookie = pair.slice(pair.indexOf('=') + 1) ? pair : '';
      }
      return res;
    },
  };
}

export function rawRequest(base, method, path, data, headers) {
  const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  if (data !== undefined) clean['content-length'] = Buffer.byteLength(data);
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers: clean }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

export async function waitForMail(mailer, count) {
  for (let i = 0; i < 400 && mailer.sent.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (mailer.sent.length < count) throw new Error(`expected ${count} mails, got ${mailer.sent.length}`);
  return mailer.sent[count - 1];
}

export function linkToken(mail) {
  const m = /#purpose=[a-z]+&token=([A-Za-z0-9_-]{43})/.exec(mail.text);
  if (!m) throw new Error('no link in mail');
  return m[1];
}

export function insertUser(db, { id = 'user-1', email = 'ada@example.com', status = 'active' } = {}) {
  db.prepare(
    `INSERT INTO users (id, email, display_name, language, time_zone, status, webauthn_user_id, created_at, updated_at)
     VALUES (?, ?, 'Ada', 'en', 'UTC', ?, randomblob(32), 0, 0)`,
  ).run(id, email, status);
  return id;
}
```

`account-service/tests/config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('defaults: loopback, sign-up closed, file mailer in development', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 3470);
  assert.equal(c.signupOpen, false);
  assert.equal(c.mail.transport, 'file');
  assert.equal(c.rpId, 'localhost');
  assert.equal(c.secureCookies, false);
});

test('sign-up opens only with ACCOUNTS_SIGNUP_OPEN=1', () => {
  assert.equal(loadConfig({ ACCOUNTS_SIGNUP_OPEN: '1' }).signupOpen, true);
  assert.equal(loadConfig({ ACCOUNTS_SIGNUP_OPEN: '0' }).signupOpen, false);
});

test('production requires https, smtps and never the file mailer', () => {
  const prod = { NODE_ENV: 'production', ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_SMTP_URL: 'smtps://u:p@smtp.example.com:465' };
  const c = loadConfig(prod);
  assert.equal(c.rpId, 'accounts.llm-ide.com');
  assert.equal(c.secureCookies, true);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_ORIGIN: 'http://accounts.llm-ide.com' }), /https/);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_MAIL_TRANSPORT: 'file' }), /file mailer/);
  assert.throws(() => loadConfig({ ...prod, ACCOUNTS_SMTP_URL: 'smtp://smtp.example.com' }), /smtps/);
});

test('refuses a non-loopback bind, a non-bare origin and a foreign RP ID', () => {
  assert.throws(() => loadConfig({ ACCOUNTS_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com/x' }), /bare origin/);
  assert.throws(() => loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_RP_ID: 'evil.com' }), /RP_ID/);
  assert.equal(loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_RP_ID: 'llm-ide.com' }).rpId, 'llm-ide.com');
});
```

`account-service/tests/health.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.mjs';
import { startApp, createClient } from './helpers.mjs';

test('GET /health reports the service and the sign-up state', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_SIGNUP_OPEN: '0' } });
  t.after(() => app.close());
  const res = await createClient(app.base).call('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, service: 'account-service', signupOpen: false });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('unknown routes are 404 with a fixed error body', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const res = await createClient(app.base).call('GET', '/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('migrations create every table once and are idempotent', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
  for (const name of ['audit_events', 'email_tokens', 'passkeys', 'schema_migrations', 'sessions', 'users', 'webauthn_challenges']) {
    assert.ok(tables.includes(name), name);
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), 1);
  db.close();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd account-service && npm test`
Expected: FAIL with `Cannot find module '.../src/config.mjs'`.

- [ ] **Step 4: Implement config, http helpers, DB, migration, server and health**

`account-service/src/config.mjs`:

```js
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const flag = (env, name) => /^(1|true|yes|on)$/i.test(env[name] ?? '');

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const origin = env.ACCOUNTS_ORIGIN ?? 'http://localhost:3470';
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('ACCOUNTS_ORIGIN must be an absolute URL');
  }
  if (url.origin !== origin) throw new Error('ACCOUNTS_ORIGIN must be a bare origin such as https://accounts.llm-ide.com');
  if (prod && url.protocol !== 'https:') throw new Error('ACCOUNTS_ORIGIN must use https in production');
  const rpId = env.ACCOUNTS_RP_ID ?? url.hostname;
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw new Error('ACCOUNTS_RP_ID must equal the origin host or be a parent domain of it');
  }
  const host = env.ACCOUNTS_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('ACCOUNTS_HOST must be a loopback address; put nginx in front');
  const port = Number(env.ACCOUNTS_PORT ?? 3470);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('ACCOUNTS_PORT must be a port number');
  const transport = env.ACCOUNTS_MAIL_TRANSPORT ?? (prod ? 'smtp' : 'file');
  if (!['smtp', 'file'].includes(transport)) throw new Error('ACCOUNTS_MAIL_TRANSPORT must be smtp or file');
  if (prod && transport !== 'smtp') throw new Error('the file mailer writes sign-in links to disk; production needs smtp');
  const smtpUrl = env.ACCOUNTS_SMTP_URL ?? '';
  if (transport === 'smtp' && !smtpUrl.startsWith('smtps://')) throw new Error('ACCOUNTS_SMTP_URL must be an smtps:// URL');
  const retryMs = Number(env.ACCOUNTS_MAIL_RETRY_MS ?? 2000);
  if (!Number.isFinite(retryMs) || retryMs < 1) throw new Error('ACCOUNTS_MAIL_RETRY_MS must be a positive number');
  return Object.freeze({
    prod,
    origin,
    rpId,
    rpName: 'LLM-IDE',
    host,
    port,
    dbPath: env.ACCOUNTS_DB_PATH ?? './data/accounts.db',
    signupOpen: flag(env, 'ACCOUNTS_SIGNUP_OPEN'),
    trustProxy: flag(env, 'ACCOUNTS_TRUST_PROXY'),
    secureCookies: url.protocol === 'https:',
    mail: Object.freeze({
      transport,
      smtpUrl,
      dir: env.ACCOUNTS_MAIL_DIR ?? './data/mail',
      from: env.ACCOUNTS_MAIL_FROM ?? 'LLM-IDE <no-reply@llm-ide.com>',
      retryMs,
    }),
  });
}
```

`account-service/src/http.mjs`:

```js
export class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export async function readJson(req, limit = 16 * 1024) {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'json_required');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json');
  return value;
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
```

`account-service/src/db.mjs`:

```js
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export const newId = () => randomBytes(16).toString('base64url');

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

// Append-only numbered migrations (same rule as ADR 0008): never edit a shipped file.
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all());
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  for (const name of files) {
    if (done.has(name)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    })();
  }
}
```

`account-service/src/migrations/0001_init.sql`:

```sql
-- Sub-project 1: identity, profile, sessions, audit. Tokens are stored only as SHA-256 hex.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  language TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_passkey', 'active')),
  webauthn_user_id BLOB NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  recovered_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'recovery')),
  email TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_tokens_email ON email_tokens(email, purpose);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'signin')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('full', 'setup')),
  via TEXT NOT NULL CHECK (via IN ('passkey', 'signup', 'recovery')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_at INTEGER NOT NULL,
  ip TEXT,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

-- No foreign key: the audit trail outlives a deleted account (pseudonymous user id only).
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT,
  event TEXT NOT NULL,
  ip TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_user ON audit_events(user_id, at);
```

`account-service/src/routes/health.mjs`:

```js
import { send } from '../http.mjs';

export function healthRoutes(routes, ctx) {
  routes.set('GET /health', async (req, res) => {
    send(res, 200, { ok: true, service: 'account-service', signupOpen: ctx.config.signupOpen });
  });
}
```

`account-service/src/server.mjs`:

```js
import http from 'node:http';
import { HttpError, send } from './http.mjs';
import { healthRoutes } from './routes/health.mjs';

const ROUTE_GROUPS = [healthRoutes];

export function createApp({ config, db, mailer = null, webauthn = null, now = Date.now }) {
  const ctx = { config, db, mailer, webauthn, now };
  const routes = new Map();
  for (const register of ROUTE_GROUPS) register(routes, ctx);
  return http.createServer((req, res) => {
    handle(req, res, routes, ctx).catch((err) => internalError(res, err));
  });
}

async function handle(req, res, routes, ctx) {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    const handler = routes.get(`${req.method} ${path}`);
    if (!handler) throw new HttpError(404, 'not_found');
    await handler(req, res, ctx);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    send(res, err.status, { error: err.code }, err.headers);
  }
}

function internalError(res, err) {
  // Only the error class and code: never bodies, tokens, cookies or SQL text.
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled', name: err?.name, code: err?.code }));
  if (!res.headersSent) send(res, 500, { error: 'internal' });
  else res.destroy();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS, 7 tests. (Tests listen on `127.0.0.1:0`; a sandbox that forbids local binding fails with `EPERM` — run unsandboxed.)

- [ ] **Step 6: Add the boundary check, the CI job and the Makefile target**

`account-service/scripts/check-boundary.mjs`:

```js
// Fails if the service imports anything but node: built-ins, its own files and the three
// allowed dependencies, or if package.json gains a dependency. Keeps extension/ and AI code out.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))) + sep;
const ALLOWED = ['@simplewebauthn/server', 'better-sqlite3', 'nodemailer'];
const problems = [];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {}).sort();
if (JSON.stringify(deps) !== JSON.stringify(ALLOWED)) problems.push(`package.json dependencies must be exactly ${ALLOWED.join(', ')}`);
if (pkg.devDependencies && Object.keys(pkg.devDependencies).length) problems.push('package.json must have no devDependencies');

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith('.mjs')) check(path);
  }
}

function check(file) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const ok = spec.startsWith('node:')
      || ALLOWED.some((d) => spec === d || spec.startsWith(`${d}/`))
      || ((spec.startsWith('./') || spec.startsWith('../')) && resolve(dirname(file), spec).startsWith(root));
    if (!ok) problems.push(`${file.slice(root.length)}: import "${spec}" is not allowed`);
  }
}

for (const dir of ['src', 'bin', 'scripts', 'tests']) {
  try { walk(join(root, dir)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('account-service boundary: ok');
```

Run: `cd account-service && npm run check:boundary`
Expected: `account-service boundary: ok`.

`.github/workflows/account-service-ci.yml`:

```yaml
name: account-service-ci

# Tests the public account service on every push / PR that touches it.

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - 'account-service/**'
      - '.github/workflows/account-service-ci.yml'
  pull_request:
    paths:
      - 'account-service/**'
      - '.github/workflows/account-service-ci.yml'

concurrency:
  group: account-service-ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    name: Boundary, audit & test
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: account-service
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: account-service/package-lock.json

      - name: Install dependencies
        run: npm ci --no-audit --no-fund

      - name: Boundary (no extension/, no AI, three allowed dependencies)
        run: npm run check:boundary

      - name: Dependency audit
        run: npm audit --omit=dev --audit-level=high

      - name: Test
        run: npm test
```

`Makefile`: add after the `test-desktop` block (before `# --- mac`), following the skip-if-not-installed pattern of `test-desktop-node`:

```make
# --- account service ---------------------------------------------------------

.PHONY: test-account-service
test-account-service:
	@if [ -d account-service/node_modules ]; then \
	  cd account-service && npm run -s check:boundary && npm test --silent; \
	else echo "test-account-service: account-service/node_modules missing (cd account-service && npm ci); skipping"; fi
```

and in the `regression:` prerequisites replace `contract-gates test-desktop-node test-mac` with `contract-gates test-desktop-node test-account-service test-mac`.

Run: `make test-account-service`
Expected: `account-service boundary: ok`, then the tests pass.

- [ ] **Step 7: Commit**

```bash
git add account-service .github/workflows/account-service-ci.yml Makefile
git commit -m "feat(accounts): add the account-service skeleton with config, SQLite and health"
```

---

### Task 2: Origin guard, client IP, rate limits, audit log

**Files:**
- Create: `account-service/src/guard.mjs`, `account-service/src/rate-limit.mjs`, `account-service/src/audit.mjs`
- Modify: `account-service/src/server.mjs`
- Test: `account-service/tests/guard.test.mjs`

**Interfaces:**
- Consumes: `HttpError` (Task 1), `db` with `audit_events` (Task 1).
- Produces:
  - `clientIp(req, config) -> string`, `checkOrigin(req, config)` (throws `403 bad_origin`)
  - `createRateLimiter({ now, maxKeys }) -> { hit(key, limit, windowMs) }` (throws `429 rate_limited` with `retry-after`)
  - `limitMailTo(limiter, email)` (3/h and 10/day per address), `HOUR`, `DAY`
  - `createAudit(db, now) -> (event, { userId, ip, detail }) => void`
  - `ctx.limiter`, `ctx.audit`, and `req.clientIp` set for every routed request

- [ ] **Step 1: Write the failing tests**

`account-service/tests/guard.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { HttpError } from '../src/http.mjs';
import { checkOrigin, clientIp } from '../src/guard.mjs';
import { createRateLimiter, limitMailTo, HOUR } from '../src/rate-limit.mjs';
import { createAudit } from '../src/audit.mjs';

const fakeReq = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('clientIp trusts X-Real-IP only behind a loopback proxy with trustProxy on', () => {
  const off = loadConfig({});
  const on = loadConfig({ ACCOUNTS_TRUST_PROXY: '1' });
  assert.equal(clientIp(fakeReq('127.0.0.1', { 'x-real-ip': '203.0.113.9' }), off), '127.0.0.1');
  assert.equal(clientIp(fakeReq('127.0.0.1', { 'x-real-ip': '203.0.113.9' }), on), '203.0.113.9');
  assert.equal(clientIp(fakeReq('198.51.100.7', { 'x-real-ip': '203.0.113.9' }), on), '198.51.100.7');
});

test('checkOrigin requires the exact service origin', () => {
  const config = loadConfig({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_MAIL_TRANSPORT: 'file' });
  checkOrigin({ headers: { origin: 'https://accounts.llm-ide.com' } }, config);
  for (const origin of [undefined, 'null', 'https://evil.example', 'https://accounts.llm-ide.com.evil.example']) {
    assert.throws(() => checkOrigin({ headers: { origin } }, config), (e) => e instanceof HttpError && e.status === 403 && e.code === 'bad_origin');
  }
});

test('rate limiter trips past the limit and resets after the window', () => {
  let t = 0;
  const limiter = createRateLimiter({ now: () => t });
  for (let i = 0; i < 3; i += 1) limiter.hit('k', 3, 1000);
  assert.throws(() => limiter.hit('k', 3, 1000), (e) => e.status === 429 && e.headers['retry-after'] === '1');
  t = 1000;
  limiter.hit('k', 3, 1000);
});

test('limitMailTo allows 3 mails per address per hour and 10 per day', () => {
  let t = 0;
  const limiter = createRateLimiter({ now: () => t });
  let sent = 0;
  for (let hour = 0; hour < 5; hour += 1) {
    t = hour * HOUR;
    for (let i = 0; i < 3; i += 1) {
      try { limitMailTo(limiter, 'a@example.com'); sent += 1; } catch (e) { assert.equal(e.status, 429); }
    }
  }
  assert.equal(sent, 10);
});

test('audit writes one row per event with JSON detail', () => {
  const db = openDb(':memory:');
  const audit = createAudit(db, () => 42);
  audit('signin', { userId: 'u1', ip: '203.0.113.9', detail: { passkeyId: 'p1' } });
  const row = db.prepare('SELECT at, user_id, event, ip, detail FROM audit_events').get();
  assert.deepEqual({ ...row }, { at: 42, user_id: 'u1', event: 'signin', ip: '203.0.113.9', detail: '{"passkeyId":"p1"}' });
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/guard.test.mjs`
Expected: FAIL with `Cannot find module '.../src/guard.mjs'`.

- [ ] **Step 3: Implement**

`account-service/src/guard.mjs`:

```js
import { HttpError } from './http.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// nginx sets X-Real-IP to $remote_addr (overwriting any client value); trust it only from loopback.
export function clientIp(req, config) {
  const peer = req.socket.remoteAddress ?? '';
  const real = req.headers['x-real-ip'];
  if (config.trustProxy && LOOPBACK.has(peer) && typeof real === 'string' && real.length > 0 && real.length <= 45) return real;
  return peer;
}

export function checkOrigin(req, config) {
  if (req.headers.origin !== config.origin) throw new HttpError(403, 'bad_origin');
}
```

`account-service/src/rate-limit.mjs`:

```js
import { HttpError } from './http.mjs';

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

// shortcut: in-memory fixed windows for the one service process; counters reset on restart.
// Move to a SQLite table if the service ever runs more than one process.
export function createRateLimiter({ now = Date.now, maxKeys = 100_000 } = {}) {
  const windows = new Map();
  function sweep(t) {
    for (const [key, w] of windows) if (t >= w.resetAt) windows.delete(key);
    if (windows.size >= maxKeys) windows.clear();
  }
  return {
    hit(key, limit, windowMs) {
      const t = now();
      let w = windows.get(key);
      if (!w || t >= w.resetAt) {
        if (windows.size >= maxKeys) sweep(t);
        w = { count: 0, resetAt: t + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count > limit) {
        throw new HttpError(429, 'rate_limited', { 'retry-after': String(Math.max(1, Math.ceil((w.resetAt - t) / 1000))) });
      }
    },
  };
}

// Caps mail to one address across every route (sign-up and recovery), so the service
// cannot be used to flood someone's inbox.
export function limitMailTo(limiter, email) {
  limiter.hit(`mail-hour:${email}`, 3, HOUR);
  limiter.hit(`mail-day:${email}`, 10, DAY);
}
```

`account-service/src/audit.mjs`:

```js
// detail must never contain tokens, cookies, email addresses or request bodies.
export function createAudit(db, now) {
  const insert = db.prepare('INSERT INTO audit_events (at, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?)');
  return (event, { userId = null, ip = null, detail = {} } = {}) => {
    insert.run(now(), userId, event, ip, JSON.stringify(detail));
  };
}
```

`account-service/src/server.mjs`: add the imports after `import { HttpError, send } from './http.mjs';`:

```js
import { checkOrigin, clientIp } from './guard.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createAudit } from './audit.mjs';
```

replace `  const ctx = { config, db, mailer, webauthn, now };` with:

```js
  const ctx = { config, db, mailer, webauthn, now };
  ctx.limiter = createRateLimiter({ now });
  ctx.audit = createAudit(db, now);
```

and replace

```js
    if (!handler) throw new HttpError(404, 'not_found');
    await handler(req, res, ctx);
```

with

```js
    if (!handler) throw new HttpError(404, 'not_found');
    req.clientIp = clientIp(req, ctx.config);
    ctx.limiter.hit(`ip:${req.clientIp}`, 120, 60_000);
    if (req.method !== 'GET') checkOrigin(req, ctx.config);
    await handler(req, res, ctx);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (all earlier tests plus 5 new).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/guard.mjs account-service/src/rate-limit.mjs account-service/src/audit.mjs account-service/src/server.mjs account-service/tests/guard.test.mjs
git commit -m "feat(accounts): add origin guard, rate limits and the audit log"
```

---

### Task 3: Mailer, mail templates and hashed email tokens

**Files:**
- Create: `account-service/src/mailer.mjs`, `account-service/src/mail-templates.mjs`, `account-service/src/email-tokens.mjs`
- Modify: `account-service/src/server.mjs`
- Test: `account-service/tests/mail-and-tokens.test.mjs`

**Interfaces:**
- Consumes: `config.mail` (Task 1), `ctx.audit` (Task 2).
- Produces:
  - `createMailer(mail) -> { send({ to, subject, text }): Promise<void>, file? }` (transports `file`, `smtp`)
  - `deliver(mailer, msg, { retryMs, attempts = 5, onFail })`: fire-and-forget, retries with doubling back-off
  - `ctx.mail(msg)`: `deliver` with the configured back-off; on final failure audits `mail_failed`
  - `createEmailTokens(db, now) -> { issue(purpose, email, payload = {}) -> token, consume(purpose, token) -> { email, payload } | null }`, `EMAIL_TOKEN_TTL_MS = 900000`
  - templates: `signupMail(config, to, token)`, `alreadyRegisteredMail(config, to)`, `recoveryMail(config, to, token)`, `passkeyAddedMail(config, to, { viaRecovery })`, `passkeyRemovedMail(config, to)`, `accountDeletedMail(config, to)`, each `-> { to, subject, text }`

- [ ] **Step 1: Write the failing tests**

`account-service/tests/mail-and-tokens.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { createMailer, deliver } from '../src/mailer.mjs';
import { createEmailTokens, EMAIL_TOKEN_TTL_MS } from '../src/email-tokens.mjs';
import { signupMail } from '../src/mail-templates.mjs';
import { loadConfig } from '../src/config.mjs';
import { memoryMailer, waitForMail, linkToken } from './helpers.mjs';

test('file transport appends one JSON line per mail, owner-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'accounts-mail-'));
  const mailer = createMailer({ transport: 'file', dir, from: 'LLM-IDE <no-reply@llm-ide.com>' });
  await mailer.send({ to: 'a@example.com', subject: 's', text: 't' });
  const line = JSON.parse(readFileSync(mailer.file, 'utf8').trim());
  assert.deepEqual(line, { from: 'LLM-IDE <no-reply@llm-ide.com>', to: 'a@example.com', subject: 's', text: 't' });
  assert.equal(statSync(mailer.file).mode & 0o077, 0);
});

test('deliver retries a failing provider and reports a final failure', async () => {
  const flaky = memoryMailer();
  flaky.fail = 2;
  deliver(flaky, { to: 'a@example.com', subject: 's', text: 't' }, { retryMs: 1 });
  await waitForMail(flaky, 1);

  const down = memoryMailer();
  down.fail = 99;
  let failed = false;
  deliver(down, { to: 'a@example.com', subject: 's', text: 't' }, { retryMs: 1, onFail: () => { failed = true; } });
  for (let i = 0; i < 400 && !failed; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(failed, true);
  assert.equal(down.sent.length, 0);
});

test('signup mail carries the token in the fragment of the verify page', () => {
  const config = loadConfig({ ACCOUNTS_ORIGIN: 'http://localhost:3470' });
  const token = 'A'.repeat(43);
  const mail = signupMail(config, 'a@example.com', token);
  assert.match(mail.text, /http:\/\/localhost:3470\/account\/verify#purpose=signup&token=A{43}/);
  assert.equal(linkToken(mail), token);
});

test('email tokens: hash at rest, single use, purpose-bound, 15 minutes, siblings die', () => {
  const db = openDb(':memory:');
  let t = 1_000;
  const tokens = createEmailTokens(db, () => t);

  const a = tokens.issue('signup', 'a@example.com', { displayName: 'Ada' });
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  const stored = db.prepare('SELECT token_hash FROM email_tokens').pluck().get();
  assert.notEqual(stored, a);
  assert.match(stored, /^[0-9a-f]{64}$/);

  assert.equal(tokens.consume('recovery', a), null);
  assert.deepEqual(tokens.consume('signup', a), { email: 'a@example.com', payload: { displayName: 'Ada' } });
  assert.equal(tokens.consume('signup', a), null);

  const old = tokens.issue('signup', 'b@example.com');
  const fresh = tokens.issue('signup', 'b@example.com');
  assert.ok(tokens.consume('signup', fresh));
  assert.equal(tokens.consume('signup', old), null);

  const late = tokens.issue('recovery', 'c@example.com');
  t += EMAIL_TOKEN_TTL_MS;
  assert.equal(tokens.consume('recovery', late), null);

  assert.equal(tokens.consume('signup', 'not-a-token'), null);
  assert.equal(tokens.consume('signup', undefined), null);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/mail-and-tokens.test.mjs`
Expected: FAIL with `Cannot find module '.../src/mailer.mjs'`.

- [ ] **Step 3: Implement**

`account-service/src/mailer.mjs`:

```js
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

export function createMailer(mail) {
  if (mail.transport === 'file') {
    // Development only (config refuses it in production): the file holds live sign-in links.
    mkdirSync(mail.dir, { recursive: true, mode: 0o700 });
    const file = join(mail.dir, 'outbox.jsonl');
    return {
      file,
      async send(msg) {
        appendFileSync(file, `${JSON.stringify({ from: mail.from, ...msg })}\n`, { mode: 0o600 });
      },
    };
  }
  if (mail.transport === 'smtp') {
    const transport = nodemailer.createTransport(mail.smtpUrl);
    return {
      async send(msg) {
        await transport.sendMail({ from: mail.from, to: msg.to, subject: msg.subject, text: msg.text });
      },
    };
  }
  throw new Error(`unknown mail transport ${mail.transport}`);
}

// Off the request path, so a response never waits on (or reveals) the mail branch.
// The token is never stored in clear, so a restart drops a pending mail; the user resends.
export function deliver(mailer, msg, { retryMs = 2000, attempts = 5, onFail = () => {} } = {}) {
  let tries = 0;
  const attempt = () => {
    Promise.resolve()
      .then(() => mailer.send(msg))
      .catch(() => {
        tries += 1;
        if (tries < attempts) setTimeout(attempt, retryMs * 2 ** (tries - 1)).unref();
        else onFail();
      });
  };
  setImmediate(attempt);
}
```

`account-service/src/mail-templates.mjs`:

```js
// Text-only mail: no HTML, so user-supplied names cannot inject markup.
const link = (config, purpose, token) => `${config.origin}/account/verify#purpose=${purpose}&token=${token}`;
const signIn = (config) => `${config.origin}/account/sign-in`;

export function signupMail(config, to, token) {
  return {
    to,
    subject: 'Confirm your LLM-IDE account',
    text: [
      'Open this link within 15 minutes to finish creating your LLM-IDE account:',
      '',
      link(config, 'signup', token),
      '',
      'The link works once. If you did not ask for an account, ignore this email.',
    ].join('\n'),
  };
}

export function alreadyRegisteredMail(config, to) {
  return {
    to,
    subject: 'You already have an LLM-IDE account',
    text: [
      'Someone asked to create an LLM-IDE account with this address, which already has one.',
      '',
      `Sign in with your passkey at ${signIn(config)}`,
      'Lost your passkey? Use "Lost your passkey?" on that page.',
      '',
      'If this was not you, you can ignore this email.',
    ].join('\n'),
  };
}

export function recoveryMail(config, to, token) {
  return {
    to,
    subject: 'Add a new passkey to your LLM-IDE account',
    text: [
      'Open this link within 15 minutes to add a new passkey:',
      '',
      link(config, 'recovery', token),
      '',
      'Adding a passkey this way signs out every other session.',
      'If you did not ask for this, ignore this email; nothing changes.',
    ].join('\n'),
  };
}

export function passkeyAddedMail(config, to, { viaRecovery }) {
  return {
    to,
    subject: 'A passkey was added to your LLM-IDE account',
    text: [
      viaRecovery
        ? 'A new passkey was added through an email link, and every other session was signed out.'
        : 'A new passkey was added to your account.',
      '',
      `If this was not you, sign in at ${signIn(config)} , remove the passkey, and secure your email account.`,
    ].join('\n'),
  };
}

export function passkeyRemovedMail(config, to) {
  return {
    to,
    subject: 'A passkey was removed from your LLM-IDE account',
    text: `A passkey was removed from your account. If this was not you, sign in at ${signIn(config)} .`,
  };
}

export function accountDeletedMail(config, to) {
  return {
    to,
    subject: 'Your LLM-IDE account was deleted',
    text: 'Your LLM-IDE account and its sign-in data were deleted. Data on your own computer is not affected.',
  };
}
```

`account-service/src/email-tokens.mjs`:

```js
import { createHash, randomBytes } from 'node:crypto';

export const EMAIL_TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function createEmailTokens(db, now) {
  const insert = db.prepare(
    'INSERT INTO email_tokens (token_hash, purpose, email, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const byHash = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?');
  const useAll = db.prepare('UPDATE email_tokens SET used_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL');

  return {
    issue(purpose, email, payload = {}) {
      const token = randomBytes(32).toString('base64url');
      const t = now();
      insert.run(hash(token), purpose, email, JSON.stringify(payload), t + EMAIL_TOKEN_TTL_MS, t);
      return token;
    },
    consume(purpose, token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      return db.transaction(() => {
        const row = byHash.get(hash(token));
        const t = now();
        if (!row || row.purpose !== purpose || row.used_at !== null || row.expires_at <= t) return null;
        useAll.run(t, row.email, row.purpose); // this token and every older one for the address
        return { email: row.email, payload: JSON.parse(row.payload) };
      })();
    },
  };
}
```

`account-service/src/server.mjs`: add the imports

```js
import { createEmailTokens } from './email-tokens.mjs';
import { deliver } from './mailer.mjs';
```

and after `  ctx.audit = createAudit(db, now);` add:

```js
  ctx.tokens = createEmailTokens(db, now);
  ctx.mail = (msg) => deliver(mailer, msg, {
    retryMs: config.mail.retryMs,
    onFail: () => ctx.audit('mail_failed', { detail: { subject: msg.subject } }),
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/mailer.mjs account-service/src/mail-templates.mjs account-service/src/email-tokens.mjs account-service/src/server.mjs account-service/tests/mail-and-tokens.test.mjs
git commit -m "feat(accounts): add the mailer and single-use hashed email tokens"
```

---

### Task 4: Sessions

**Files:**
- Create: `account-service/src/sessions.mjs`
- Modify: `account-service/src/server.mjs`
- Test: `account-service/tests/sessions.test.mjs`

**Interfaces:**
- Consumes: `config.secureCookies` (Task 1), `insertUser` test helper (Task 1).
- Produces:
  - `createSessions(db, config, now) -> { cookieName, create({ userId, scope: 'full'|'setup', via: 'passkey'|'signup'|'recovery', ip }) -> { idHash, cookie }, clearCookie() -> string, read(req) -> row|null, require(req, scopes = ['full']) -> row (throws 401 unauthenticated), requireFresh(row) (throws 401 reauth_required), revoke(idHash), revokeOthers(userId, keepIdHash|null) -> number }`
  - constants `FULL_IDLE_MS`, `FULL_ABSOLUTE_MS`, `SETUP_ABSOLUTE_MS`, `FRESH_MS`; `parseCookies(header)`
  - a session row has the columns of `sessions` (`id_hash`, `user_id`, `scope`, `via`, `auth_at`, …)
  - `ctx.sessions`

- [ ] **Step 1: Write the failing tests**

`account-service/tests/sessions.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createSessions, FULL_IDLE_MS, FULL_ABSOLUTE_MS, SETUP_ABSOLUTE_MS, FRESH_MS } from '../src/sessions.mjs';
import { insertUser } from './helpers.mjs';

function setup(env = {}) {
  const db = openDb(':memory:');
  insertUser(db);
  const clock = { t: 1_000_000 };
  const sessions = createSessions(db, loadConfig(env), () => clock.t);
  const reqWith = (cookie) => ({ headers: { cookie: cookie.split(';')[0] } });
  return { db, clock, sessions, reqWith };
}

test('HTTPS cookies use the __Host- prefix, Secure, HttpOnly and SameSite=Strict', () => {
  const { sessions } = setup({ ACCOUNTS_ORIGIN: 'https://accounts.llm-ide.com', ACCOUNTS_MAIL_TRANSPORT: 'file' });
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: '203.0.113.9' });
  assert.match(cookie, /^__Host-llmide_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200$/);
  assert.match(sessions.clearCookie(), /^__Host-llmide_session=; .*Max-Age=0$/);
});

test('only the token hash is stored', () => {
  const { db, sessions } = setup();
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  const token = cookie.split(';')[0].split('=')[1];
  const row = db.prepare('SELECT id_hash FROM sessions').get();
  assert.notEqual(row.id_hash, token);
  assert.match(row.id_hash, /^[0-9a-f]{64}$/);
});

test('full sessions expire after 1 h idle and 12 h absolute', () => {
  const { clock, sessions, reqWith } = setup();
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  // Twelve touches just inside the idle window: 12 h - 12 ms, still under the absolute limit.
  for (let i = 0; i < 12; i += 1) {
    clock.t += FULL_IDLE_MS - 1;
    assert.ok(sessions.read(reqWith(cookie)), `alive after touch ${i + 1}`);
  }
  assert.equal(FULL_ABSOLUTE_MS, 12 * FULL_IDLE_MS);
  clock.t += FULL_IDLE_MS - 1; // within idle, past the 12 h absolute limit
  assert.equal(sessions.read(reqWith(cookie)), null);

  const second = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  clock.t += FULL_IDLE_MS + 1;
  assert.equal(sessions.read(reqWith(second.cookie)), null);
});

test('setup sessions last 15 minutes and are refused where a full session is required', () => {
  const { clock, sessions, reqWith } = setup();
  const { cookie } = sessions.create({ userId: 'user-1', scope: 'setup', via: 'signup', ip: null });
  assert.throws(() => sessions.require(reqWith(cookie)), (e) => e.status === 401 && e.code === 'unauthenticated');
  assert.equal(sessions.require(reqWith(cookie), ['setup']).scope, 'setup');
  clock.t += SETUP_ABSOLUTE_MS;
  assert.equal(sessions.read(reqWith(cookie)), null);
});

test('fresh check, revoke and revokeOthers', () => {
  const { clock, sessions, reqWith } = setup();
  const a = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  const b = sessions.create({ userId: 'user-1', scope: 'full', via: 'passkey', ip: null });
  const sa = sessions.read(reqWith(a.cookie));
  sessions.requireFresh(sa);
  clock.t += FRESH_MS + 1;
  assert.throws(() => sessions.requireFresh(sessions.read(reqWith(a.cookie))), (e) => e.code === 'reauth_required');
  assert.equal(sessions.revokeOthers('user-1', a.idHash), 1);
  assert.equal(sessions.read(reqWith(b.cookie)), null);
  assert.ok(sessions.read(reqWith(a.cookie)));
  sessions.revoke(a.idHash);
  assert.equal(sessions.read(reqWith(a.cookie)), null);
});

test('garbage cookies are ignored', () => {
  const { sessions } = setup();
  assert.equal(sessions.read({ headers: {} }), null);
  assert.equal(sessions.read({ headers: { cookie: 'llmide_session=../../etc' } }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/sessions.test.mjs`
Expected: FAIL with `Cannot find module '.../src/sessions.mjs'`.

- [ ] **Step 3: Implement**

`account-service/src/sessions.mjs`:

```js
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.mjs';

export const FULL_IDLE_MS = 60 * 60_000;
export const FULL_ABSOLUTE_MS = 12 * 60 * 60_000;
export const SETUP_ABSOLUTE_MS = 15 * 60_000;
export const FRESH_MS = 5 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createSessions(db, config, now) {
  const name = config.secureCookies ? '__Host-llmide_session' : 'llmide_session';
  const attrs = `Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? '; Secure' : ''}`;
  const insert = db.prepare(
    `INSERT INTO sessions (id_hash, user_id, scope, via, created_at, last_seen_at, expires_at, auth_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byHash = db.prepare('SELECT * FROM sessions WHERE id_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?');
  const revokeOne = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL');
  const revokeUser = db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL');

  function read(req) {
    const token = parseCookies(req.headers.cookie)[name];
    if (!token || !TOKEN_RE.test(token)) return null;
    const session = byHash.get(hash(token));
    const t = now();
    if (!session || session.revoked_at !== null || session.expires_at <= t) return null;
    if (session.scope === 'full' && t - session.last_seen_at > FULL_IDLE_MS) return null;
    touch.run(t, session.id_hash);
    return session;
  }

  return {
    cookieName: name,
    create({ userId, scope, via, ip }) {
      const token = randomBytes(32).toString('base64url');
      const t = now();
      const ttl = scope === 'full' ? FULL_ABSOLUTE_MS : SETUP_ABSOLUTE_MS;
      const idHash = hash(token);
      insert.run(idHash, userId, scope, via, t, t, t + ttl, t, ip ?? null);
      return { idHash, cookie: `${name}=${token}; ${attrs}; Max-Age=${ttl / 1000}` };
    },
    clearCookie: () => `${name}=; ${attrs}; Max-Age=0`,
    read,
    require(req, scopes = ['full']) {
      const session = read(req);
      if (!session || !scopes.includes(session.scope)) throw new HttpError(401, 'unauthenticated');
      return session;
    },
    requireFresh(session) {
      if (now() - session.auth_at > FRESH_MS) throw new HttpError(401, 'reauth_required');
    },
    revoke(idHash) {
      revokeOne.run(now(), idHash);
    },
    revokeOthers(userId, keepIdHash) {
      return revokeUser.run(now(), userId, keepIdHash ?? '').changes;
    },
  };
}
```

`account-service/src/server.mjs`: add `import { createSessions } from './sessions.mjs';` and after the `ctx.mail = …;` statement add:

```js
  ctx.sessions = createSessions(db, config, now);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (6 new tests).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/sessions.mjs account-service/src/server.mjs account-service/tests/sessions.test.mjs
git commit -m "feat(accounts): add short-lived hashed cookie sessions"
```

---

### Task 5: Email sign-up and link verification

**Files:**
- Create: `account-service/src/validate.mjs`, `account-service/src/users.mjs`, `account-service/src/routes/signup.mjs`
- Modify: `account-service/src/server.mjs`
- Test: `account-service/tests/signup.test.mjs`

**Interfaces:**
- Consumes: `ctx.limiter`, `limitMailTo`, `HOUR` (Task 2); `ctx.tokens`, `ctx.mail`, `signupMail`, `alreadyRegisteredMail` (Task 3); `ctx.sessions` (Task 4); `newId` (Task 1).
- Produces:
  - `normalizeEmail(v)`, `displayName(v)`, `language(v)`, `timeZone(v)`, `onlyKeys(body, allowed)` — each throws `400 invalid_<field>` or `400 invalid_payload`
  - `getUser(db, id)`, `getUserByEmail(db, email)` -> row or `null`; `publicAccount(db, user) -> { id, email, displayName, language, timeZone, status, createdAt, passkeys: [{ id, name, deviceType, backedUp, createdAt, lastUsedAt }] }`
  - `POST /v1/signup {email, displayName, language?, timeZone?}` -> `202 {status:'check_email'}` | `403 signup_closed`
  - `POST /v1/signup/verify {token}` -> `200 {status:'add_passkey'}` + setup-session cookie | `400 invalid_or_expired_link`

- [ ] **Step 1: Write the failing tests**

`account-service/tests/signup.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitForMail, linkToken, insertUser } from './helpers.mjs';

const form = (email = 'ada@example.com') => ({ email, displayName: 'Ada', language: 'en', timeZone: 'Asia/Tokyo' });

test('sign-up is refused while closed', async (t) => {
  const app = await startApp({ env: { ACCOUNTS_SIGNUP_OPEN: '0' } });
  t.after(() => app.close());
  const res = await app.client().call('POST', '/v1/signup', form());
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'signup_closed' });
});

test('new address: 202, a link mail, verify gives a setup session and a pending user', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  const res = await c.call('POST', '/v1/signup', form('  Ada@Example.COM '));
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { status: 'check_email' });
  const mail = await waitForMail(app.mailer, 1);
  assert.equal(mail.to, 'ada@example.com');
  const verify = await c.call('POST', '/v1/signup/verify', { token: linkToken(mail) });
  assert.equal(verify.status, 200);
  assert.deepEqual(verify.body, { status: 'add_passkey' });
  assert.match(c.cookie, /^llmide_session=/);
  const user = app.db.prepare('SELECT * FROM users').get();
  assert.equal(user.status, 'pending_passkey');
  assert.equal(user.time_zone, 'Asia/Tokyo');
  assert.equal(user.webauthn_user_id.length, 32);
  assert.equal(app.db.prepare('SELECT scope, via FROM sessions').get().scope, 'setup');
});

test('no enumeration: an existing address gets the same answer and a different mail', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  insertUser(app.db, { email: 'known@example.com' });
  const known = await app.client().call('POST', '/v1/signup', form('known@example.com'));
  const unknown = await app.client().call('POST', '/v1/signup', form('new@example.com'));
  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.body, unknown.body);
  await waitForMail(app.mailer, 2);
  const toKnown = app.mailer.sent.find((m) => m.to === 'known@example.com');
  assert.equal(toKnown.subject, 'You already have an LLM-IDE account');
  assert.doesNotMatch(toKnown.text, /token=/);
});

test('links are single use, expire after 15 minutes and the newest kills the older', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  await c.call('POST', '/v1/signup', form());
  await c.call('POST', '/v1/signup', form());
  const first = linkToken(await waitForMail(app.mailer, 1));
  const second = linkToken(await waitForMail(app.mailer, 2));
  assert.equal((await c.call('POST', '/v1/signup/verify', { token: second })).status, 200);
  assert.deepEqual((await c.call('POST', '/v1/signup/verify', { token: second })).body, { error: 'invalid_or_expired_link' });
  assert.equal((await c.call('POST', '/v1/signup/verify', { token: first })).status, 400);

  await c.call('POST', '/v1/signup', form('late@example.com'));
  const late = linkToken(await waitForMail(app.mailer, 3));
  app.clock.advance(15 * 60_000);
  assert.equal((await c.call('POST', '/v1/signup/verify', { token: late })).status, 400);
});

test('origin, content type, validation and the per-address mail cap', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  assert.deepEqual((await c.call('POST', '/v1/signup', form(), { origin: undefined })).body, { error: 'bad_origin' });
  assert.equal((await c.call('POST', '/v1/signup', form(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.call('POST', '/v1/signup', form(), { 'content-type': 'text/plain' })).status, 415);
  assert.deepEqual((await c.call('POST', '/v1/signup', form('nope'))).body, { error: 'invalid_email' });
  assert.deepEqual((await c.call('POST', '/v1/signup', { ...form(), timeZone: 'Mars/Base' })).body, { error: 'invalid_time_zone' });
  assert.deepEqual((await c.call('POST', '/v1/signup', { ...form(), displayName: '' })).body, { error: 'invalid_display_name' });
  assert.deepEqual((await c.call('POST', '/v1/signup', { ...form(), admin: true })).body, { error: 'invalid_payload' });
  for (let i = 0; i < 3; i += 1) assert.equal((await c.call('POST', '/v1/signup', form('cap@example.com'))).status, 202);
  assert.equal((await c.call('POST', '/v1/signup', form('cap@example.com'))).status, 429);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/signup.test.mjs`
Expected: FAIL: every request answers `404 not_found` (no route yet).

- [ ] **Step 3: Implement**

`account-service/src/validate.mjs`:

```js
import { HttpError } from './http.mjs';

const TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_email');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'invalid_email');
  return email;
}

export function displayName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_display_name');
  const name = value.trim();
  if (name.length < 1 || name.length > 80 || /\p{Cc}/u.test(name)) throw new HttpError(400, 'invalid_display_name');
  return name;
}

export function language(value) {
  if (typeof value !== 'string' || value.length > 35 || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
    throw new HttpError(400, 'invalid_language');
  }
  return value;
}

export function timeZone(value) {
  if (typeof value !== 'string' || !TIME_ZONES.has(value)) throw new HttpError(400, 'invalid_time_zone');
  return value;
}

// Closed request objects, as in Host API v1: an unknown field is an error, not ignored.
export function onlyKeys(body, allowed) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, 'invalid_payload');
}
```

`account-service/src/users.mjs`:

```js
export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null;
}

// What a signed-in user may see about their own account: never counters or public keys.
export function publicAccount(db, user) {
  const passkeys = db
    .prepare('SELECT id, name, device_type, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at')
    .all(user.id);
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    language: user.language,
    timeZone: user.time_zone,
    status: user.status,
    createdAt: user.created_at,
    passkeys: passkeys.map((p) => ({
      id: p.id,
      name: p.name,
      deviceType: p.device_type,
      backedUp: p.backed_up === 1,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
    })),
  };
}
```

`account-service/src/routes/signup.mjs`:

```js
import { randomBytes } from 'node:crypto';
import { newId } from '../db.mjs';
import { HttpError, readJson, send } from '../http.mjs';
import { alreadyRegisteredMail, signupMail } from '../mail-templates.mjs';
import { HOUR, limitMailTo } from '../rate-limit.mjs';
import { getUserByEmail } from '../users.mjs';
import { displayName, language, normalizeEmail, onlyKeys, timeZone } from '../validate.mjs';

export function signupRoutes(routes, ctx) {
  routes.set('POST /v1/signup', async (req, res) => {
    if (!ctx.config.signupOpen) throw new HttpError(403, 'signup_closed');
    ctx.limiter.hit(`signup-ip:${req.clientIp}`, 10, HOUR);
    const body = await readJson(req);
    onlyKeys(body, ['email', 'displayName', 'language', 'timeZone']);
    const email = normalizeEmail(body.email);
    const profile = {
      displayName: displayName(body.displayName),
      language: language(body.language ?? 'en'),
      timeZone: timeZone(body.timeZone ?? 'UTC'),
    };
    limitMailTo(ctx.limiter, email);
    const user = getUserByEmail(ctx.db, email);
    if (user?.status === 'active') ctx.mail(alreadyRegisteredMail(ctx.config, email));
    else ctx.mail(signupMail(ctx.config, email, ctx.tokens.issue('signup', email, profile)));
    ctx.audit('signup_requested', { userId: user?.id ?? null, ip: req.clientIp });
    send(res, 202, { status: 'check_email' });
  });

  routes.set('POST /v1/signup/verify', async (req, res) => {
    ctx.limiter.hit(`verify-ip:${req.clientIp}`, 20, HOUR);
    const body = await readJson(req);
    const found = ctx.tokens.consume('signup', body.token);
    if (!found) throw new HttpError(400, 'invalid_or_expired_link');
    const { email, payload } = found;
    const userId = ctx.db.transaction(() => {
      const existing = getUserByEmail(ctx.db, email);
      const t = ctx.now();
      if (existing?.status === 'active') return null;
      if (existing) {
        ctx.db.prepare('UPDATE users SET display_name = ?, language = ?, time_zone = ?, updated_at = ? WHERE id = ?')
          .run(payload.displayName, payload.language, payload.timeZone, t, existing.id);
        return existing.id;
      }
      const id = newId();
      ctx.db.prepare(
        `INSERT INTO users (id, email, display_name, language, time_zone, status, webauthn_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_passkey', ?, ?, ?)`,
      ).run(id, email, payload.displayName, payload.language, payload.timeZone, randomBytes(32), t, t);
      return id;
    })();
    if (!userId) throw new HttpError(400, 'invalid_or_expired_link');
    const { cookie } = ctx.sessions.create({ userId, scope: 'setup', via: 'signup', ip: req.clientIp });
    ctx.audit('signup_verified', { userId, ip: req.clientIp });
    send(res, 200, { status: 'add_passkey' }, { 'set-cookie': cookie });
  });
}
```

`account-service/src/server.mjs`: add `import { signupRoutes } from './routes/signup.mjs';` and change `const ROUTE_GROUPS = [healthRoutes];` to:

```js
const ROUTE_GROUPS = [healthRoutes, signupRoutes];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/validate.mjs account-service/src/users.mjs account-service/src/routes/signup.mjs account-service/src/server.mjs account-service/tests/signup.test.mjs
git commit -m "feat(accounts): add email sign-up with single-use verification links"
```

---

### Task 6: Passkey registration

**Files:**
- Create: `account-service/src/webauthn.mjs`, `account-service/src/ceremonies.mjs`, `account-service/src/routes/passkeys.mjs`
- Modify: `account-service/src/server.mjs`, `account-service/tests/helpers.mjs`
- Test: `account-service/tests/passkeys.test.mjs`

**Interfaces:**
- Consumes: `ctx.sessions` (Task 4); `getUser` (Task 5); `ctx.mail`, `passkeyAddedMail` (Task 3); `newId` (Task 1); `fakeWebAuthn` (Task 1).
- Produces:
  - `simpleWebAuthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse }` (the `@simplewebauthn/server` functions; `createApp`'s `webauthn` dependency has this shape)
  - `createCeremonies(db, now) -> { save(purpose: 'register'|'signin', challenge, userId = null) -> ceremonyId, take(ceremonyId, purpose) -> { challenge, user_id, expires_at } | null }`, `CEREMONY_TTL_MS = 300000`; `ctx.ceremonies`
  - `POST /v1/passkeys/options {}` (setup session, or a fresh full session) -> `200 { ceremonyId, options }`
  - `POST /v1/passkeys/verify { ceremonyId, response, name? }` -> `201 { status:'passkey_added', passkeyId }`; from a setup session also activates the account and sets a full-session cookie; errors `400 invalid_payload | invalid_name | ceremony_expired | passkey_rejected`, `409 passkey_exists`
  - test helper `signUpAndRegister(app, client, { email, credentialId }) -> user row`

- [ ] **Step 1: Write the failing tests**

Append to `account-service/tests/helpers.mjs`:

```js
export async function signUpAndRegister(app, client, { email = 'ada@example.com', credentialId = 'cred-ada' } = {}) {
  const before = app.mailer.sent.length;
  const signup = await client.call('POST', '/v1/signup', { email, displayName: 'Ada', language: 'en', timeZone: 'Asia/Tokyo' });
  if (signup.status !== 202) throw new Error(`signup ${signup.status}`);
  const token = linkToken(await waitForMail(app.mailer, before + 1));
  await client.call('POST', '/v1/signup/verify', { token });
  const opts = await client.call('POST', '/v1/passkeys/options', {});
  const done = await client.call('POST', '/v1/passkeys/verify', {
    ceremonyId: opts.body.ceremonyId,
    response: { id: credentialId, challenge: opts.body.options.challenge },
    name: 'Test key',
  });
  if (done.status !== 201) throw new Error(`passkey ${done.status} ${JSON.stringify(done.body)}`);
  return app.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
```

`account-service/tests/passkeys.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, waitForMail, linkToken, signUpAndRegister, ORIGIN } from './helpers.mjs';

async function verifiedSetupClient(app, email = 'ada@example.com') {
  const c = app.client();
  await c.call('POST', '/v1/signup', { email, displayName: 'Ada' });
  await c.call('POST', '/v1/signup/verify', { token: linkToken(await waitForMail(app.mailer, 1)) });
  return c;
}

test('registration options: resident key and user verification required, random user id, no attestation', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await verifiedSetupClient(app);
  const res = await c.call('POST', '/v1/passkeys/options', {});
  assert.equal(res.status, 200);
  assert.match(res.body.ceremonyId, /^[A-Za-z0-9_-]{22}$/);
  const [, opts] = app.webauthn.calls.find(([name]) => name === 'generateRegistrationOptions');
  assert.equal(opts.rpID, 'localhost');
  assert.equal(opts.attestationType, 'none');
  assert.deepEqual(opts.authenticatorSelection, { residentKey: 'required', userVerification: 'required' });
  assert.equal(opts.userID.length, 32);
  assert.notEqual(Buffer.from(opts.userID).toString(), 'ada@example.com');
});

test('verify from a setup session activates the account and swaps in a full session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await verifiedSetupClient(app);
  const setupCookie = c.cookie;
  const opts = await c.call('POST', '/v1/passkeys/options', {});
  const res = await c.call('POST', '/v1/passkeys/verify', {
    ceremonyId: opts.body.ceremonyId,
    response: { id: 'cred-1', challenge: opts.body.options.challenge },
    name: 'MacBook',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { status: 'passkey_added', passkeyId: 'cred-1' });
  assert.notEqual(c.cookie, setupCookie);
  assert.equal(app.db.prepare('SELECT status FROM users').pluck().get(), 'active');
  const pk = app.db.prepare('SELECT * FROM passkeys').get();
  assert.equal(pk.name, 'MacBook');
  assert.equal(pk.counter, 0);
  const [, args] = app.webauthn.calls.find(([name]) => name === 'verifyRegistrationResponse');
  assert.equal(args.expectedOrigin, ORIGIN);
  assert.equal(args.expectedRPID, 'localhost');
  assert.equal(args.requireUserVerification, true);
  const sessions = app.db.prepare('SELECT scope, revoked_at FROM sessions ORDER BY created_at, scope').all();
  assert.equal(sessions.find((s) => s.scope === 'setup').revoked_at !== null, true);
  assert.equal(sessions.find((s) => s.scope === 'full').revoked_at, null);
});

test('wrong challenge, reused ceremony, no session and duplicate credentials are refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  assert.deepEqual((await app.client().call('POST', '/v1/passkeys/options', {})).body, { error: 'unauthenticated' });

  const c = await verifiedSetupClient(app);
  const opts = await c.call('POST', '/v1/passkeys/options', {});
  const bad = await c.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-1', challenge: 'other' } });
  assert.deepEqual(bad.body, { error: 'passkey_rejected' });
  const reused = await c.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-1', challenge: opts.body.options.challenge } });
  assert.deepEqual(reused.body, { error: 'ceremony_expired' });
  assert.deepEqual((await c.call('POST', '/v1/passkeys/verify', { ceremonyId: 'x', response: 'nope' })).body, { error: 'invalid_payload' });

  const other = app.client();
  await signUpAndRegister(app, other, { email: 'bob@example.com', credentialId: 'cred-bob' });
  const again = await c.call('POST', '/v1/passkeys/options', {});
  const dup = await c.call('POST', '/v1/passkeys/verify', { ceremonyId: again.body.ceremonyId, response: { id: 'cred-bob', challenge: again.body.options.challenge } });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body, { error: 'passkey_exists' });
});

test('adding a second passkey needs a fresh session and mails the user', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  await signUpAndRegister(app, c);
  const mailsBefore = app.mailer.sent.length;
  app.clock.advance(6 * 60_000);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/options', {})).body, { error: 'reauth_required' });

  const fresh = app.client();
  const signin = await fresh.call('POST', '/v1/signin/options', {});
  // Sign-in arrives in Task 7; until then this test only checks the reauth refusal above.
  if (signin.status === 404) return;
  await fresh.call('POST', '/v1/signin/verify', { ceremonyId: signin.body.ceremonyId, response: { id: 'cred-ada', challenge: signin.body.options.challenge } });
  const opts = await fresh.call('POST', '/v1/passkeys/options', {});
  const added = await fresh.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-2', challenge: opts.body.options.challenge } });
  assert.equal(added.status, 201);
  const mail = await waitForMail(app.mailer, mailsBefore + 1);
  assert.equal(mail.subject, 'A passkey was added to your LLM-IDE account');
  assert.match(mail.text, /^A new passkey was added to your account\./);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/passkeys.test.mjs`
Expected: FAIL: `/v1/passkeys/options` answers `404 not_found`.

- [ ] **Step 3: Implement**

`account-service/src/webauthn.mjs`:

```js
// The only WebAuthn implementation in the service. Never parse or verify WebAuthn data by hand.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

export const simpleWebAuthn = Object.freeze({
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
});
```

`account-service/src/ceremonies.mjs`:

```js
import { newId } from './db.mjs';

export const CEREMONY_TTL_MS = 5 * 60_000;

export function createCeremonies(db, now) {
  const insert = db.prepare('INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)');
  const take = db.prepare('DELETE FROM webauthn_challenges WHERE id = ? AND purpose = ? RETURNING challenge, user_id, expires_at');
  return {
    save(purpose, challenge, userId = null) {
      const id = newId();
      insert.run(id, challenge, purpose, userId, now() + CEREMONY_TTL_MS);
      return id;
    },
    take(id, purpose) {
      if (typeof id !== 'string' || id.length > 64) return null;
      const row = take.get(id, purpose); // deleted on first use, valid or not
      return row && row.expires_at > now() ? row : null;
    },
  };
}
```

`account-service/src/routes/passkeys.mjs`:

```js
import { HttpError, readJson, send } from '../http.mjs';
import { passkeyAddedMail } from '../mail-templates.mjs';
import { getUser } from '../users.mjs';

function requirePasskeySession(req, ctx) {
  const session = ctx.sessions.require(req, ['setup', 'full']);
  if (session.scope === 'full') ctx.sessions.requireFresh(session);
  return session;
}

function passkeyName(value) {
  if (value === undefined) return 'Passkey';
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 60 || /\p{Cc}/u.test(value)) {
    throw new HttpError(400, 'invalid_name');
  }
  return value.trim();
}

export function passkeyRoutes(routes, ctx) {
  routes.set('POST /v1/passkeys/options', async (req, res) => {
    const session = requirePasskeySession(req, ctx);
    await readJson(req);
    const user = getUser(ctx.db, session.user_id);
    const existing = ctx.db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id);
    const options = await ctx.webauthn.generateRegistrationOptions({
      rpName: ctx.config.rpName,
      rpID: ctx.config.rpId,
      userName: user.email,
      userDisplayName: user.display_name,
      userID: user.webauthn_user_id,
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    send(res, 200, { ceremonyId: ctx.ceremonies.save('register', options.challenge, user.id), options });
  });

  routes.set('POST /v1/passkeys/verify', async (req, res) => {
    const session = requirePasskeySession(req, ctx);
    const body = await readJson(req, 64 * 1024);
    const response = body.response;
    if (!response || typeof response !== 'object' || typeof response.id !== 'string' || response.id.length > 1024) {
      throw new HttpError(400, 'invalid_payload');
    }
    const name = passkeyName(body.name);
    const ceremony = ctx.ceremonies.take(body.ceremonyId, 'register');
    if (!ceremony || ceremony.user_id !== session.user_id) throw new HttpError(400, 'ceremony_expired');

    let result = null;
    try {
      result = await ctx.webauthn.verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ctx.config.origin,
        expectedRPID: ctx.config.rpId,
        requireUserVerification: true,
      });
    } catch {
      result = null;
    }
    if (!result?.verified) throw new HttpError(400, 'passkey_rejected');

    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const user = getUser(ctx.db, session.user_id);
    const t = ctx.now();
    const viaRecovery = session.via === 'recovery';
    try {
      ctx.db.transaction(() => {
        ctx.db.prepare(
          `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(credential.id, user.id, Buffer.from(credential.publicKey), credential.counter,
          JSON.stringify(credential.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0, name, t);
        if (session.scope === 'setup') {
          ctx.db.prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?").run(t, user.id);
          if (viaRecovery) {
            ctx.db.prepare('UPDATE users SET recovered_at = ? WHERE id = ?').run(t, user.id);
            ctx.sessions.revokeOthers(user.id, null); // every session, this setup session included
          }
          ctx.sessions.revoke(session.id_hash);
        }
      })();
    } catch (err) {
      if (String(err?.code).startsWith('SQLITE_CONSTRAINT')) throw new HttpError(409, 'passkey_exists');
      throw err;
    }

    ctx.audit('passkey_added', { userId: user.id, ip: req.clientIp, detail: { passkeyId: credential.id, via: session.via } });
    const headers = {};
    if (session.scope === 'setup') {
      headers['set-cookie'] = ctx.sessions.create({ userId: user.id, scope: 'full', via: 'passkey', ip: req.clientIp }).cookie;
    }
    if (viaRecovery || session.scope === 'full') ctx.mail(passkeyAddedMail(ctx.config, user.email, { viaRecovery }));
    send(res, 201, { status: 'passkey_added', passkeyId: credential.id }, headers);
  });
}
```

`account-service/src/server.mjs`: add the imports

```js
import { createCeremonies } from './ceremonies.mjs';
import { passkeyRoutes } from './routes/passkeys.mjs';
```

after `  ctx.sessions = createSessions(db, config, now);` add:

```js
  ctx.ceremonies = createCeremonies(db, now);
```

and change the route list to:

```js
const ROUTE_GROUPS = [healthRoutes, signupRoutes, passkeyRoutes];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (4 new tests; the second-passkey test stops after the reauth check until Task 7).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/webauthn.mjs account-service/src/ceremonies.mjs account-service/src/routes/passkeys.mjs account-service/src/server.mjs account-service/tests/helpers.mjs account-service/tests/passkeys.test.mjs
git commit -m "feat(accounts): register passkeys with @simplewebauthn/server"
```

---

### Task 7: Passkey sign-in and sign-out

**Files:**
- Create: `account-service/src/routes/signin.mjs`
- Modify: `account-service/src/server.mjs`, `account-service/tests/passkeys.test.mjs`
- Test: `account-service/tests/signin.test.mjs`

**Interfaces:**
- Consumes: `ctx.ceremonies`, `ctx.webauthn` (Task 6); `ctx.sessions` (Task 4); `getUser`, `publicAccount` (Task 5); `signUpAndRegister` (Task 6).
- Produces:
  - `POST /v1/signin/options {}` -> `200 { ceremonyId, options }` (empty `allowCredentials`, user verification required)
  - `POST /v1/signin/verify { ceremonyId, response }` -> `200 { status:'signed_in', account }` + full-session cookie; any failure `400 signin_failed`
  - `POST /v1/signout {}` -> `204` + cleared cookie

- [ ] **Step 1: Write the failing tests**

`account-service/tests/signin.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUpAndRegister } from './helpers.mjs';

async function signIn(app, client, response) {
  const opts = await client.call('POST', '/v1/signin/options', {});
  return client.call('POST', '/v1/signin/verify', { ceremonyId: opts.body.ceremonyId, response: { challenge: opts.body.options.challenge, ...response } });
}

test('discoverable sign-in: no account named, user verification required, counter stored', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const res = await signIn(app, c, { id: 'cred-ada' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'signed_in');
  assert.equal(res.body.account.email, 'ada@example.com');
  assert.equal(res.body.account.passkeys.length, 1);
  assert.equal(res.body.account.passkeys[0].publicKey, undefined);
  const [, genOpts] = app.webauthn.calls.find(([n]) => n === 'generateAuthenticationOptions');
  assert.deepEqual(genOpts.allowCredentials, []);
  assert.equal(genOpts.userVerification, 'required');
  const [, verOpts] = app.webauthn.calls.find(([n]) => n === 'verifyAuthenticationResponse');
  assert.equal(verOpts.requireUserVerification, true);
  assert.equal(verOpts.credential.id, 'cred-ada');
  const pk = app.db.prepare('SELECT counter, last_used_at FROM passkeys').get();
  assert.equal(pk.counter, 1);
  assert.equal(pk.last_used_at, app.clock.now());
});

test('every failure is the same signin_failed', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const unknown = await signIn(app, c, { id: 'cred-nobody' });
  const badSig = await signIn(app, c, { id: 'cred-ada', bad: true });
  const noCeremony = await c.call('POST', '/v1/signin/verify', { ceremonyId: 'missing', response: { id: 'cred-ada' } });
  for (const r of [unknown, badSig, noCeremony]) {
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'signin_failed' });
  }
  const failures = app.db.prepare("SELECT COUNT(*) FROM audit_events WHERE event = 'signin_failed'").pluck().get();
  assert.equal(failures, 3);
});

test('a ceremony works once', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const opts = await c.call('POST', '/v1/signin/options', {});
  const body = { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-ada', challenge: opts.body.options.challenge } };
  assert.equal((await c.call('POST', '/v1/signin/verify', body)).status, 200);
  assert.equal((await c.call('POST', '/v1/signin/verify', body)).status, 400);
});

test('signing in again rotates the session; sign-out ends it; idle sessions expire', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = app.client();
  await signUpAndRegister(app, c);
  const before = c.cookie;
  await signIn(app, c, { id: 'cred-ada' });
  assert.notEqual(c.cookie, before);
  const active = app.db.prepare("SELECT COUNT(*) FROM sessions WHERE scope = 'full' AND revoked_at IS NULL").pluck().get();
  assert.equal(active, 1);

  const out = await c.call('POST', '/v1/signout', {});
  assert.equal(out.status, 204);
  assert.equal(c.cookie, '');
  assert.equal(app.db.prepare("SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND scope = 'full'").pluck().get(), 0);

  await signIn(app, c, { id: 'cred-ada' });
  app.clock.advance(61 * 60_000);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/options', {})).body, { error: 'unauthenticated' });
});
```

In `account-service/tests/passkeys.test.mjs`, remove the two Task 6 placeholder lines from the last test:

```js
  // Sign-in arrives in Task 7; until then this test only checks the reauth refusal above.
  if (signin.status === 404) return;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && npm test`
Expected: FAIL: `/v1/signin/options` answers `404 not_found` in `signin.test.mjs` and the last `passkeys.test.mjs` test.

- [ ] **Step 3: Implement**

`account-service/src/routes/signin.mjs`:

```js
import { HttpError, readJson, send } from '../http.mjs';
import { getUser, publicAccount } from '../users.mjs';

const MINUTE = 60_000;
const failed = () => new HttpError(400, 'signin_failed');

export function signinRoutes(routes, ctx) {
  routes.set('POST /v1/signin/options', async (req, res) => {
    ctx.limiter.hit(`signin-options-ip:${req.clientIp}`, 30, MINUTE);
    await readJson(req);
    // Discoverable credentials: the request names no account, so it cannot enumerate one.
    const options = await ctx.webauthn.generateAuthenticationOptions({
      rpID: ctx.config.rpId,
      userVerification: 'required',
      allowCredentials: [],
    });
    send(res, 200, { ceremonyId: ctx.ceremonies.save('signin', options.challenge), options });
  });

  routes.set('POST /v1/signin/verify', async (req, res) => {
    ctx.limiter.hit(`signin-verify-ip:${req.clientIp}`, 10, MINUTE);
    const body = await readJson(req, 64 * 1024);
    const ceremony = ctx.ceremonies.take(body.ceremonyId, 'signin');
    const credentialId = body.response?.id;
    const passkey = ceremony && typeof credentialId === 'string' && credentialId.length <= 1024
      ? ctx.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(credentialId)
      : undefined;
    const user = passkey ? getUser(ctx.db, passkey.user_id) : null;
    if (!ceremony || !user || user.status !== 'active') {
      ctx.audit('signin_failed', { ip: req.clientIp });
      throw failed();
    }

    let result = null;
    try {
      result = await ctx.webauthn.verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ctx.config.origin,
        expectedRPID: ctx.config.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: passkey.counter,
          transports: JSON.parse(passkey.transports),
        },
      });
    } catch {
      result = null;
    }
    if (!result?.verified) {
      ctx.audit('signin_failed', { userId: user.id, ip: req.clientIp });
      throw failed();
    }

    ctx.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(result.authenticationInfo.newCounter, ctx.now(), passkey.id);
    const previous = ctx.sessions.read(req);
    if (previous) ctx.sessions.revoke(previous.id_hash);
    const { cookie } = ctx.sessions.create({ userId: user.id, scope: 'full', via: 'passkey', ip: req.clientIp });
    ctx.audit('signin', { userId: user.id, ip: req.clientIp, detail: { passkeyId: passkey.id } });
    send(res, 200, { status: 'signed_in', account: publicAccount(ctx.db, user) }, { 'set-cookie': cookie });
  });

  routes.set('POST /v1/signout', async (req, res) => {
    await readJson(req);
    const session = ctx.sessions.read(req);
    if (session) {
      ctx.sessions.revoke(session.id_hash);
      ctx.audit('signout', { userId: session.user_id, ip: req.clientIp });
    }
    send(res, 204, undefined, { 'set-cookie': ctx.sessions.clearCookie() });
  });
}
```

`account-service/src/server.mjs`: add `import { signinRoutes } from './routes/signin.mjs';` and change the route list to:

```js
const ROUTE_GROUPS = [healthRoutes, signupRoutes, passkeyRoutes, signinRoutes];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (4 new tests, and the full second-passkey test in `passkeys.test.mjs`).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/routes/signin.mjs account-service/src/server.mjs account-service/tests/signin.test.mjs account-service/tests/passkeys.test.mjs
git commit -m "feat(accounts): add discoverable passkey sign-in and sign-out"
```

---

### Task 8: Lost-passkey email flow

**Files:**
- Create: `account-service/src/routes/recovery.mjs`
- Modify: `account-service/src/server.mjs`
- Test: `account-service/tests/recovery.test.mjs`

**Interfaces:**
- Consumes: `ctx.tokens`, `ctx.mail`, `recoveryMail` (Task 3); `limitMailTo`, `HOUR` (Task 2); `normalizeEmail` (Task 5); `getUserByEmail` (Task 5); the setup-session branch of `POST /v1/passkeys/verify` with `via = 'recovery'` (Task 6).
- Produces:
  - `POST /v1/recovery { email }` -> always `202 { status:'check_email' }`
  - `POST /v1/recovery/verify { token }` -> `200 { status:'add_passkey' }` + setup cookie (`via = recovery`) | `400 invalid_or_expired_link`
  - after a passkey is added through it: every other session revoked, `users.recovered_at` set, notice mailed

- [ ] **Step 1: Write the failing tests**

`account-service/tests/recovery.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUpAndRegister, waitForMail, linkToken } from './helpers.mjs';

test('no enumeration: known and unknown addresses get the same answer; only known gets mail', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const sentBefore = app.mailer.sent.length;
  const known = await app.client().call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const unknown = await app.client().call('POST', '/v1/recovery', { email: 'nobody@example.com' });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(known.body, unknown.body);
  const mail = await waitForMail(app.mailer, sentBefore + 1);
  assert.equal(mail.to, 'ada@example.com');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.mailer.sent.length, sentBefore + 1);
});

test('adding a passkey through the link signs out everything else and mails the user', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const oldDevice = app.client();
  await signUpAndRegister(app, oldDevice);
  app.clock.advance(60_000);

  const phone = app.client();
  const sentBefore = app.mailer.sent.length;
  await phone.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const token = linkToken(await waitForMail(app.mailer, sentBefore + 1));
  const verified = await phone.call('POST', '/v1/recovery/verify', { token });
  assert.deepEqual(verified.body, { status: 'add_passkey' });

  const opts = await phone.call('POST', '/v1/passkeys/options', {});
  const added = await phone.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-new', challenge: opts.body.options.challenge } });
  assert.equal(added.status, 201);

  // Still inside its fresh window, so only revocation explains the refusal.
  assert.deepEqual((await oldDevice.call('POST', '/v1/passkeys/options', {})).body, { error: 'unauthenticated' });
  const live = app.db.prepare('SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL').pluck().get();
  assert.equal(live, 1); // only the phone's new full session
  assert.equal(app.db.prepare('SELECT recovered_at FROM users').pluck().get(), app.clock.now());
  const notice = await waitForMail(app.mailer, sentBefore + 2);
  assert.match(notice.text, /through an email link, and every other session was signed out/);
});

test('a recovery link is not a sign-up link, works once, and unknown tokens fail', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const before = app.mailer.sent.length;
  await c.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const token = linkToken(await waitForMail(app.mailer, before + 1));
  assert.equal((await c.call('POST', '/v1/signup/verify', { token })).status, 400);
  assert.equal((await c.call('POST', '/v1/recovery/verify', { token })).status, 200);
  assert.deepEqual((await c.call('POST', '/v1/recovery/verify', { token })).body, { error: 'invalid_or_expired_link' });
  assert.equal((await c.call('POST', '/v1/recovery/verify', { token: 'A'.repeat(43) })).status, 400);
});

test('recovery verify issues a setup-scope session marked via recovery', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  const c = app.client();
  const before = app.mailer.sent.length;
  await c.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  await c.call('POST', '/v1/recovery/verify', { token: linkToken(await waitForMail(app.mailer, before + 1)) });
  const session = app.db.prepare("SELECT scope, via FROM sessions WHERE via = 'recovery'").get();
  assert.deepEqual({ ...session }, { scope: 'setup', via: 'recovery' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/recovery.test.mjs`
Expected: FAIL: `/v1/recovery` answers `404 not_found`.

- [ ] **Step 3: Implement**

`account-service/src/routes/recovery.mjs`:

```js
import { HttpError, readJson, send } from '../http.mjs';
import { recoveryMail } from '../mail-templates.mjs';
import { HOUR, limitMailTo } from '../rate-limit.mjs';
import { getUserByEmail } from '../users.mjs';
import { normalizeEmail, onlyKeys } from '../validate.mjs';

export function recoveryRoutes(routes, ctx) {
  routes.set('POST /v1/recovery', async (req, res) => {
    ctx.limiter.hit(`recovery-ip:${req.clientIp}`, 10, HOUR);
    const body = await readJson(req);
    onlyKeys(body, ['email']);
    const email = normalizeEmail(body.email);
    limitMailTo(ctx.limiter, email);
    const user = getUserByEmail(ctx.db, email);
    if (user) ctx.mail(recoveryMail(ctx.config, email, ctx.tokens.issue('recovery', email)));
    ctx.audit('recovery_requested', { userId: user?.id ?? null, ip: req.clientIp });
    send(res, 202, { status: 'check_email' });
  });

  routes.set('POST /v1/recovery/verify', async (req, res) => {
    ctx.limiter.hit(`verify-ip:${req.clientIp}`, 20, HOUR);
    const body = await readJson(req);
    const found = ctx.tokens.consume('recovery', body.token);
    const user = found ? getUserByEmail(ctx.db, found.email) : null;
    if (!user) throw new HttpError(400, 'invalid_or_expired_link');
    // A setup session may only register a passkey; nothing is revoked until one is added.
    const { cookie } = ctx.sessions.create({ userId: user.id, scope: 'setup', via: 'recovery', ip: req.clientIp });
    ctx.audit('recovery_verified', { userId: user.id, ip: req.clientIp });
    send(res, 200, { status: 'add_passkey' }, { 'set-cookie': cookie });
  });
}
```

`account-service/src/server.mjs`: add `import { recoveryRoutes } from './routes/recovery.mjs';` and change the route list to:

```js
const ROUTE_GROUPS = [healthRoutes, signupRoutes, passkeyRoutes, signinRoutes, recoveryRoutes];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/routes/recovery.mjs account-service/src/server.mjs account-service/tests/recovery.test.mjs
git commit -m "feat(accounts): add the lost-passkey email flow"
```

---

### Task 9: Profile, passkey removal, sign out others, export and delete

**Files:**
- Create: `account-service/src/routes/account.mjs`
- Modify: `account-service/src/server.mjs`
- Test: `account-service/tests/account.test.mjs`

**Interfaces:**
- Consumes: `ctx.sessions.require/requireFresh/revokeOthers/clearCookie` (Task 4); `getUser`, `publicAccount`, validators and `onlyKeys` (Task 5); `ctx.mail`, `passkeyRemovedMail`, `accountDeletedMail` (Task 3).
- Produces:
  - `GET /v1/account` -> `200 publicAccount`
  - `PATCH /v1/account { displayName?, language?, timeZone? }` -> `200 publicAccount`
  - `POST /v1/passkeys/remove { id }` (fresh) -> `200 { status:'passkey_removed' }` | `404 not_found` | `409 last_passkey`
  - `POST /v1/sessions/revoke-others {}` -> `200 { revoked: number }`
  - `GET /v1/account/export` -> `200 { exportedAt, account, sessions, auditEvents }` as an attachment
  - `POST /v1/account/delete { confirmEmail }` (fresh) -> `200 { status:'deleted' }` + cleared cookie | `400 confirm_mismatch`

- [ ] **Step 1: Write the failing tests**

`account-service/tests/account.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUpAndRegister, waitForMail } from './helpers.mjs';

async function signedIn(app) {
  const c = app.client();
  await signUpAndRegister(app, c);
  return c;
}

async function addPasskey(c, id) {
  const opts = await c.call('POST', '/v1/passkeys/options', {});
  return c.call('POST', '/v1/passkeys/verify', { ceremonyId: opts.body.ceremonyId, response: { id, challenge: opts.body.options.challenge } });
}

test('read and update the profile; unknown fields and bad values are refused', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const me = await c.call('GET', '/v1/account');
  assert.equal(me.status, 200);
  assert.equal(me.body.displayName, 'Ada');
  const updated = await c.call('PATCH', '/v1/account', { displayName: 'Ada L.', language: 'ja', timeZone: 'Europe/London' });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.body.displayName, updated.body.language, updated.body.timeZone], ['Ada L.', 'ja', 'Europe/London']);
  assert.deepEqual((await c.call('PATCH', '/v1/account', { email: 'x@example.com' })).body, { error: 'invalid_payload' });
  assert.deepEqual((await c.call('PATCH', '/v1/account', { timeZone: 'Nope/Nope' })).body, { error: 'invalid_time_zone' });
  assert.equal((await c.call('PATCH', '/v1/account', { displayName: 'X' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.client().call('GET', '/v1/account')).status, 401);
});

test('remove a passkey: fresh check, never the last one, mail on removal', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/remove', { id: 'cred-ada' })).body, { error: 'last_passkey' });
  assert.equal((await addPasskey(c, 'cred-2')).status, 201);
  assert.equal((await c.call('POST', '/v1/passkeys/remove', { id: 'cred-nope' })).status, 404);
  const before = app.mailer.sent.length;
  const removed = await c.call('POST', '/v1/passkeys/remove', { id: 'cred-2' });
  assert.deepEqual(removed.body, { status: 'passkey_removed' });
  assert.equal((await waitForMail(app.mailer, before + 1)).subject, 'A passkey was removed from your LLM-IDE account');
  app.clock.advance(6 * 60_000);
  assert.deepEqual((await c.call('POST', '/v1/passkeys/remove', { id: 'cred-ada' })).body, { error: 'reauth_required' });
});

test('sign out every other session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const other = app.client();
  const opts = await other.call('POST', '/v1/signin/options', {});
  await other.call('POST', '/v1/signin/verify', { ceremonyId: opts.body.ceremonyId, response: { id: 'cred-ada', challenge: opts.body.options.challenge } });
  assert.deepEqual((await c.call('POST', '/v1/sessions/revoke-others', {})).body, { revoked: 1 });
  assert.equal((await other.call('GET', '/v1/account')).status, 401);
  assert.equal((await c.call('GET', '/v1/account')).status, 200);
});

test('export returns everything held about the account', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const res = await c.call('GET', '/v1/account/export');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /attachment; filename="llm-ide-account.json"/);
  assert.equal(res.body.account.email, 'ada@example.com');
  assert.ok(res.body.sessions.length >= 1);
  assert.equal(res.body.sessions[0].id_hash, undefined);
  assert.ok(res.body.auditEvents.some((e) => e.event === 'passkey_added'));
});

test('delete: fresh check and email confirmation, then everything but the audit trail is gone', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const c = await signedIn(app);
  const userId = app.db.prepare('SELECT id FROM users').pluck().get();
  assert.deepEqual((await c.call('POST', '/v1/account/delete', { confirmEmail: 'other@example.com' })).body, { error: 'confirm_mismatch' });
  const before = app.mailer.sent.length;
  const res = await c.call('POST', '/v1/account/delete', { confirmEmail: 'Ada@Example.com' });
  assert.deepEqual(res.body, { status: 'deleted' });
  assert.equal(c.cookie, '');
  for (const table of ['users', 'passkeys', 'sessions', 'email_tokens', 'webauthn_challenges']) {
    assert.equal(app.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
  }
  assert.equal(app.db.prepare("SELECT user_id FROM audit_events WHERE event = 'account_deleted'").pluck().get(), userId);
  assert.equal((await waitForMail(app.mailer, before + 1)).subject, 'Your LLM-IDE account was deleted');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/account.test.mjs`
Expected: FAIL: `/v1/account` answers `404 not_found`.

- [ ] **Step 3: Implement**

`account-service/src/routes/account.mjs`:

```js
import { HttpError, readJson, send } from '../http.mjs';
import { accountDeletedMail, passkeyRemovedMail } from '../mail-templates.mjs';
import { getUser, publicAccount } from '../users.mjs';
import { displayName, language, onlyKeys, timeZone } from '../validate.mjs';

const PROFILE_FIELDS = ['displayName', 'language', 'timeZone'];

export function accountRoutes(routes, ctx) {
  routes.set('GET /v1/account', async (req, res) => {
    const session = ctx.sessions.require(req);
    send(res, 200, publicAccount(ctx.db, getUser(ctx.db, session.user_id)));
  });

  routes.set('PATCH /v1/account', async (req, res) => {
    const session = ctx.sessions.require(req);
    const body = await readJson(req);
    onlyKeys(body, PROFILE_FIELDS);
    const user = getUser(ctx.db, session.user_id);
    const next = {
      displayName: body.displayName === undefined ? user.display_name : displayName(body.displayName),
      language: body.language === undefined ? user.language : language(body.language),
      timeZone: body.timeZone === undefined ? user.time_zone : timeZone(body.timeZone),
    };
    ctx.db.prepare('UPDATE users SET display_name = ?, language = ?, time_zone = ?, updated_at = ? WHERE id = ?')
      .run(next.displayName, next.language, next.timeZone, ctx.now(), user.id);
    ctx.audit('profile_updated', { userId: user.id, ip: req.clientIp, detail: { fields: Object.keys(body) } });
    send(res, 200, publicAccount(ctx.db, getUser(ctx.db, user.id)));
  });

  routes.set('POST /v1/passkeys/remove', async (req, res) => {
    const session = ctx.sessions.require(req);
    ctx.sessions.requireFresh(session);
    const body = await readJson(req);
    onlyKeys(body, ['id']);
    const user = getUser(ctx.db, session.user_id);
    ctx.db.transaction(() => {
      const owned = typeof body.id === 'string' && ctx.db.prepare('SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?').get(body.id, user.id);
      if (!owned) throw new HttpError(404, 'not_found');
      const count = ctx.db.prepare('SELECT COUNT(*) FROM passkeys WHERE user_id = ?').pluck().get(user.id);
      if (count <= 1) throw new HttpError(409, 'last_passkey'); // passkey-only accounts must keep one
      ctx.db.prepare('DELETE FROM passkeys WHERE id = ?').run(body.id);
    })();
    ctx.audit('passkey_removed', { userId: user.id, ip: req.clientIp, detail: { passkeyId: body.id } });
    ctx.mail(passkeyRemovedMail(ctx.config, user.email));
    send(res, 200, { status: 'passkey_removed' });
  });

  routes.set('POST /v1/sessions/revoke-others', async (req, res) => {
    const session = ctx.sessions.require(req);
    await readJson(req);
    const revoked = ctx.sessions.revokeOthers(session.user_id, session.id_hash);
    ctx.audit('sessions_revoked', { userId: session.user_id, ip: req.clientIp, detail: { revoked } });
    send(res, 200, { revoked });
  });

  routes.set('GET /v1/account/export', async (req, res) => {
    const session = ctx.sessions.require(req);
    const user = getUser(ctx.db, session.user_id);
    const sessions = ctx.db
      .prepare('SELECT scope, via, created_at, last_seen_at, expires_at, revoked_at, ip FROM sessions WHERE user_id = ? ORDER BY created_at')
      .all(user.id);
    const auditEvents = ctx.db
      .prepare('SELECT at, event, ip, detail FROM audit_events WHERE user_id = ? ORDER BY id')
      .all(user.id)
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) }));
    ctx.audit('account_exported', { userId: user.id, ip: req.clientIp });
    send(res, 200, { exportedAt: ctx.now(), account: publicAccount(ctx.db, user), sessions, auditEvents }, {
      'content-disposition': 'attachment; filename="llm-ide-account.json"',
    });
  });

  routes.set('POST /v1/account/delete', async (req, res) => {
    const session = ctx.sessions.require(req);
    ctx.sessions.requireFresh(session);
    const body = await readJson(req);
    onlyKeys(body, ['confirmEmail']);
    const user = getUser(ctx.db, session.user_id);
    if (typeof body.confirmEmail !== 'string' || body.confirmEmail.trim().toLowerCase() !== user.email) {
      throw new HttpError(400, 'confirm_mismatch');
    }
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM email_tokens WHERE email = ?').run(user.email);
      ctx.db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // cascades passkeys, sessions, challenges
    })();
    ctx.audit('account_deleted', { userId: user.id, ip: req.clientIp });
    ctx.mail(accountDeletedMail(ctx.config, user.email));
    send(res, 200, { status: 'deleted' }, { 'set-cookie': ctx.sessions.clearCookie() });
  });
}
```

`account-service/src/server.mjs`: add `import { accountRoutes } from './routes/account.mjs';` and change the route list to:

```js
const ROUTE_GROUPS = [healthRoutes, signupRoutes, passkeyRoutes, signinRoutes, recoveryRoutes, accountRoutes];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test`
Expected: PASS (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add account-service/src/routes/account.mjs account-service/src/server.mjs account-service/tests/account.test.mjs
git commit -m "feat(accounts): add profile, passkey removal, export and account deletion"
```

---

### Task 10: Retention, token blindness, process entry

**Files:**
- Create: `account-service/src/retention.mjs`, `account-service/bin/account-service.mjs`
- Test: `account-service/tests/retention.test.mjs`, `account-service/tests/blindness.test.mjs`, `account-service/tests/bin.test.mjs`

**Interfaces:**
- Consumes: every table (Task 1); `createApp`, `createMailer`, `simpleWebAuthn`, `loadConfig`, `openDb` (Tasks 1, 3, 6); test helpers.
- Produces:
  - `purge(db, now)`: deletes expired email tokens, challenges and sessions (revoked ones after 1 day), pending accounts older than 24 h, audit rows older than 400 days; nulls IPs older than 72 h; constants `IP_RETENTION_MS`, `PENDING_ACCOUNT_MS`, `AUDIT_RETENTION_MS`
  - `node bin/account-service.mjs`: prints one JSON line `{"level":"info","msg":"listening","host":…,"port":…,"signupOpen":…}`, purges at boot and every 10 minutes, exits cleanly on SIGTERM/SIGINT

- [ ] **Step 1: Write the failing tests**

`account-service/tests/retention.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purge, IP_RETENTION_MS, PENDING_ACCOUNT_MS } from '../src/retention.mjs';
import { startApp, signUpAndRegister } from './helpers.mjs';

test('IPs are nulled after 72 hours; rows stay', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  purge(app.db, app.clock.now);
  assert.ok(app.db.prepare('SELECT COUNT(*) FROM audit_events WHERE ip IS NOT NULL').pluck().get() > 0);
  app.clock.advance(IP_RETENTION_MS + 1);
  purge(app.db, app.clock.now);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM audit_events WHERE ip IS NOT NULL').pluck().get(), 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM sessions WHERE ip IS NOT NULL').pluck().get(), 0);
  assert.ok(app.db.prepare('SELECT COUNT(*) FROM audit_events').pluck().get() > 0);
});

test('unfinished accounts go after 24 hours; active ones stay; expired tokens and sessions go', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await signUpAndRegister(app, app.client());
  app.db.prepare(
    `INSERT INTO users (id, email, display_name, language, time_zone, status, webauthn_user_id, created_at, updated_at)
     VALUES ('pending', 'p@example.com', 'P', 'en', 'UTC', 'pending_passkey', randomblob(32), ?, ?)`,
  ).run(app.clock.now(), app.clock.now());
  app.clock.advance(PENDING_ACCOUNT_MS + 1);
  purge(app.db, app.clock.now);
  const emails = app.db.prepare('SELECT email FROM users ORDER BY email').pluck().all();
  assert.deepEqual(emails, ['ada@example.com']);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM email_tokens').pluck().get(), 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 0); // 12 h absolute expiry passed
});
```

`account-service/tests/blindness.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUpAndRegister, waitForMail, linkToken } from './helpers.mjs';

// No token, cookie or link fragment issued during a full scenario may appear in the database.
test('the database never holds a token in clear', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const secrets = [];
  const web = app.client();
  await signUpAndRegister(app, web);
  secrets.push(linkToken(app.mailer.sent[0]), web.cookie.split('=')[1]);

  const phone = app.client();
  const before = app.mailer.sent.length;
  await phone.call('POST', '/v1/recovery', { email: 'ada@example.com' });
  const token = linkToken(await waitForMail(app.mailer, before + 1));
  secrets.push(token);
  await phone.call('POST', '/v1/recovery/verify', { token });
  secrets.push(phone.cookie.split('=')[1]);

  const tables = app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
  const dump = tables.map((name) => JSON.stringify(app.db.prepare(`SELECT * FROM ${name}`).all())).join('\n');
  for (const secret of secrets) {
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(dump.includes(secret), false, `secret found in the database: ${secret.slice(0, 6)}…`);
  }
  assert.equal(dump.includes('token='), false);
});
```

`account-service/tests/bin.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from './helpers.mjs';

test('the process entry starts, answers /health and exits on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'accounts-bin-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/account-service.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, ACCOUNTS_PORT: '0', ACCOUNTS_DB_PATH: join(dir, 'accounts.db'), ACCOUNTS_MAIL_DIR: join(dir, 'mail') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = await new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve(JSON.parse(d.toString().split('\n')[0])));
    child.once('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  assert.equal(line.msg, 'listening');
  assert.equal(line.host, '127.0.0.1');
  assert.equal(line.signupOpen, false);
  const res = await createClient(`http://127.0.0.1:${line.port}`).call('GET', '/health');
  assert.equal(res.status, 200);
  const code = await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
  assert.equal(code, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd account-service && node --test tests/retention.test.mjs tests/blindness.test.mjs tests/bin.test.mjs`
Expected: FAIL with `Cannot find module '.../src/retention.mjs'` and `.../bin/account-service.mjs`; the blindness test already passes (it guards what Tasks 3 and 4 built).

- [ ] **Step 3: Implement**

`account-service/src/retention.mjs`:

```js
export const IP_RETENTION_MS = 72 * 60 * 60_000; // relay design D5
export const PENDING_ACCOUNT_MS = 24 * 60 * 60_000;
export const REVOKED_SESSION_MS = 24 * 60 * 60_000;
export const AUDIT_RETENTION_MS = 400 * 24 * 60 * 60_000;

export function purge(db, now) {
  const t = now();
  db.transaction(() => {
    db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?').run(t);
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(t);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)').run(t, t - REVOKED_SESSION_MS);
    db.prepare("DELETE FROM users WHERE status = 'pending_passkey' AND created_at <= ?").run(t - PENDING_ACCOUNT_MS);
    db.prepare('UPDATE sessions SET ip = NULL WHERE ip IS NOT NULL AND created_at <= ?').run(t - IP_RETENTION_MS);
    db.prepare('UPDATE audit_events SET ip = NULL WHERE ip IS NOT NULL AND at <= ?').run(t - IP_RETENTION_MS);
    db.prepare('DELETE FROM audit_events WHERE at <= ?').run(t - AUDIT_RETENTION_MS);
  })();
}
```

`account-service/bin/account-service.mjs`:

```js
#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createMailer } from '../src/mailer.mjs';
import { purge } from '../src/retention.mjs';
import { createApp } from '../src/server.mjs';
import { simpleWebAuthn } from '../src/webauthn.mjs';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ config, db, mailer: createMailer(config.mail), webauthn: simpleWebAuthn, now: Date.now });

purge(db, Date.now);
setInterval(() => purge(db, Date.now), 10 * 60_000).unref();

app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', host: config.host, port: app.address().port, signupOpen: config.signupOpen }));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    app.close(() => {
      db.close();
      process.exit(0);
    });
    app.closeAllConnections();
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd account-service && npm test && npm run check:boundary`
Expected: PASS (4 new tests), then `account-service boundary: ok`.

- [ ] **Step 5: Commit**

```bash
git add account-service/src/retention.mjs account-service/bin/account-service.mjs account-service/tests/retention.test.mjs account-service/tests/blindness.test.mjs account-service/tests/bin.test.mjs
git commit -m "feat(accounts): add retention, the token-blindness test and the process entry"
```

---

### Task 11: Deploy note: systemd unit, nginx vhost, VPS runbook

The `/api/` proxy is **already closed** (commit `35d43f2b`: `location /api/ { return 404; }`, `llmide-core` disabled). This task adds the account service next to it, with sign-up closed. The VPS steps are run by the user (`(you)`).

**Files:**
- Create: `deploy/vps/llmide-accounts.service`, `deploy/vps/accounts.llm-ide.com.nginx`
- Modify: `deploy/vps/README.md` (new section before `## Known limits`)

**Interfaces:**
- Consumes: `bin/account-service.mjs` and the `ACCOUNTS_*` variables of `loadConfig` (Tasks 1, 10).
- Produces: a runbook that serves `https://accounts.llm-ide.com/v1/*` and `/health` from `127.0.0.1:3470` as the `llmide-accounts` user.

- [ ] **Step 1: Write the systemd unit**

`deploy/vps/llmide-accounts.service`:

```ini
[Unit]
Description=LLM-IDE account service (identity only: no AI, no user data)
After=network.target

[Service]
Type=simple
User=llmide-accounts
Group=llmide-accounts
WorkingDirectory=/srv/llm-ide/repo/account-service
EnvironmentFile=/etc/llm-ide/accounts.env
ExecStart=/opt/node22/bin/node bin/account-service.mjs
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
SystemCallArchitectures=native
CapabilityBoundingSet=
ReadWritePaths=/var/lib/llmide-accounts

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the nginx vhost**

`deploy/vps/accounts.llm-ide.com.nginx`:

```nginx
# Included inside nginx's http{} block (sites-enabled), so these two directives are valid here.
# Access log without IP addresses, headers, query strings or bodies (relay design 12, D5).
log_format llmide_accounts '$time_iso8601 "$request_method $uri" $status $body_bytes_sent $request_time';
limit_req_zone $binary_remote_addr zone=llmide_accounts:10m rate=10r/s;

server {
    listen 80;
    server_name accounts.llm-ide.com;
    root /var/www/llm-ide-accounts;
    location /.well-known/acme-challenge/ { root /var/www/llm-ide-accounts; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name accounts.llm-ide.com;

    ssl_certificate /etc/letsencrypt/live/accounts.llm-ide.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/accounts.llm-ide.com/privkey.pem;

    access_log /var/log/nginx/llm-ide-accounts.access.log llmide_accounts;

    # Account pages (sub-project 4) are static files here; the API is JSON under /v1/.
    root /var/www/llm-ide-accounts;
    index index.html;

    add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    client_max_body_size 64k;

    location /v1/ {
        limit_req zone=llmide_accounts burst=20 nodelay;
        proxy_pass http://127.0.0.1:3470;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # Overwrites any client value; the service trusts it only from loopback (ACCOUNTS_TRUST_PROXY=1).
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 30s;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3470;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
```

- [ ] **Step 3: Add the runbook section to `deploy/vps/README.md`**

Insert before the line `## Known limits`:

````markdown
## Account service (`accounts.llm-ide.com`)

Public accounts (ADR 0019; design `docs/superpowers/specs/2026-11-05-accounts-and-device-linking-design.md`).
Its own system user, its own database, loopback only, **sign-up closed** until the external review
(sub-project 5). It never runs the core, AI or agents.

| Piece | Location |
|---|---|
| Service | `llmide-accounts.service`, user `llmide-accounts`, `127.0.0.1:3470` |
| Data | `/var/lib/llmide-accounts/accounts.db` |
| Config | `/etc/llm-ide/accounts.env` (`0600`, root-owned; read by systemd) |
| nginx | [accounts.llm-ide.com.nginx](accounts.llm-ide.com.nginx), log without IPs |

```bash
useradd --system --home /var/lib/llmide-accounts --shell /usr/sbin/nologin llmide-accounts
install -d -m 700 -o llmide-accounts -g llmide-accounts /var/lib/llmide-accounts
install -d -m 755 /var/www/llm-ide-accounts
cd /srv/llm-ide/repo && git pull --ff-only
cd account-service && npm ci --omit=dev --no-audit --no-fund
```

`/etc/llm-ide/accounts.env`:

```dotenv
NODE_ENV=production
ACCOUNTS_HOST=127.0.0.1
ACCOUNTS_PORT=3470
ACCOUNTS_ORIGIN=https://accounts.llm-ide.com
ACCOUNTS_TRUST_PROXY=1
ACCOUNTS_DB_PATH=/var/lib/llmide-accounts/accounts.db
ACCOUNTS_MAIL_TRANSPORT=smtp
ACCOUNTS_SMTP_URL=smtps://<user>:<password>@<provider-host>:465
ACCOUNTS_MAIL_FROM=LLM-IDE <no-reply@llm-ide.com>
# Do NOT set ACCOUNTS_SIGNUP_OPEN=1 before sub-project 5 (external review, legal gates).
```

```bash
chmod 600 /etc/llm-ide/accounts.env
cp deploy/vps/llmide-accounts.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now llmide-accounts
certbot certonly --webroot -w /var/www/llm-ide-accounts -d accounts.llm-ide.com
cp deploy/vps/accounts.llm-ide.com.nginx /etc/nginx/sites-available/accounts.llm-ide.com
ln -s /etc/nginx/sites-available/accounts.llm-ide.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

The DNS `A` record for `accounts.llm-ide.com` must point at the VPS before `certbot`. Until the
certificate exists, enable only the port-80 server block.

Verify:

```bash
curl -s https://accounts.llm-ide.com/health
# {"ok":true,"service":"account-service","signupOpen":false}
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://accounts.llm-ide.com' \
  -H 'Content-Type: application/json' -d '{"email":"a@example.com","displayName":"A"}' \
  https://accounts.llm-ide.com/v1/signup
# 403 (signup_closed)
curl -s -o /dev/null -w '%{http_code}\n' https://llm-ide.com/api/health
# 404 (the public core stays closed)
systemctl show llmide-accounts -p User
# User=llmide-accounts
```
````

- [ ] **Step 4: Check the deploy files locally**

Run: `grep -n "ACCOUNTS_SIGNUP_OPEN" deploy/vps/README.md && grep -c "proxy_pass http://127.0.0.1:3470" deploy/vps/accounts.llm-ide.com.nginx && grep -n "location /api/ { return 404; }" deploy/vps/llm-ide.com.nginx`
Expected: the "Do NOT set" line, `2`, and the closed `/api/` line.

On the VPS `(you)`: run the commands of Step 3 and the Verify block. Expected: the outputs shown there.

- [ ] **Step 5: Commit**

```bash
git add deploy/vps/llmide-accounts.service deploy/vps/accounts.llm-ide.com.nginx deploy/vps/README.md
git commit -m "docs(deploy): add the account service unit, vhost and runbook"
```

---

## Self-review

**Spec coverage (sub-project 1 rows of spec section 10):**

| Spec item | Task |
|---|---|
| Skeleton, own SQLite, migrations, config, health | 1 |
| Never imports `extension/`, no AI code, vetted dependencies | 1 (boundary check, CI) |
| Origin/CSRF rules, client IP, rate limits per IP and address, audit log | 2 |
| Email links: 15 min, single use, hash only, fragment, pluggable mailer with a file transport, provider-down retries | 3 |
| Sessions: HttpOnly, Secure, SameSite=Strict, `__Host-`, 1 h idle, 12 h absolute, setup scope, fresh check | 4 |
| Sign-up, no enumeration, sign-up closed by default | 5 |
| Passkey registration (resident key, UV required, attestation none) | 6 |
| Passkey sign-in (discoverable), sign-out, passkey-only after setup | 7 |
| Lost passkey: link, new passkey signs out all other sessions, mail, `recovered_at` | 8 |
| Profile read/update, export, delete (launch gate 2), passkey removal, sign out others | 9 |
| Retention (72 h IPs, 24 h pending, 400-day audit), token blindness, process entry | 10 |
| systemd unprivileged user, nginx route, `/api/` removal (already done, verified) | 11 |
| CI job | 1 |

Not in this plan by design: OAuth + PKCE, devices, linking, replace-desktop hold (sub-project 2); relay (3); account web pages and real-authenticator tests (4); backups, monitoring, commit-pinned CI actions, external review, opening sign-up (5).

**Placeholder scan:** no TBD/TODO; the only conditional code (the Task 6 early return) is removed in Task 7 Step 1 with the exact lines named.

**Type consistency:** `ctx.sessions.require/requireFresh/revoke/revokeOthers/create/clearCookie/read`, `ctx.ceremonies.save/take`, `ctx.tokens.issue/consume`, `ctx.mail`, `ctx.audit`, `ctx.limiter.hit`, `getUser/getUserByEmail/publicAccount`, the fake and real WebAuthn function names, and the `ROUTE_GROUPS` list are spelled the same in every task.
