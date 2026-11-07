// Invite-only registration while registration is closed (ADR 0021, plan Task 4). Spawns the real
// server over a temp DB so `config.registrationOpen` / `config.hub` are what production computes from
// the env — the in-process route tests cannot change a frozen config.
//
// Seeding (an owner + invites) runs in a child with the same LLMIDE_DB_PATH before the server boots,
// because this process has already loaded kb/db.mjs against its own fixture DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'CorrectHorseBattery';
const SECRETS = { LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48) };

let dir;
let dbPath;
let server;
let base;
let invites;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Run a module-shaped snippet in a child against this fixture DB; returns its JSON stdout. */
function nodeEval(code, env) {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: EXT, env, encoding: 'utf8',
  });
  assert.equal(out.status, 0, `seed/verify child failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...SECRETS, ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_ENV', 'LLMIDE_HUB', 'LLMIDE_ALLOW_REMOTE', 'LLMIDE_DISABLE_REGISTRATION', 'LLMIDE_TRUST_PROXY']) delete env[k];
  return { ...env, ...extra };
}

async function startServer(extraEnv) {
  const port = await freePort();
  const env = baseEnv({
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: dbPath, LLMIDE_LOG_FILE: 'none',
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
    ...extraEnv,
  });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited during boot:\n${log}`);
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`server did not boot:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, url, log: () => log };
}

async function stopServer(s) {
  if (!s) return;
  s.child.kill('SIGTERM');
  await new Promise((r) => (s.child.exitCode != null ? r() : s.child.once('exit', r)));
}

let ipSeq = 0;
/** One register attempt from its own spoofed IP (the authRegister bucket allows 3/min per IP). */
function register(url, body) {
  return fetch(`${url}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.10.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` },
    body: JSON.stringify(body),
  });
}

async function login(url, email) {
  const r = await fetch(`${url}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const session = JSON.parse(text);
  const me = await fetch(`${url}/auth/me`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(me.status, 200);
  return me.json();
}

const email = (tag) => `invite-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.com`;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-invites-'));
  dbPath = path.join(dir, 'kb.db');
  invites = nodeEval(`
    const { getDb, closeDb } = await import('./kb/db.mjs');
    const { ensureMember, createInvite } = await import('./kb/members.mjs');
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ('owner-1', 'owner@example.com', 'Owner', 'x', 'admin', 'active')").run();
    ensureMember(db, 'owner-1', { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
    const plain = createInvite(db, 'owner-1', {});
    const expired = createInvite(db, 'owner-1', {});
    db.prepare("UPDATE invites SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(expired.id);
    const bound = createInvite(db, 'owner-1', { email: 'Bound@Example.com', teamRole: 'viewer', maxMode: 'none', usdCapMonth: 5 });
    const reuse = createInvite(db, 'owner-1', {});
    process.stdout.write(JSON.stringify({ plain, expired, bound, reuse }));
    closeDb();
  `, baseEnv({ LLMIDE_DB_PATH: dbPath }));

  // Registration CLOSED, trust-proxy on so each attempt gets its own rate-limit bucket.
  server = await startServer({ LLMIDE_DISABLE_REGISTRATION: '1', LLMIDE_TRUST_PROXY: '1' });
  base = server.url;
});

after(async () => {
  await stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('closed registration + a valid invite registers a member with the invite\'s grants', async () => {
  const addr = email('plain');
  const res = await register(base, { email: addr, password: PASSWORD, invite: invites.plain.token });
  assert.equal(res.status, 201, await res.text());
  const me = await login(base, addr);
  assert.deepEqual(me.member, { teamRole: 'member', maxMode: 'read_only', usdCapMonth: 20 });
});

test('the same invite used twice is refused as closed (403 REGISTRATION_CLOSED)', async () => {
  const first = await register(base, { email: email('once'), password: PASSWORD, invite: invites.reuse.token });
  assert.equal(first.status, 201, await first.text());
  const second = await register(base, { email: email('twice'), password: PASSWORD, invite: invites.reuse.token });
  assert.equal(second.status, 403);
  assert.equal((await second.json()).error.code, 'REGISTRATION_CLOSED', 'a used token reads exactly like a closed door');
  // An unknown token reads the same way.
  const bogus = await register(base, { email: email('bogus'), password: PASSWORD, invite: 'not-a-real-token-000000' });
  assert.equal(bogus.status, 403);
  assert.equal((await bogus.json()).error.code, 'REGISTRATION_CLOSED');
});

test('an expired invite is refused as closed', async () => {
  const res = await register(base, { email: email('expired'), password: PASSWORD, invite: invites.expired.token });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'REGISTRATION_CLOSED');
});

test('an email-bound invite refuses another address and accepts the bound one (case-insensitive)', async () => {
  const wrong = await register(base, { email: email('wrong-address'), password: PASSWORD, invite: invites.bound.token });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error.code, 'REGISTRATION_CLOSED');
  // The bound address is still usable: the refused attempt burned nothing.
  const ok = await register(base, { email: 'bound@example.com', password: PASSWORD, invite: invites.bound.token });
  assert.equal(ok.status, 201, await ok.text());
  const me = await login(base, 'bound@example.com');
  assert.deepEqual(me.member, { teamRole: 'viewer', maxMode: 'none', usdCapMonth: 5 });
});

