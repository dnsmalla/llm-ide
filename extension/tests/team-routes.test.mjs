// /admin/members and /admin/invites (ADR 0021 H1 Task 5). Handler-level: req/res doubles, a scratch DB,
// and the route's own `db` handle — server.mjs's JWT gate and the kbWrite bucket are covered by
// auth-routes' spawned-server test and by the reachability check in Task 6.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_team-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb } = await import('../kb/db.mjs');
const { handleTeamRoute, isTeamRoute } = await import('../routes/team-routes.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    headers: {},
    user,
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
    statusCode: 200,
    headers: {},
    _body: '',
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; },
    json() { return JSON.parse(this._body); },
  };
}

async function call(reqOpts) {
  const res = makeRes();
  await handleTeamRoute(makeReq(reqOpts), res, { db: getDb(), logger: noopLogger, requestId: 'test-req' });
  return res;
}

let seq = 0;
function addUser(teamRole) {
  const id = `team-${++seq}`;
  getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, 'N', 'x', 'user', 'active')",
  ).run(id, `${id}@example.com`);
  if (teamRole) {
    getDb().prepare(
      "INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES (?, ?, 'execute', 0)",
    ).run(id, teamRole);
  }
  return id;
}

const as = (id) => ({ id });

const auditRows = (action) => getDb().prepare(
  'SELECT user_id, resource, outcome, detail FROM audit_log WHERE action = ? ORDER BY id',
).all(action).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));

// --- routing predicate -----------------------------------------------------

test('isTeamRoute claims exactly the two admin path prefixes', () => {
  assert.equal(isTeamRoute('/admin/members'), true);
  assert.equal(isTeamRoute('/admin/members/u1'), true);
  assert.equal(isTeamRoute('/admin/invites?x=1'), true);
  assert.equal(isTeamRoute('/admin/invites/0123456789abcdef'), true);
  assert.equal(isTeamRoute('/admin/backup'), false);
  assert.equal(isTeamRoute('/admin/users/u1'), false);
  assert.equal(isTeamRoute('/kb/members'), false);
});

// --- authentication / authority -------------------------------------------

test('every route refuses an unauthenticated caller (401 AUTH_REQUIRED)', async () => {
  const calls = [
    { method: 'GET', url: '/admin/members' },
    { method: 'PATCH', url: '/admin/members/u1', body: { maxMode: 'none' } },
    { method: 'POST', url: '/admin/invites', body: {} },
    { method: 'GET', url: '/admin/invites' },
    { method: 'DELETE', url: '/admin/invites/0123456789abcdef' },
  ];
  for (const c of calls) {
    const res = await call(c);
    assert.equal(res.statusCode, 401, `${c.method} ${c.url}`);
    assert.equal(res.json().error.code, 'AUTH_REQUIRED');
  }
});

test('every route refuses a member and a viewer (403 ROLE_DENIED) and a user with no members row', async () => {
  const member = addUser('member');
  const viewer = addUser('viewer');
  const nobody = addUser(null);
  const owner = addUser('owner');
  const invite = (await call({ method: 'POST', url: '/admin/invites', user: as(owner), body: {} })).json();
  for (const principal of [member, viewer, nobody]) {
    const calls = [
      { method: 'GET', url: '/admin/members' },
      { method: 'PATCH', url: `/admin/members/${member}`, body: { maxMode: 'none' } },
      { method: 'POST', url: '/admin/invites', body: {} },
      { method: 'GET', url: '/admin/invites' },
      { method: 'DELETE', url: `/admin/invites/${invite.id}` },
    ];
    for (const c of calls) {
      const res = await call({ ...c, user: as(principal) });
      assert.equal(res.statusCode, 403, `${principal} ${c.method} ${c.url}`);
      assert.equal(res.json().error.code, 'ROLE_DENIED');
    }
  }
});

// --- GET /admin/members ---------------------------------------------------

test('GET /admin/members lists every member with the users row, never a secret', async () => {
  const { member: _old } = {};
  const owner = addUser('owner');
  const member = addUser('member');
  getDb().prepare("UPDATE members SET max_mode = 'read_only', usd_cap_month = 20 WHERE user_id = ?").run(member);
  const res = await call({ method: 'GET', url: '/admin/members', user: as(owner) });
  assert.equal(res.statusCode, 200);
  const rows = res.json().members;
  const row = rows.find((r) => r.userId === member);
  assert.deepEqual(row, {
    userId: member, email: `${member}@example.com`, displayName: 'N', status: 'active',
    teamRole: 'member', maxMode: 'read_only', usdCapMonth: 20, updatedAt: row.updatedAt,
  });
  assert.ok(typeof row.updatedAt === 'string');
  assert.ok(rows.some((r) => r.teamRole === 'owner'), 'ordered with the owner first');
  assert.equal(rows[0].teamRole, 'owner');
  assert.ok(!JSON.stringify(res.json()).includes('password'), 'never a password hash');
});

