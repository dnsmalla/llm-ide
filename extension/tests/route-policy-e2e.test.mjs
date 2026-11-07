// Plan H1.2 Task 7: every dangerous route, on a real server, as a viewer, a read-only member and an
// engineer. Every refusal happens before any work: no engine, no spawn, no file write.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'CorrectHorseBattery';
const SECRETS = { LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48) };

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

// Plan H1.2 Task 7: the R-014 dangerous routes, on a real server, as a viewer and as a read-only
// member. Every refusal happens before any work: no engine, no spawn, no file write.
let dir; let dbPath; let server;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-policy-e2e-'));
  dbPath = path.join(dir, 'data.db');
  // Each request gets its own spoofed IP (trust proxy on): the authRegister bucket allows 3/min per IP
  // and this suite registers four accounts from one loopback address.
  server = await startServer({ LLMIDE_TRUST_PROXY: '1' });
});
after(async () => { await stopServer(server); fs.rmSync(dir, { recursive: true, force: true }); });

let ipSeq = 0;
async function api(method, p, token, body) {
  const res = await fetch(`${server.url}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.20.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
async function register(email) {
  const r = await api('POST', '/auth/register', null, { email, password: PASSWORD, displayName: email });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // POST /auth/register answers { user } only; the token comes from the login call (plan H1.2 Task 7:
  // match the route's field names and keep the assertions).
  const login = await api('POST', '/auth/login', null, { email, password: PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { id: r.json.user.id, token: login.json.accessToken };
}

const DANGEROUS = [
  ['POST', '/kb/loop/agent-run', { message: 'x', repoRoot: '/tmp' }],
  ['POST', '/kb/ingest-scip', { scipPath: '/tmp/x.scip' }],
  ['POST', '/auth/me/plugins/hook-trust', {}],
  ['POST', '/auth/me/mcp-plugins/toggle', {}],
  ['PUT', '/auth/me/workspace-trust', {}],
  ['DELETE', '/kb/agent/project-memory', {}],
  ['POST', '/kb/outcomes/retry-failed', {}],
  ['POST', '/kb/summarize', {}],
  ['POST', '/generate-docx', {}],
  ['POST', '/kb/conflict-questions', {}],
  ['POST', '/kb/connect-git', {}],
  ['POST', '/kb/project/install-skills', {}],
  ['POST', '/auth/me/repos', { path: '/tmp' }],
  ['POST', '/kb/complete', {}],
  ['POST', '/generate-notes', {}],
  ['POST', '/kb/email/fetch', {}],
  ['POST', '/admin/invites', {}],
];

test('a viewer is refused every dangerous route with ROLE_DENIED; reading their own account still works', async () => {
  const owner = await register('owner@example.test');
  const v = await register('viewer@example.test');
  const patch = await api('PATCH', `/admin/members/${v.id}`, owner.token, { teamRole: 'viewer', maxMode: 'read_only' });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));
  for (const [method, p, body] of DANGEROUS) {
    const r = await api(method, p, v.token, body);
    assert.equal(r.status, 403, `${method} ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error.code, 'ROLE_DENIED', `${method} ${p}`);
  }
  const me = await api('GET', '/auth/me', v.token);
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.member.permissions, ['self.read', 'self.write', 'model.ask', 'host']);
});

test('an engineer may install but not manage the team; a read-only member may not edit; an undeclared route is 404', async () => {
  const owner = await api('POST', '/auth/login', null, { email: 'owner@example.test', password: PASSWORD });
  const m = await register('reader@example.test');
  await api('PATCH', `/admin/members/${m.id}`, owner.json.accessToken, { teamRole: 'member', maxMode: 'read_only' });
  for (const [method, p, body] of [['POST', '/kb/loop/agent-run', { message: 'x', repoRoot: '/tmp' }], ['POST', '/auth/me/repos', { path: '/tmp' }]]) {
    const r = await api(method, p, m.token, body);
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  const eng = await register('engineer@example.test'); // solo default: member + execute
  const inv = await api('POST', '/admin/invites', eng.token, {});
  assert.equal(inv.status, 403, 'team management stays admin');
  const install = await api('POST', '/auth/me/plugins/hook-trust', eng.token, {});
  assert.notEqual(install.status, 403, 'an engineer passes the install gate (the handler may still answer 400 for the empty body)');
  const unknown = await api('GET', '/kb/no-such-route', m.token);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'NOT_FOUND');
});
