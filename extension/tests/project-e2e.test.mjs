// Project-scoped team roles on a real server (ADR 0021 H1.3, API 126): register a project, see the
// implicit viewer, grant a per-project role, manage members as a project admin, confirm a project row
// never lifts a team viewer, and confirm the team.yaml write-through.
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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...SECRETS, ...extra };
  for (const k of ['NODE_TEST_CONTEXT', 'NODE_ENV', 'LLMIDE_HUB', 'LLMIDE_ALLOW_REMOTE', 'LLMIDE_DISABLE_REGISTRATION', 'LLMIDE_TRUST_PROXY']) delete env[k];
  return { ...env, ...extra };
}

let dir; let dbPath; let server;

async function startServer() {
  const port = await freePort();
  const env = baseEnv({
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: dbPath, LLMIDE_DATA_DIR: dir, LLMIDE_LOG_FILE: 'none',
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
    LLMIDE_TRUST_PROXY: '1',
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

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-e2e-'));
  dbPath = path.join(dir, 'data.db');
  server = await startServer();
});
after(async () => {
  await stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

let ipSeq = 0;
let pid = ''; // R-021 #4: the server-issued project id shared by these tests
async function api(method, p, token, body) {
  const res = await fetch(`${server.url}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.40.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
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
  const login = await api('POST', '/auth/login', null, { email, password: PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { id: r.json.user.id, token: login.json.accessToken, email };
}

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-e2e-folder-')));
  fs.mkdirSync(path.join(root, 'system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'system', 'project.json'), '{}');
  return root;
}

test('the server advertises API 126 or later', async () => {
  const health = await api('GET', '/health');
  assert.equal(health.status, 200);
  assert.ok(health.json.apiVersion >= 126, `apiVersion ${health.json.apiVersion}`);
});

test('register makes the creator the project owner; another engineer is an implicit viewer', async () => {
  const owner = await register('e2e-owner@example.test');
  const engineer = await register('e2e-engineer@example.test');
  const root = makeProject();
  const reg = await api('POST', '/kb/projects/register', owner.token, { id: 'p-e2e', root, name: 'E2E' });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  pid = reg.json.id; // R-021 #4: the server issues the id

  const ownerProjects = await api('GET', '/projects', owner.token);
  assert.equal(ownerProjects.status, 200, JSON.stringify(ownerProjects.json));
  assert.equal(ownerProjects.json.projects.find((p) => p.id === pid).role, 'owner');

  const before = await api('GET', '/projects', engineer.token);
  const row = before.json.projects.find((p) => p.id === pid);
  assert.equal(row.role, 'viewer');
  assert.ok(!row.permissions.includes('model.exec'));
  assert.ok(row.permissions.includes('model.ask'));

  // A non-manager may register their own folder mapping, but never rewrite the project's name/root.
  // R-021 #4: a client id cannot re-claim another root; the server issues a separate project instead.
  const hijack = await api('POST', '/kb/projects/register', engineer.token, { id: pid, root: makeProject(), name: 'Hijack' });
  assert.equal(hijack.status, 200, JSON.stringify(hijack.json));
  assert.notEqual(hijack.json.id, pid);
  const canonical = await api('GET', '/projects/p-e2e', owner.token).catch(() => null);
  assert.ok(canonical === null || canonical.status === 404 || canonical.status === 200, 'no crash on the old path');
});

test('a project owner grants a per-project role; the engineer then becomes the project admin', async () => {
  const owner = (await api('POST', '/auth/login', null, { email: 'e2e-owner@example.test', password: PASSWORD })).json;
  const engineer = (await api('POST', '/auth/login', null, { email: 'e2e-engineer@example.test', password: PASSWORD })).json;
  const list = await api('GET', '/projects', owner.accessToken);
  assert.equal(list.status, 200);
  const engineerId = (await api('GET', '/auth/me', engineer.accessToken)).json.id;

  const denied = await api('PATCH', `/projects/${pid}/members/${engineerId}`, engineer.accessToken, { role: 'admin' });
  assert.equal(denied.status, 403, 'a project viewer cannot grant themselves a role');

  const grant = await api('PATCH', `/projects/${pid}/members/${engineerId}`, owner.accessToken, {
    role: 'admin', maxMode: 'execute', usdCapMonth: 5,
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.json));
  assert.equal(grant.json.member.role, 'admin');
  assert.equal(grant.json.member.usdCapMonth, 5);

  const after = await api('GET', '/projects', engineer.accessToken);
  const row = after.json.projects.find((p) => p.id === pid);
  assert.equal(row.role, 'admin');
  assert.ok(row.permissions.includes('project.admin'));
  assert.ok(row.permissions.includes('model.exec'));
  assert.ok(!row.permissions.includes('admin'), 'project admin is not team admin');

  const members = await api('GET', `/projects/${pid}/members`, engineer.accessToken);
  assert.equal(members.status, 200, JSON.stringify(members.json));
  assert.ok(members.json.members.some((m) => m.userId === engineerId && m.role === 'admin'));
});

test('a project admin adds another member; a project viewer still cannot manage', async () => {
  const owner = (await api('POST', '/auth/login', null, { email: 'e2e-owner@example.test', password: PASSWORD })).json;
  const engineer = (await api('POST', '/auth/login', null, { email: 'e2e-engineer@example.test', password: PASSWORD })).json;
  const outsider = await register('e2e-outsider@example.test');
  const viewer = await register('e2e-viewer@example.test');
  const ownerId = (await api('GET', '/auth/me', owner.accessToken)).json.id;
  // Make the viewer a real TEAM viewer first: a project row must never lift a viewer (H1.2).
  const makeViewer = await api('PATCH', `/admin/members/${viewer.id}`, owner.accessToken, {
    teamRole: 'viewer', maxMode: 'read_only',
  });
  assert.equal(makeViewer.status, 200, JSON.stringify(makeViewer.json));

  const added = await api('POST', `/projects/${pid}/members`, engineer.accessToken, {
    email: outsider.email, role: 'member', maxMode: 'execute', usdCapMonth: 4,
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.member.userId, outsider.id);

  const denied = await api('PATCH', `/projects/${pid}/members/${ownerId}`, outsider.token, { role: 'viewer' });
  assert.equal(denied.status, 403);

  // A project row never lifts a global viewer (H1.2).
  const pretend = await api('PATCH', `/projects/${pid}/members/${viewer.id}`, owner.accessToken, {
    role: 'owner', maxMode: 'execute', usdCapMonth: 0,
  });
  assert.equal(pretend.status, 200, JSON.stringify(pretend.json));
  const viewerRow = (await api('GET', '/projects', viewer.token)).json.projects.find((p) => p.id === pid);
  assert.equal(viewerRow.role, 'viewer');
  assert.equal(viewerRow.maxMode, 'read_only');
  assert.ok(!viewerRow.permissions.includes('model.exec'));

  // A team viewer cannot use project-admin even if a row names them owner.
  const deniedMembers = await api('GET', `/projects/${pid}/members`, viewer.token);
  assert.equal(deniedMembers.status, 403);
});

test('/auth/me carries the project list and the team.yaml projects: section was written through', async () => {
  const owner = (await api('POST', '/auth/login', null, { email: 'e2e-owner@example.test', password: PASSWORD })).json;
  const me = await api('GET', '/auth/me', owner.accessToken);
  assert.equal(me.status, 200);
  assert.ok(Array.isArray(me.json.projects));
  const p = me.json.projects.find((x) => x.id === pid);
  assert.equal(p.role, 'owner');
  assert.ok(p.permissions.includes('admin'), 'a global owner keeps team admin');

  const file = path.join(dir, 'team.yaml');
  assert.ok(fs.existsSync(file), 'team.yaml exists');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /projects:/);
  assert.match(text, new RegExp(`${pid}:`));
  assert.match(text, /e2e-engineer@example\.test:/);
});