// --- PATCH /admin/members/:id --------------------------------------------

test('PATCH /admin/members/:id changes grants (owner) and audits team.grant', async () => {
  const owner = addUser('owner');
  const target = addUser('member');
  const res = await call({
    method: 'PATCH', url: `/admin/members/${target}`, user: as(owner),
    body: { teamRole: 'viewer', maxMode: 'none', usdCapMonth: 5 },
  });
  assert.equal(res.statusCode, 200, res._body);
  const { userId, email, displayName, status, teamRole, maxMode, usdCapMonth, updatedAt } = res.json().member;
  assert.deepEqual({ userId, email, displayName, status, teamRole, maxMode, usdCapMonth }, {
    userId: target, email: `${target}@example.com`, displayName: 'N', status: 'active',
    teamRole: 'viewer', maxMode: 'none', usdCapMonth: 5,
  });
  assert.ok(typeof updatedAt === 'string');
  const rows = auditRows('team.grant').filter((r) => r.resource === target);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].detail, { teamRole: 'viewer', maxMode: 'none', usdCapMonth: 5 });
});

test('an admin may change a member but not the owner; the owner cannot demote the last owner', async () => {
  const owner = addUser('owner');
  const admin = addUser('admin');
  const member = addUser('member');

  const ok = await call({ method: 'PATCH', url: `/admin/members/${member}`, user: as(admin), body: { maxMode: 'none' } });
  assert.equal(ok.statusCode, 200, ok._body);

  const touchOwner = await call({ method: 'PATCH', url: `/admin/members/${owner}`, user: as(admin), body: { maxMode: 'none' } });
  assert.equal(touchOwner.statusCode, 403);
  assert.equal(touchOwner.json().error.code, 'ROLE_DENIED');

  // Only this account is an owner (earlier tests in this file made more): the last-owner guard is next.
  getDb().prepare("UPDATE members SET team_role = 'admin' WHERE team_role = 'owner' AND user_id != ?").run(owner);
  const lastOwner = await call({ method: 'PATCH', url: `/admin/members/${owner}`, user: as(owner), body: { teamRole: 'admin' } });
  assert.equal(lastOwner.statusCode, 409);
  assert.equal(lastOwner.json().error.code, 'LAST_OWNER');

  // A second owner removes the LAST_OWNER guard, so the self-grant rule answers.
  const peer = addUser('owner');
  const self = await call({ method: 'PATCH', url: `/admin/members/${peer}`, user: as(peer), body: { maxMode: 'none' } });
  assert.equal(self.json().error.code, 'SELF_GRANT');
  const selfRole = await call({ method: 'PATCH', url: `/admin/members/${peer}`, user: as(peer), body: { teamRole: 'admin' } });
  assert.equal(self.statusCode, 403);
  assert.equal(selfRole.json().error.code, 'SELF_GRANT');
});

test('PATCH validates a closed object and the migration enums', async () => {
  const owner = addUser('owner');
  const target = addUser('member');
  const bad = [
    { maxMode: 'write' },
    { teamRole: 'root' },
    { usdCapMonth: -1 },
    { usdCapMonth: 100_001 },
    { usdCapMonth: 'lots' },
    { maxMode: 'none', surprise: 1 },
    {},
  ];
  for (const body of bad) {
    const res = await call({ method: 'PATCH', url: `/admin/members/${target}`, user: as(owner), body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error.code, 'VALIDATION_FAILED');
  }
  const missing = await call({ method: 'PATCH', url: '/admin/members/no-such-member', user: as(owner), body: { maxMode: 'none' } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'NOT_FOUND');
});

// --- POST /admin/invites --------------------------------------------------

test('POST /admin/invites mints a single-use token (32 bytes) and audits without the token', async () => {
  const owner = addUser('owner');
  const res = await call({ method: 'POST', url: '/admin/invites', user: as(owner), body: { email: 'new@example.com' } });
  assert.equal(res.statusCode, 200, res._body);
  const out = res.json();
  assert.match(out.id, /^[0-9a-f]{16}$/);
  assert.ok(Buffer.from(out.token, 'base64url').length === 32, 'the token is 32 random bytes');
  assert.ok(out.expiresAt);
  const row = getDb().prepare('SELECT token_hash, email, team_role, max_mode, usd_cap_month, created_by FROM invites WHERE id = ?').get(out.id);
  assert.equal(row.email, 'new@example.com');
  assert.equal(row.team_role, 'member');
  assert.equal(row.max_mode, 'read_only');
  assert.equal(row.usd_cap_month, 20);
  assert.equal(row.created_by, owner);
  assert.notEqual(row.token_hash, out.token, 'only the hash is stored');
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);

  const audits = auditRows('team.invite').filter((r) => r.resource === out.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].detail.invite, out.id);
  assert.ok(!JSON.stringify(audits[0].detail).includes(out.token), 'never the token');
});

