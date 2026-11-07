// R-014#1: the central member authority (server/route-authority.mjs) and the
// two routes that had no check — POST /kb/loop/agent-run and
// POST /kb/project/install-skills. Hermetic: scratch DB, req/res doubles, a fake
// Loop engine through the route's `deps` seam, and the real router for the
// install route (which stops at its own path validation once the gate passes).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_route-authority-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { handleLoopAgentRoutes } = await import('../routes/loop-agent.mjs');
const { handleKB } = await import('../routes/router.mjs');
const {
  ROUTE_AUTHORITY, authorizeRoute, enforceRouteAuthority, routeAuthorityFor,
} = await import('../server/route-authority.mjs');

after(() => {
  try { closeDb(); } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});

let seq = 0;
function user(teamRole, maxMode, usdCapMonth = 0) {
  const u = registerUser(getDb(), {
    email: `authority-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  grant(getDb(), u.id, { teamRole, maxMode, usdCapMonth });
  return u;
}
// Plan H1.2: registerUser now writes a members row, so this account is inserted raw to keep testing
// the fail-closed path for a user with no authority row (legacy / unregistered).
const noRowUser = () => {
  const id = `norow-${++seq}`;
  getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, 't', 'x', 'user')",
  ).run(id, `authority-norow-${seq}@example.com`);
  return { id };
};

function makeReq({ method = 'POST', url, body, user: u }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: u ? { id: u.id } : undefined, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      else if (event === 'close') { /* no-op */ }
      return req;
    },
    destroy() {},
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200, headers: {}, _body: '', headersSent: false, ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
const auditRows = (userId) => getDb().prepare(
  "SELECT action, outcome, detail FROM audit_log WHERE user_id = ? AND action = 'team.deny' ORDER BY id DESC",
).all(userId);
const spend = (userId, usd) => getDb().prepare(
  "INSERT INTO usage_ledger (user_id, provider, model, source, runs, cost_usd) VALUES (?, 'anthropic', 'claude-sonnet-5', 'api', 1, ?)",
).run(userId, usd);

// A fake Loop run: records whether the engine started, then answers like the real one.
function fakeRun() {
  const calls = [];
  const runAgent = async (args) => {
    calls.push(args);
    return {
      reply: 'done', changedPaths: [], changedExtraPaths: [], createdPaths: [],
      usage: { numTurns: 1 }, resolvedSkills: [], unresolvedSkills: [], truncatedSkills: [],
      ran: true, resultSubtype: 'success', denied: [], toolEvents: [],
    };
  };
  const validateRoot = () => ({ ok: true, root: '/tmp/route-authority-repo' });
  return { calls, deps: { runAgent, validateRoot } };
}
const loopBody = (message = 'edit the files') => ({ message, repoRoot: '/tmp/route-authority-repo' });
const loop = (u, body, deps) => {
  const res = makeRes();
  return handleLoopAgentRoutes(makeReq({ url: '/kb/loop/agent-run', body, user: u }), res, { userId: u?.id }, deps)
    .then((handled) => ({ handled, res }));
};

// ── the table ──────────────────────────────────────────────────────────────

test('the table names the dangerous routes and their gate (role + max_mode + cap)', () => {
  const byId = Object.fromEntries(ROUTE_AUTHORITY.map((r) => [r.id, r]));
  for (const id of ['loop.agent-run', 'project.install-skills', 'repos.add', 'repos.remove',
    'extensions.write', 'complete', 'agent.ask', 'generate.notes', 'generate.questions', 'extract.entities',
    'generate.doc', 'plan.generate', 'plan.risks', 'plan.codegen', 'providers.turn',
    'review.approve', 'dispatch', 'agent-sdk.update']) {
    assert.ok(byId[id], `missing authority rule ${id}`);
    assert.ok(['viewer', 'member', 'admin', 'owner'].includes(byId[id].role), `${id} role`);
    assert.ok(['read_only', 'execute'].includes(byId[id].maxMode), `${id} maxMode`);
    assert.equal(typeof byId[id].cap, 'boolean', `${id} cap`);
  }
  assert.equal(byId['project.install-skills'].role, 'admin');
  assert.equal(byId['project.install-skills'].maxMode, 'execute');
  assert.equal(byId['loop.agent-run'].maxMode, 'execute');
  assert.equal(byId['loop.agent-run'].cap, true);
  assert.equal(byId['complete'].maxMode, 'read_only', 'a one-shot completion is a read-only run mode');
  assert.equal(routeAuthorityFor('GET', '/kb/loop/agent-run'), null, 'only the declared method is gated');
  assert.equal(routeAuthorityFor('POST', '/kb/search'), null, 'a read route is not in the table');
});

// ── loop agent-run ─────────────────────────────────────────────────────────

test('the dispatcher form answers the refusal and reports the request handled; an allowed request passes', () => {
  const viewer = user('viewer', 'execute');
  const denied = makeRes();
  assert.equal(enforceRouteAuthority(getDb(), makeReq({ url: '/kb/complete', user: viewer }), denied), true);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json().error.code, 'ROLE_DENIED');
  assert.deepEqual(JSON.parse(auditRows(viewer.id)[0].detail), { reason: 'role_denied' });

  const doer = user('member', 'execute');
  const allowed = makeRes();
  assert.equal(enforceRouteAuthority(getDb(), makeReq({ url: '/kb/complete', user: doer }), allowed), false);
  assert.equal(allowed.statusCode, 200, 'the response is untouched');
});

test('a viewer is refused on the Loop run before the engine starts, with a reason-only audit row', async () => {
  const viewer = user('viewer', 'execute'); // max_mode execute does not make a viewer a runner
  const run = fakeRun();
  const { handled, res } = await loop(viewer, loopBody('secret prompt text'), run.deps);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: { code: 'ROLE_DENIED', message: 'Requires team role member' } });
  assert.equal(run.calls.length, 0, 'the engine must not start');
  const rows = auditRows(viewer.id);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].detail), { reason: 'role_denied' });
  assert.ok(!String(rows[0].detail).includes('secret prompt text'), 'never the message');
});

test('a read_only member is refused an edit/run; an execute member is allowed', async () => {
  const reader = user('member', 'read_only');
  const denied = fakeRun();
  const a = await loop(reader, loopBody(), denied.deps);
  assert.equal(a.res.statusCode, 403);
  assert.deepEqual(a.res.json().error, { code: 'ROLE_DENIED', message: 'Requires the execute run mode' });
  assert.equal(denied.calls.length, 0);
  assert.deepEqual(JSON.parse(auditRows(reader.id)[0].detail), { reason: 'max_mode_insufficient' });

  const doer = user('member', 'execute');
  const allowed = fakeRun();
  const b = await loop(doer, loopBody(), allowed.deps);
  assert.equal(b.res.statusCode, 200);
  assert.equal(allowed.calls.length, 1, 'the engine runs for an execute member');
  assert.equal(auditRows(doer.id).length, 0, 'an allowed run writes no team.deny row');
});

test('a max_mode none member is refused even when the role would pass', async () => {
  const none = user('admin', 'none');
  const run = fakeRun();
  const { res } = await loop(none, loopBody(), run.deps);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json().error, { code: 'ROLE_DENIED', message: 'Your team role cannot run turns' });
  assert.deepEqual(JSON.parse(auditRows(none.id)[0].detail), { reason: 'max_mode_none' });
  assert.equal(run.calls.length, 0);
});

test('a member with no members row fails closed on the Loop run', async () => {
  const orphan = noRowUser();
  const run = fakeRun();
  const { res } = await loop(orphan, loopBody(), run.deps);
  assert.equal(res.statusCode, 403);
  assert.equal(run.calls.length, 0);
  assert.deepEqual(JSON.parse(auditRows(orphan.id)[0].detail), { reason: 'role_denied' });
});

test('a member at the monthly USD cap is refused 429 before the Loop run; 0 means no cap', async () => {
  const capped = user('member', 'execute', 20);
  spend(capped.id, 20);
  const run = fakeRun();
  const { res } = await loop(capped, loopBody('secret cost prompt'), run.deps);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), { error: { code: 'USD_CAP', message: 'Monthly USD cap reached' } });
  assert.equal(run.calls.length, 0);
  const rows = auditRows(capped.id);
  assert.deepEqual(JSON.parse(rows[0].detail), { reason: 'usd_cap' });
  assert.ok(!String(rows[0].detail).includes('secret cost prompt'));

  const uncapped = user('member', 'execute', 0);
  spend(uncapped.id, 10_000);
  const run2 = fakeRun();
  const ok = await loop(uncapped, loopBody(), run2.deps);
  assert.equal(ok.res.statusCode, 200, 'cap 0 never refuses');
});

// ── install-skills ─────────────────────────────────────────────────────────

test('install-skills is admin-only: a member is refused before the kit runs, an admin passes the gate', async () => {
  const member = user('member', 'execute');
  const denied = makeRes();
  const handled = await handleKB(
    makeReq({ url: '/kb/project/install-skills', body: { path: __dirname }, user: member }),
    denied,
  );
  assert.equal(handled, true);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), { error: { code: 'ROLE_DENIED', message: 'Requires team role admin' } });
  assert.deepEqual(JSON.parse(auditRows(member.id)[0].detail), { reason: 'role_denied' });

  const admin = user('admin', 'execute');
  const passed = makeRes();
  await handleKB(
    makeReq({ url: '/kb/project/install-skills', body: { path: __dirname }, user: admin }),
    passed,
  );
  // The gate passed and the route reached its own marker check; the kit never
  // ran against a path without system/project.json.
  assert.equal(passed.statusCode, 400);
  assert.equal(passed.json().error.code, 'NOT_A_PROJECT');
  assert.equal(auditRows(admin.id).length, 0);
});

test('an admin with read_only cannot install into a project either', () => {
  const admin = user('admin', 'read_only');
  const decision = authorizeRoute(getDb(), makeReq({
    url: '/kb/project/install-skills', body: {}, user: admin,
  }), { rule: routeAuthorityFor('POST', '/kb/project/install-skills') });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'max_mode_insufficient');
});

// ── repo allow-list ────────────────────────────────────────────────────────

test('adding or removing a repo path needs a member with execute', () => {
  const rule = routeAuthorityFor('POST', '/auth/me/repos');
  assert.deepEqual([rule.id, rule.role, rule.maxMode], ['repos.add', 'member', 'execute']);
  const viewer = user('viewer', 'execute');
  const denied = authorizeRoute(getDb(), makeReq({ url: '/auth/me/repos', body: {}, user: viewer }), { rule });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'role_denied');
  const reader = user('member', 'read_only');
  assert.equal(authorizeRoute(getDb(), makeReq({ url: '/auth/me/repos', body: {}, user: reader }), { rule }).reason,
    'max_mode_insufficient');
  const doer = user('member', 'execute');
  assert.equal(authorizeRoute(getDb(), makeReq({ url: '/auth/me/repos', body: {}, user: doer }), { rule }).ok, true);
});
