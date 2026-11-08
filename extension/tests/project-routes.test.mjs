// Project list + membership routes (ADR 0021 H1.3). Handler-level: req/res doubles, a scratch DB and a
// scratch team.yaml directory, so the dispatch/JWT/route-policy wiring can land separately.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-project-routes-'));
const tmpDb = path.join(root, 'kb.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { getDb } = await import('../kb/db.mjs');
const { handleProjectRoute, isProjectRoute } = await import('../routes/project-routes.mjs');
const { registerProject, setProjectMember, getProjectMember, effectiveProjectGrant } = await import('../kb/projects.mjs');
const { parseTeamYamlFile } = await import('../kb/team-yaml.mjs');
const { grant } = await import('./helpers/grant.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };
const TEAM_DIR = path.join(root, 'team');
fs.mkdirSync(TEAM_DIR, { recursive: true });

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

let ip = 0;
function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user, headers: {},
    socket: { remoteAddress: `10.30.0.${++ip}` },
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
    end(chunk) { if (chunk) this._body += chunk; },
    json() { return JSON.parse(this._body); },
  };
}

async function call(opts) {
  const res = makeRes();
  const handled = await handleProjectRoute(makeReq(opts), res, {
    db: getDb(), logger: noopLogger, requestId: 'req', dir: TEAM_DIR,
  });
  return { res, handled };
}

let seq = 0;
function user(email, teamRole, maxMode = 'execute', usdCapMonth = 0) {
  const id = `p-${++seq}`;
  getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, 'N', 'x', 'user', 'active')",
  ).run(id, email);
  grant(getDb(), id, { teamRole, maxMode, usdCapMonth });
  return id;
}

const owner = user('owner@example.com', 'owner');
const engineer = user('engineer@example.com', 'member');
const outsider = user('outsider@example.com', 'member');
registerProject(getDb(), owner, { id: 'p-one', name: 'One', root: '/work/one' });
registerProject(getDb(), owner, { id: 'p-two', name: 'Two', root: '/work/two' });
setProjectMember(getDb(), owner, 'p-one', engineer, { role: 'admin', maxMode: 'execute', usdCapMonth: 0 });

const as = (id) => ({ id });

test('isProjectRoute matches only the project routes', () => {
  assert.equal(isProjectRoute('/projects'), true);
  assert.equal(isProjectRoute('/projects/p-one/members'), true);
  assert.equal(isProjectRoute('/projects/p-one/members/u-1'), true);
  assert.equal(isProjectRoute('/projectsx'), false);
  assert.equal(isProjectRoute('/admin/members'), false);
});

test('GET /projects lists the caller’s effective role per project', async () => {
  const { res, handled } = await call({ method: 'GET', url: '/projects', user: as(engineer) });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const one = body.projects.find((p) => p.id === 'p-one');
  const two = body.projects.find((p) => p.id === 'p-two');
  assert.equal(one.role, 'admin');
  assert.ok(one.permissions.includes('project.admin'));
  assert.equal(two.role, 'viewer');
  assert.ok(!two.permissions.includes('project.admin'));
});

test('an unauthenticated request is 401', async () => {
  const { res } = await call({ method: 'GET', url: '/projects' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');
});

test('a project member cannot read the member list; a project admin can', async () => {
  const denied = await call({ method: 'GET', url: '/projects/p-one/members', user: as(outsider) });
  assert.equal(denied.res.statusCode, 403);
  assert.equal(denied.res.json().error.code, 'ROLE_DENIED');

  const ok = await call({ method: 'GET', url: '/projects/p-one/members', user: as(engineer) });
  assert.equal(ok.res.statusCode, 200);
  assert.deepEqual(ok.res.json().project, { id: 'p-one', name: 'One' });
  assert.ok(ok.res.json().members.some((m) => m.userId === owner && m.role === 'owner'));
});

test('a project admin adds an existing member by email, audited and written through', async () => {
  const { res } = await call({
    method: 'POST', url: '/projects/p-one/members', user: as(engineer),
    body: { email: 'outsider@example.com', role: 'member', maxMode: 'execute', usdCapMonth: 4 },
  });
  assert.equal(res.statusCode, 200);
  const member = res.json().member;
  assert.equal(member.userId, outsider);
  assert.equal(member.role, 'member');
  assert.equal(getProjectMember(getDb(), outsider, 'p-one').usdCapMonth, 4);
  const audit = getDb().prepare("SELECT detail FROM audit_log WHERE action = 'project.member.grant' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.detail).projectId, 'p-one');
  const file = parseTeamYamlFile(fs.readFileSync(path.join(TEAM_DIR, 'team.yaml'), 'utf8'));
  const block = file.projects.find((p) => p.projectId === 'p-one');
  assert.ok(block.members.some((m) => m.email === 'outsider@example.com' && m.role === 'member'));
});

test('PATCH changes a project grant and refuses an unknown body key / bad cap', async () => {
  const bad = await call({
    method: 'PATCH', url: `/projects/p-one/members/${outsider}`, user: as(engineer), body: { role: 'member', nope: 1 },
  });
  assert.equal(bad.res.statusCode, 400);
  const cap = await call({
    method: 'PATCH', url: `/projects/p-one/members/${outsider}`, user: as(engineer), body: { usdCapMonth: -1 },
  });
  assert.equal(cap.res.statusCode, 400);
  const ok = await call({
    method: 'PATCH', url: `/projects/p-one/members/${outsider}`, user: as(engineer), body: { usdCapMonth: 9 },
  });
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.res.json().member.usdCapMonth, 9);
});

test('DELETE removes a row and the member falls back to the implicit viewer', async () => {
  const { res } = await call({ method: 'DELETE', url: `/projects/p-one/members/${outsider}`, user: as(owner) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().removed, true);
  assert.equal(getProjectMember(getDb(), outsider, 'p-one'), null);
  assert.equal(effectiveProjectGrant(getDb(), outsider, 'p-one').role, 'viewer');
  const audit = getDb().prepare("SELECT detail FROM audit_log WHERE action = 'project.member.revoke' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.detail).userId, outsider);
});

test('an unknown project answers 404; an unknown URL answers 404', async () => {
  const missing = await call({ method: 'GET', url: '/projects/p-nope/members', user: as(owner) });
  assert.equal(missing.res.statusCode, 404);
  const other = await call({ method: 'GET', url: '/projects/p-one/nope', user: as(owner) });
  assert.equal(other.res.statusCode, 404);
});