test('an owner may invite an admin; an admin cannot invite an admin; nobody can invite an owner', async () => {
  const owner = addUser('owner');
  const admin = addUser('admin');
  const ok = await call({ method: 'POST', url: '/admin/invites', user: as(owner), body: { teamRole: 'admin' } });
  assert.equal(ok.statusCode, 200, ok._body);

  const peer = await call({ method: 'POST', url: '/admin/invites', user: as(admin), body: { teamRole: 'admin' } });
  assert.equal(peer.statusCode, 403);
  assert.equal(peer.json().error.code, 'ROLE_DENIED');

  const ownerInvite = await call({ method: 'POST', url: '/admin/invites', user: as(owner), body: { teamRole: 'owner' } });
  assert.equal(ownerInvite.statusCode, 403);
  assert.equal(ownerInvite.json().error.code, 'ROLE_DENIED');

  const asMember = await call({ method: 'POST', url: '/admin/invites', user: as(admin), body: { teamRole: 'member' } });
  assert.equal(asMember.statusCode, 200, 'an admin may invite a member');
});

test('POST /admin/invites validates ttl, email, enums and the closed object', async () => {
  const owner = addUser('owner');
  const bad = [
    { ttlHours: 0 },
    { ttlHours: 169 },
    { ttlHours: 1.5 },
    { email: 'x'.repeat(250) + '@ex.com' },
    { email: 42 },
    { teamRole: 'root' },
    { maxMode: 'bypass' },
    { usdCapMonth: 200_000 },
    { surprise: true },
  ];
  for (const body of bad) {
    const res = await call({ method: 'POST', url: '/admin/invites', user: as(owner), body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error.code, 'VALIDATION_FAILED');
  }
  // The boundaries are accepted.
  for (const body of [{ ttlHours: 1 }, { ttlHours: 168 }, { usdCapMonth: 0 }, { usdCapMonth: 100_000 }]) {
    const res = await call({ method: 'POST', url: '/admin/invites', user: as(owner), body });
    assert.equal(res.statusCode, 200, JSON.stringify(body));
  }
});

// --- GET / DELETE invites -------------------------------------------------

test('GET /admin/invites lists the grants and never the token or its hash', async () => {
  const owner = addUser('owner');
  const minted = (await call({ method: 'POST', url: '/admin/invites', user: as(owner), body: { email: 'list@example.com' } })).json();
  const res = await call({ method: 'GET', url: '/admin/invites', user: as(owner) });
  assert.equal(res.statusCode, 200);
  const row = res.json().invites.find((i) => i.id === minted.id);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'createdBy', 'email', 'expiresAt', 'id', 'maxMode', 'teamRole', 'usdCapMonth', 'usedAt']);
  assert.equal(row.email, 'list@example.com');
  assert.equal(row.usedAt, null);
  assert.ok(!JSON.stringify(res.json()).includes(minted.token), 'never the token');
  assert.ok(!JSON.stringify(res.json()).includes(getDb().prepare('SELECT token_hash FROM invites WHERE id = ?').get(minted.id).token_hash), 'never the hash');
});

test('DELETE /admin/invites/:id revokes it and audits team.invite.revoke', async () => {
  const owner = addUser('owner');
  const minted = (await call({ method: 'POST', url: '/admin/invites', user: as(owner), body: {} })).json();
  const res = await call({ method: 'DELETE', url: `/admin/invites/${minted.id}`, user: as(owner) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { revoked: true });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM invites WHERE id = ?').get(minted.id).n, 0);
  const audits = auditRows('team.invite.revoke').filter((r) => r.resource === minted.id);
  assert.equal(audits.length, 1);

  const again = await call({ method: 'DELETE', url: `/admin/invites/${minted.id}`, user: as(owner) });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { revoked: false });

  const malformed = await call({ method: 'DELETE', url: '/admin/invites/not-an-id', user: as(owner) });
  assert.equal(malformed.statusCode, 404);
});

test('an unknown method on a team path answers 404 instead of falling through', async () => {
  const owner = addUser('owner');
  const res = await call({ method: 'PUT', url: '/admin/members', user: as(owner), body: {} });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});

after(() => {
  getDb().close();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});
