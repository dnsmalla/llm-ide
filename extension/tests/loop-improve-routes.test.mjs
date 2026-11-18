// POST /kb/loop/improve/{signal,state,proposals,decide} (routes/loop-improve-routes.mjs).
// Hermetic: scratch DB, a registered project on a temp folder, req/res doubles.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_loop-improve-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { registerProject } = await import('../kb/projects.mjs');
const { handleLoopImproveRoutes } = await import('../routes/loop-improve-routes.mjs');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-improve-')));
after(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});

const ROOT = path.join(SANDBOX, 'proj');
fs.mkdirSync(ROOT);
const user = registerUser(getDb(), { email: 'loop-improve@example.com', password: 'CorrectHorseBattery', displayName: 't' });
grant(getDb(), user.id, { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
registerProject(getDb(), user.id, { id: 'proj-a', root: ROOT, name: 'A' });

function makeReq(url, body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  const req = {
    method: 'POST', url, user, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end' || event === 'close') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  return {
    on() { return this; }, statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    setHeader() {}, write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}
async function call(route, body) {
  const res = makeRes();
  const handled = await handleLoopImproveRoutes(makeReq(`/kb/loop/improve/${route}`, body), res, { userId: user.id });
  return { handled, status: res.statusCode, body: res._body ? res.json() : null };
}

const LOOP = { loopId: 'loop-1', templateKey: 'build', stageKeys: ['plan', 'code'] };
const CHANGE = { op: 'append_instruction', stageName: 'code', addendum: 'Run the tests.' };

test('an unrelated path is not handled', async () => {
  const res = makeRes();
  const req = makeReq('/kb/loop/agent-run', {});
  assert.equal(await handleLoopImproveRoutes(req, res, { userId: user.id }), false);
});

test('a GET to an improve path is not handled', async () => {
  const req = makeReq('/kb/loop/improve/state', {});
  req.method = 'GET';
  assert.equal(await handleLoopImproveRoutes(req, makeRes(), { userId: user.id }), false);
});

test('signal validates its shape', async () => {
  const base = { projectRoot: ROOT, loopId: 'loop-1', kind: 'run_finished', payload: {} };
  assert.equal((await call('signal', { ...base, loopId: '' })).status, 400);
  assert.equal((await call('signal', { ...base, loopId: undefined })).status, 400);
  assert.equal((await call('signal', { ...base, kind: 'nope' })).status, 400);
  assert.equal((await call('signal', { ...base, projectRoot: undefined })).status, 400);
  assert.equal((await call('signal', { ...base, payload: 'x' })).status, 400);
});

test('an unregistered project root answers 404 PROJECT_UNKNOWN on every route', async () => {
  const elsewhere = path.join(SANDBOX, 'nowhere');
  fs.mkdirSync(elsewhere);
  const bodies = {
    signal: { projectRoot: elsewhere, loopId: 'l', kind: 'run_finished', payload: {} },
    state: { projectRoot: elsewhere, loops: [LOOP] },
    proposals: { projectRoot: elsewhere, loopId: 'l', expectedCursor: 0, cursor: 0, proposals: [] },
    decide: { projectRoot: elsewhere, action: 'reject', id: 'x' },
  };
  for (const [route, body] of Object.entries(bodies)) {
    const out = await call(route, body);
    assert.equal(out.status, 404, route);
    assert.equal(out.body.error.code, 'PROJECT_UNKNOWN', route);
  }
});

test('signal then state: one finished run since review; a repeated run id is a duplicate', async () => {
  const body = { projectRoot: ROOT, loopId: 'loop-1', kind: 'run_finished', runId: 'r1', payload: { ok: true, costUsd: 0.1 } };
  const first = await call('signal', body);
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);
  assert.equal((await call('signal', body)).body.duplicate, true);
  const state = await call('state', { projectRoot: ROOT, loops: [LOOP] });
  assert.equal(state.status, 200);
  assert.equal(state.body.loops['loop-1'].finishedRunsSinceReview, 1);
  assert.deepEqual(state.body.offers, []);
  assert.equal(state.body.reviewInput, undefined);
});

test('state validates loops and reviewInputFor', async () => {
  assert.equal((await call('state', { projectRoot: ROOT })).status, 400);
  assert.equal((await call('state', { projectRoot: ROOT, loops: [{ templateKey: 'x', stageKeys: [] }] })).status, 400);
  assert.equal((await call('state', { projectRoot: ROOT, loops: [{ ...LOOP, stageKeys: 'plan' }] })).status, 400);
  assert.equal((await call('state', { projectRoot: ROOT, loops: [LOOP], reviewInputFor: 'other' })).status, 400);
});

test('state returns reviewInput with cursor, lastId and signals when asked', async () => {
  const state = await call('state', { projectRoot: ROOT, loops: [LOOP], reviewInputFor: 'loop-1' });
  assert.equal(state.status, 200);
  const input = state.body.reviewInput;
  assert.equal(input.cursor, 0);
  assert.ok(input.lastId > 0);
  assert.equal(input.signals.length, 1);
  assert.equal(input.signals[0].kind, 'run_finished');
});

test('proposals validates shape and caps', async () => {
  const base = { projectRoot: ROOT, loopId: 'loop-1', expectedCursor: 0, cursor: 1, proposals: [] };
  assert.equal((await call('proposals', { ...base, loopId: '' })).status, 400);
  assert.equal((await call('proposals', { ...base, expectedCursor: 'x' })).status, 400);
  assert.equal((await call('proposals', { ...base, cursor: -1 })).status, 400);
  assert.equal((await call('proposals', { ...base, proposals: 'x' })).status, 400);
  const many = Array.from({ length: 21 }, () => ({ change: CHANGE, rationale: 'r', evidence: [] }));
  assert.equal((await call('proposals', { ...base, proposals: many })).status, 400);
  const huge = [{ change: { op: 'append_instruction', addendum: 'x'.repeat(10_001) }, rationale: 'r', evidence: [] }];
  assert.equal((await call('proposals', { ...base, proposals: huge })).status, 400);
});

test('proposals stores, a stale cursor is 409 REVIEW_RACE, decide accept lands in history with a baseline', async () => {
  const input = (await call('state', { projectRoot: ROOT, loops: [LOOP], reviewInputFor: 'loop-1' })).body.reviewInput;
  const proposals = [{ templateKey: 'build', stageKey: 'code', change: CHANGE, rationale: 'Tests were skipped.', evidence: [1], suggestedScope: 'project' }];
  const saved = await call('proposals', {
    projectRoot: ROOT, loopId: 'loop-1', expectedCursor: input.cursor, cursor: input.lastId, proposals,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ids.length, 1);

  const race = await call('proposals', {
    projectRoot: ROOT, loopId: 'loop-1', expectedCursor: input.cursor, cursor: input.lastId, proposals,
  });
  assert.equal(race.status, 409);
  assert.equal(race.body.error.code, 'REVIEW_RACE');

  const [id] = saved.body.ids;
  const decided = await call('decide', { projectRoot: ROOT, action: 'accept', id });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.improvement.status, 'accepted');
  const state = await call('state', { projectRoot: ROOT, loops: [LOOP] });
  const entry = state.body.loops['loop-1'].history.find((row) => row.id === id);
  assert.ok(entry, 'accepted improvement is in history');
  assert.ok(entry.baseline, 'baseline was snapshotted');
});

test('decide validates, maps NOT_FOUND to 404 and CONFLICT to 409', async () => {
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'explode', id: 'x' })).status, 400);
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'accept' })).status, 400);
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'adopt', id: 'x' })).status, 400, 'adopt needs loopId');
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'accept', id: 'missing' })).status, 404);
  const state = await call('state', { projectRoot: ROOT, loops: [LOOP] });
  const accepted = state.body.loops['loop-1'].history[0];
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'accept', id: accepted.id })).status, 409);
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'revert', id: accepted.id })).status, 200);
});

test('dismiss of an offer answers 200 and stores a dismissal', async () => {
  const out = await call('decide', { projectRoot: ROOT, action: 'dismiss', id: 'some-offer' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { improvement: null });
});
