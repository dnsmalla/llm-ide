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
  const many = Array.from({ length: 21 }, () => ({ change: CHANGE, rationale: 'r', evidence: { signalIds: [] } }));
  assert.equal((await call('proposals', { ...base, proposals: many })).status, 400);
  const huge = [{ change: { op: 'append_instruction', addendum: 'x'.repeat(10_001) }, rationale: 'r', evidence: { signalIds: [] } }];
  assert.equal((await call('proposals', { ...base, proposals: huge })).status, 400);
});

test('proposals stores, a stale cursor is 409 REVIEW_RACE, decide accept lands in history with a baseline', async () => {
  const input = (await call('state', { projectRoot: ROOT, loops: [LOOP], reviewInputFor: 'loop-1' })).body.reviewInput;
  const proposals = [{ templateKey: 'build', stageKey: 'code', change: CHANGE, rationale: 'Tests were skipped.', evidence: { signalIds: [1] }, suggestedScope: 'project' }];
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

// A second project whose improvements must stay out of reach of project A's grant.
const ROOT_B = path.join(SANDBOX, 'proj-b');
fs.mkdirSync(ROOT_B);
registerProject(getDb(), user.id, { id: 'proj-b', root: ROOT_B, name: 'B' });
const LOOP_B = { loopId: 'loop-b', templateKey: 'build', stageKeys: ['plan', 'code'] };

async function acceptedIn(root, loop, scope) {
  const input = (await call('state', { projectRoot: root, loops: [loop], reviewInputFor: loop.loopId })).body.reviewInput;
  const saved = await call('proposals', {
    projectRoot: root, loopId: loop.loopId, expectedCursor: input.cursor, cursor: input.lastId,
    proposals: [{ templateKey: 'build', stageKey: 'code', change: CHANGE, rationale: 'r', evidence: { signalIds: [] }, suggestedScope: scope }],
  });
  const id = saved.body.ids[0];
  await call('decide', { projectRoot: root, action: 'accept', id, scope });
  return id;
}

test('decide with another project root cannot touch that project\'s improvement', async () => {
  const id = await acceptedIn(ROOT_B, LOOP_B, 'project');
  for (const action of ['reject', 'revert', 'accept']) {
    const out = await call('decide', { projectRoot: ROOT, action, id });
    assert.equal(out.status, 404, action);
  }
  const state = await call('state', { projectRoot: ROOT_B, loops: [LOOP_B] });
  assert.equal(state.body.loops['loop-b'].history.find((row) => row.id === id).status, 'accepted', 'row unchanged');
});

test('dismiss refuses an id that is not an offer, then dismiss hides a real offer; adopt moves it into the project', async () => {
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'dismiss', id: 'some-offer' })).status, 404);
  const offerA = await acceptedIn(ROOT, LOOP, 'general');
  const offered = async (loop) => (await call('state', { projectRoot: ROOT_B, loops: [loop] })).body.offers.filter((o) => o.id === offerA);
  assert.equal((await offered(LOOP_B)).length, 1, 'general improvement of A is offered to B');
  const adopted = await call('decide', { projectRoot: ROOT_B, action: 'adopt', id: offerA, loopId: 'loop-b' });
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.improvement.status, 'accepted');
  assert.equal(adopted.body.improvement.origin, `shared:${offerA}`);
  const afterAdopt = await call('state', { projectRoot: ROOT_B, loops: [LOOP_B] });
  assert.ok(afterAdopt.body.loops['loop-b'].history.some((row) => row.id === adopted.body.improvement.id), 'in B history');
  assert.equal((await offered(LOOP_B)).length, 0, 'no longer offered');

  const offerA2 = await acceptedIn(ROOT, LOOP, 'general');
  const countOffers = async () => (await call('state', { projectRoot: ROOT_B, loops: [LOOP_B] })).body.offers.filter((o) => o.id === offerA2).length;
  assert.equal(await countOffers(), 1);
  const out = await call('decide', { projectRoot: ROOT_B, action: 'dismiss', id: offerA2 });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { improvement: null });
  assert.equal(await countOffers(), 0, 'dismissed offer is gone from state.offers');
});

test('proposals checks rationale, evidence and suggestedScope', async () => {
  const good = { change: CHANGE, rationale: 'r', evidence: { signalIds: [1] }, suggestedScope: 'project' };
  const send = (item) => call('proposals', { projectRoot: ROOT, loopId: 'loop-1', expectedCursor: 0, cursor: 1, proposals: [item] });
  assert.equal((await send({ ...good, rationale: 5 })).status, 400);
  assert.equal((await send({ ...good, rationale: undefined })).status, 400);
  assert.equal((await send({ ...good, evidence: [1] })).status, 400);
  assert.equal((await send({ ...good, evidence: { signalIds: 'x' } })).status, 400);
  assert.equal((await send({ ...good, suggestedScope: 'everyone' })).status, 400);
});