test('a garbage invite on a closed server is refused before the password hash (R-008#1)', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  // One hash at the server's cost (10 in this spawn) is the price this refusal must not pay.
  const t0 = performance.now();
  bcrypt.hashSync(PASSWORD, 10);
  const hashMs = performance.now() - t0;

  const times = [];
  for (let i = 0; i < 4; i += 1) {
    const addr = email(`garbage-${i}`);
    const t = performance.now();
    const res = await register(base, { email: addr, password: PASSWORD, invite: `garbage-token-${i}-000000000000000000` });
    times.push(performance.now() - t);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'REGISTRATION_CLOSED');
    const loginRes = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: addr, password: PASSWORD }),
    });
    assert.equal(loginRes.status, 401, 'no account was created');
  }
  const fastest = Math.min(...times);
  assert.ok(fastest < hashMs, `refused in ${fastest.toFixed(1)}ms, one bcrypt hash costs ${hashMs.toFixed(1)}ms`);
});

test('without an invite, closed registration is refused and no account is created', async () => {
  const addr = email('no-invite');
  const res = await register(base, { email: addr, password: PASSWORD });
  assert.equal(res.status, 403);
  const loginRes = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: addr, password: PASSWORD }),
  });
  assert.equal(loginRes.status, 401, 'the refused registration left no account behind');
});

test('every successful invite registration is audited with the invite id, and the invite is burned once', () => {
  const state = nodeEval(`
    const { getDb, closeDb } = await import('./kb/db.mjs');
    const db = getDb();
    const users = db.prepare("SELECT email FROM users WHERE id != 'legacy' ORDER BY email").all().map((r) => r.email);
    const audits = db.prepare("SELECT detail FROM audit_log WHERE action = 'auth.register' AND outcome = 'success' ORDER BY id").all();
    const burned = db.prepare('SELECT id, used_at, used_by FROM invites WHERE used_at IS NOT NULL').all();
    process.stdout.write(JSON.stringify({ users, audits, burned }));
    closeDb();
  `, baseEnv({ LLMIDE_DB_PATH: dbPath }));

  assert.ok(state.users.includes('owner@example.com'), 'the seeded owner exists');
  assert.equal(state.users.length, 4, 'the owner + exactly the three invited accounts');
  assert.equal(state.burned.length, 3, 'three invites were used');
  for (const row of state.burned) assert.ok(row.used_by, 'used_by is the new account');
  const details = state.audits.map((a) => JSON.parse(a.detail));
  const withInvite = details.filter((d) => d && typeof d.invite === 'string');
  assert.equal(withInvite.length, 3, 'every invite registration carries the invite id');
  assert.deepEqual(withInvite.map((d) => d.invite).sort(),
    [invites.plain.id, invites.bound.id, invites.reuse.id].sort());
  assert.ok(!JSON.stringify(details).includes(PASSWORD), 'never a password');
});

test('hub mode closes registration (LLMIDE_HUB=1) and /auth/well-known says so', async () => {
  const hub = await startServer({ LLMIDE_HUB: '1', LLMIDE_TRUST_PROXY: '1' });
  try {
    const wk = await fetch(`${hub.url}/auth/well-known`);
    assert.equal(wk.status, 200);
    assert.equal((await wk.json()).registrationOpen, false);
    const res = await register(hub.url, { email: email('hub-open'), password: PASSWORD });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'FORBIDDEN');
  } finally {
    await stopServer(hub);
  }
});