test('a logged decision keeps its text only in the project log: state, offers and adopt read it from there', async () => {
  const L9 = { loopId: 'loop-9', templateKey: 'build', stageKeys: ['code'] };
  const input = (await call('state', { projectRoot: ROOT, loops: [L9], reviewInputFor: 'loop-9' })).body.reviewInput;
  const proposals = [{ templateKey: 'build', stageKey: 'code', change: CHANGE, rationale: 'Tests were skipped.', evidence: { signalIds: [1] }, suggestedScope: 'general' }];
  const [id] = (await call('proposals', { projectRoot: ROOT, loopId: 'loop-9', expectedCursor: input.cursor, cursor: input.lastId, proposals })).body.ids;
  const logDir = path.join(ROOT, 'system', 'self-improvement');
  const logFile = path.join(logDir, 'changes.jsonl');
  fs.mkdirSync(logDir, { recursive: true });
  const line = { id, action: 'accept', at: 't', loopId: 'loop-9', loopKey: 'build', stageKey: 'code', change: CHANGE, rationale: 'Tests were skipped.', excerpts: ['run 3: no tests'] };
  fs.writeFileSync(logFile, `${JSON.stringify(line)}\n`);
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'accept', id, scope: 'general', logged: true })).status, 200);
  const stored = getDb().prepare('SELECT change, rationale, evidence, baseline FROM loop_improvements WHERE id = ?').get(id);
  assert.deepEqual([stored.change, stored.rationale, stored.evidence], ['null', '', 'null'], 'the DB keeps no copy of the text');
  assert.equal(JSON.parse(stored.baseline).stageName, 'code', 'the baseline was taken before the text left');
  let entry = (await call('state', { projectRoot: ROOT, loops: [L9] })).body.loops['loop-9'].history.find((r) => r.id === id);
  assert.deepEqual([entry.change, entry.rationale, entry.evidence.excerpts], [CHANGE, 'Tests were skipped.', ['run 3: no tests']]);

  // Another project sees it as an offer, read from project A's log through the registry's folder.
  // ROOT_B / proj-b is registered at the top of this file.
  const LB = { loopId: 'loop-b', templateKey: 'build', stageKeys: ['code'] };
  const offer = (await call('state', { projectRoot: ROOT_B, loops: [LB] })).body.offers.find((o) => o.id === id);
  assert.deepEqual([offer.change, offer.fromProjectName, offer.forLoopId], [CHANGE, 'A', 'loop-b']);

  // Its record gone from A's log: no offer, no adopt, and A's history no longer lists a change it cannot show.
  fs.renameSync(logFile, `${logFile}.away`);
  assert.equal((await call('state', { projectRoot: ROOT_B, loops: [LB] })).body.offers.some((o) => o.id === id), false);
  const missing = await call('decide', { projectRoot: ROOT_B, action: 'adopt', id, loopId: 'loop-b', logged: true });
  assert.equal(missing.status, 404);
  const missingRow = (await call('state', { projectRoot: ROOT, loops: [L9] })).body.loops['loop-9'].history.find((r) => r.id === id);
  assert.deepEqual([missingRow.status, missingRow.change, missingRow.recordMissing], ['accepted', null, true], 'listed as missing, never hidden');
  fs.renameSync(`${logFile}.away`, logFile);

  // Adopt under the id the client logged it with; the adopted row keeps no text either.
  const newId = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  assert.equal((await call('decide', { projectRoot: ROOT_B, action: 'adopt', id, loopId: 'loop-b', newId: 'not-a-uuid' })).status, 400);
  // The client writes its log line first (as the panel does), then adopts with logged: true.
  fs.mkdirSync(path.join(ROOT_B, 'system', 'self-improvement'), { recursive: true });
  fs.writeFileSync(path.join(ROOT_B, 'system', 'self-improvement', 'changes.jsonl'), `${JSON.stringify({ ...line, id: newId, action: 'adopt', loopId: 'loop-b', origin: `shared:${id}` })}\n`);
  const adopted = await call('decide', { projectRoot: ROOT_B, action: 'adopt', id, loopId: 'loop-b', newId, logged: true });
  assert.equal(adopted.body.improvement.id, newId);
  assert.equal(getDb().prepare('SELECT change FROM loop_improvements WHERE id = ?').get(newId).change, 'null');
  entry = (await call('state', { projectRoot: ROOT_B, loops: [LB] })).body.loops['loop-b'].history.find((r) => r.id === newId);
  assert.deepEqual([entry.change, entry.origin], [CHANGE, `shared:${id}`]);
  assert.equal((await call('decide', { projectRoot: ROOT_B, action: 'accept', id, newId })).status, 400, 'newId is only for adopt');
});

test('logged: true is checked against the log: without the line the DB keeps its copy', async () => {
  const L8 = { loopId: 'loop-8', templateKey: 'build', stageKeys: ['code'] };
  const input = (await call('state', { projectRoot: ROOT, loops: [L8], reviewInputFor: 'loop-8' })).body.reviewInput;
  const proposals = [{ templateKey: 'build', stageKey: 'code', change: CHANGE, rationale: 'r', evidence: { signalIds: [1] }, suggestedScope: 'project' }];
  const [id] = (await call('proposals', { projectRoot: ROOT, loopId: 'loop-8', expectedCursor: input.cursor, cursor: input.lastId, proposals })).body.ids;
  assert.equal((await call('decide', { projectRoot: ROOT, action: 'accept', id, logged: true })).status, 200);
  assert.equal(getDb().prepare('SELECT change FROM loop_improvements WHERE id = ?').get(id).change, JSON.stringify(CHANGE), 'the client said logged, but the log has no line');
});
