// Loop self-improvement storage (migration 0078, kb/loop-improve.mjs): signals, proposals, offers, outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_loop-improve-store-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { registerProject } = await import('../kb/projects.mjs');
const store = await import('../kb/loop-improve.mjs');
const {
  recordSignal, signalsSinceReview, saveProposals, decide, adoptOffer, dismissOffer,
  loopState, runStats, compareOutcome,
} = store;

const db = getDb();
let counter = 0;
function newUser() {
  counter += 1;
  return registerUser(db, { email: `li${counter}@x.y`, password: 'password-12345', displayName: `U${counter}` });
}
const userA = newUser();
const userB = newUser();
registerProject(db, userA.id, { id: 'P1', name: 'Project One' });
registerProject(db, userA.id, { id: 'P2', name: 'Project Two' });

let seq = 0;
const finish = (user, projectId, loopId, payload, runId = `r${++seq}`) =>
  recordSignal(db, user.id, { projectId, loopId, kind: 'run_finished', runId, payload });
const run = (passed, extra = {}) => ({ passed, iterations: 2, costUsd: 1, stages: [], ...extra });
const proposal = (extra = {}) => ({
  templateKey: 'tpl', stageKey: 'test-write', change: { stageName: 'Test' }, rationale: 'why',
  evidence: [{ kind: 'sent_back' }], suggestedScope: 'general', ...extra,
});
const accept = (user, projectId, loopId, extra = {}, scope = 'general') => {
  const { ids } = saveProposals(db, user.id, {
    projectId, loopId, cursor: 0, expectedCursor: storedCursor(user, projectId, loopId), proposals: [proposal(extra)],
  });
  return decide(db, user.id, { projectId, id: ids[0], action: 'accept', scope });
};
const storedCursor = (user, projectId, loopId) => signalsSinceReview(db, user.id, projectId, loopId).cursor;

test('recordSignal twice with the same run_finished runId returns duplicate:true and keeps one row', () => {
  const first = finish(userA, 'P1', 'dup', run(true), 'same-run');
  const second = finish(userA, 'P1', 'dup', run(true), 'same-run');
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loop_signals WHERE loop_id = 'dup'").get().n, 1);
});

test('recordSignal rejects an unknown kind and truncates oversized strings', () => {
  assert.throws(() => recordSignal(db, userA.id, { projectId: 'P1', loopId: 'k', kind: 'nope', payload: {} }));
  const { id } = recordSignal(db, userA.id, {
    projectId: 'P1', loopId: 'k', kind: 'loop_edited', payload: { text: 'x'.repeat(30_000), nested: { s: 'y'.repeat(25_000) } },
  });
  const stored = JSON.parse(db.prepare('SELECT payload FROM loop_signals WHERE id = ?').get(id).payload);
  assert.equal(stored.text.length, 20_000);
  assert.equal(stored.nested.s.length, 20_000);
});

test('signalsSinceReview returns only rows after the cursor and counts finishedRuns', () => {
  const loop = 'since';
  finish(userA, 'P1', loop, run(true));
  recordSignal(db, userA.id, { projectId: 'P1', loopId: loop, kind: 'sent_back', payload: {} });
  const before = signalsSinceReview(db, userA.id, 'P1', loop);
  assert.equal(before.signals.length, 2);
  assert.equal(before.finishedRuns, 1);
  saveProposals(db, userA.id, { projectId: 'P1', loopId: loop, cursor: before.lastId, expectedCursor: before.cursor, proposals: [] });
  finish(userA, 'P1', loop, run(false));
  const after = signalsSinceReview(db, userA.id, 'P1', loop);
  assert.equal(after.cursor, before.lastId);
  assert.equal(after.signals.length, 1);
  assert.equal(after.finishedRuns, 1);
});

test('saveProposals with a stale expectedCursor throws REVIEW_RACE and stores nothing', () => {
  const loop = 'race';
  assert.throws(
    () => saveProposals(db, userA.id, { projectId: 'P1', loopId: loop, cursor: 9, expectedCursor: 5, proposals: [proposal()] }),
    (e) => e.code === 'REVIEW_RACE',
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loop_improvements WHERE loop_id = 'race'").get().n, 0);
});

test('saveProposals supersedes older proposed rows of the same loop only', () => {
  const a = saveProposals(db, userA.id, { projectId: 'P1', loopId: 'sup-a', cursor: 1, expectedCursor: 0, proposals: [proposal()] });
  const other = saveProposals(db, userA.id, { projectId: 'P1', loopId: 'sup-b', cursor: 1, expectedCursor: 0, proposals: [proposal()] });
  saveProposals(db, userA.id, { projectId: 'P1', loopId: 'sup-a', cursor: 2, expectedCursor: 1, proposals: [proposal()] });
  const status = (id) => db.prepare('SELECT status FROM loop_improvements WHERE id = ?').get(id).status;
  assert.equal(status(a.ids[0]), 'superseded');
  assert.equal(status(other.ids[0]), 'proposed');
});

test("user B never sees user A's signals, proposals or offers", () => {
  accept(userA, 'P1', 'iso');
  finish(userA, 'P1', 'iso', run(true));
  assert.equal(signalsSinceReview(db, userB.id, 'P1', 'iso').signals.length, 0);
  const state = loopState(db, userB.id, { projectId: 'P2', loops: [{ loopId: 'iso', templateKey: 'tpl', stageKeys: ['test-write'] }] });
  assert.deepEqual(state.offers, []);
  assert.deepEqual(state.loops.iso.proposals, []);
  assert.deepEqual(state.loops.iso.history, []);
});

test('offers: stage-level matching, never to the source project, gone after dismiss or adopt', () => {
  const row = accept(userA, 'P1', 'off-src', { stageKey: 'offer-stage' });
  const loops = (stageKeys) => [{ loopId: 'off-dst', templateKey: 'other', stageKeys }];
  const offered = (project, stageKeys) =>
    loopState(db, userA.id, { projectId: project, loops: loops(stageKeys) }).offers.filter((o) => o.id === row.id);
  assert.equal(offered('P2', ['offer-stage']).length, 1);
  assert.equal(offered('P2', ['offer-stage'])[0].fromProjectName, 'Project One');
  assert.equal(offered('P2', ['offer-stage'])[0].forLoopId, 'off-dst');
  assert.equal(offered('P2', ['something-else']).length, 0);
  assert.equal(offered('P1', ['offer-stage']).length, 0);
  dismissOffer(db, userA.id, { projectId: 'P2', offerId: row.id });
  assert.equal(offered('P2', ['offer-stage']).length, 0);
  assert.throws(() => dismissOffer(db, userA.id, { projectId: 'P2', offerId: 'no-such-id' }), { code: 'NOT_FOUND' });
  assert.throws(() => dismissOffer(db, userA.id, { projectId: 'P1', offerId: row.id }), { code: 'NOT_FOUND' }, 'own project is no offer');
  assert.throws(() => decide(db, userA.id, { projectId: 'P2', id: row.id, action: 'revert' }), { code: 'NOT_FOUND' }, 'another project');

  const row2 = accept(userA, 'P1', 'off-src2', { stageKey: 'adopt-stage' });
  const adopted = adoptOffer(db, userA.id, { projectId: 'P2', loopId: 'off-dst', offerId: row2.id });
  assert.equal(adopted.origin, `shared:${row2.id}`);
  assert.equal(adopted.scope, 'project');
  assert.equal(adopted.status, 'accepted');
  const after = loopState(db, userA.id, { projectId: 'P2', loops: [{ loopId: 'off-dst', templateKey: 'x', stageKeys: ['adopt-stage'] }] });
  assert.equal(after.offers.filter((o) => o.id === row2.id).length, 0);
});

test('offers: a loop-level change is offered only when a non-null template key matches', () => {
  const row = accept(userA, 'P1', 'tpl-src', { stageKey: null, templateKey: 'tpl-match' });
  const offers = (templateKey) => loopState(db, userA.id, {
    projectId: 'P2', loops: [{ loopId: 'tpl-dst', templateKey, stageKeys: ['anything'] }],
  }).offers.filter((o) => o.id === row.id);
  assert.equal(offers('tpl-match').length, 1);
  assert.equal(offers('tpl-other').length, 0);
  assert.equal(offers(null).length, 0);
  const nullTpl = accept(userA, 'P1', 'tpl-src2', { stageKey: null, templateKey: null });
  const state = loopState(db, userA.id, { projectId: 'P2', loops: [{ loopId: 'tpl-dst', templateKey: null, stageKeys: [] }] });
  assert.equal(state.offers.filter((o) => o.id === nullTpl.id).length, 0);
});

test("scope 'project' is never offered", () => {
  const row = accept(userA, 'P1', 'proj-only', { stageKey: 'proj-stage' }, 'project');
  const state = loopState(db, userA.id, { projectId: 'P2', loops: [{ loopId: 'd', templateKey: 't', stageKeys: ['proj-stage'] }] });
  assert.equal(state.offers.filter((o) => o.id === row.id).length, 0);
});

test('compareOutcome thresholds', () => {
  const s = (o) => ({ runs: 5, passRate: 0.5, avgCostUsd: 1, avgIterations: 2, stageFailRate: null, ...o });
  assert.equal(compareOutcome(s({ runs: 2 }), s()), 'not_enough_data');
  assert.equal(compareOutcome(s(), s({ runs: 2 })), 'not_enough_data');
  assert.equal(compareOutcome(s({ passRate: 0.4 }), s({ passRate: 0.8 })), 'better');
  assert.equal(compareOutcome(s({ passRate: 0.8 }), s({ passRate: 0.5 })), 'worse');
  assert.equal(compareOutcome(s({ stageFailRate: 0.6 }), s({ stageFailRate: 0.2 })), 'better');
  assert.equal(compareOutcome(s({ stageFailRate: 0.2 }), s({ stageFailRate: 0.6 })), 'worse');
  assert.equal(compareOutcome(s({ avgCostUsd: 1 }), s({ avgCostUsd: 1.3 })), 'worse');
  assert.equal(compareOutcome(s({ avgCostUsd: 1 }), s({ avgCostUsd: 0.7 })), 'better');
  assert.equal(compareOutcome(s({ passRate: 0.5, avgCostUsd: 1 }), s({ passRate: 0.7, avgCostUsd: 1.3 })), 'better');
  assert.equal(compareOutcome(s({ passRate: 0.5 }), s({ passRate: 0.6, avgCostUsd: 1.1 })), 'same');
});

test('runStats excludes a null cost from the average and reads the touched stage', () => {
  const stats = runStats([
    { passed: true, iterations: 1, costUsd: 2, stages: [{ name: 'Test', ok: false }] },
    { passed: false, iterations: 3, costUsd: null, stages: [{ name: 'Test', ok: true }] },
  ], 'Test');
  assert.equal(stats.runs, 2);
  assert.equal(stats.passRate, 0.5);
  assert.equal(stats.avgCostUsd, 2);
  assert.equal(stats.avgIterations, 2);
  assert.equal(stats.stageFailRate, 0.5);
  assert.equal(runStats([run(true)]).stageFailRate, null);
});

test('loopState evaluates an accepted improvement once after 5 later runs', () => {
  const loop = 'outcome';
  for (let i = 0; i < 4; i += 1) finish(userA, 'P1', loop, run(false));
  const row = accept(userA, 'P1', loop, { stageKey: null });
  assert.ok(row.baseline.runs === 4);
  const countOutcomes = () => db.prepare(
    "SELECT COUNT(*) AS n FROM loop_signals WHERE loop_id = ? AND kind = 'improvement_outcome'",
  ).get(loop).n;
  const ask = () => loopState(db, userA.id, { projectId: 'P1', loops: [{ loopId: loop, templateKey: 'tpl', stageKeys: [] }] });
  for (let i = 0; i < 4; i += 1) finish(userA, 'P1', loop, run(true));
  ask();
  assert.equal(countOutcomes(), 0);
  finish(userA, 'P1', loop, run(true));
  const state = ask();
  assert.equal(countOutcomes(), 1);
  assert.equal(state.loops[loop].history[0].outcome.verdict, 'better');
  ask();
  assert.equal(countOutcomes(), 1);
});

test("signalsSinceReview keeps a 'worse' outcome older than the cursor until the improvement is reverted", () => {
  const loop = 'worse';
  for (let i = 0; i < 4; i += 1) finish(userA, 'P1', loop, run(true));
  const row = accept(userA, 'P1', loop, { stageKey: null });
  for (let i = 0; i < 5; i += 1) finish(userA, 'P1', loop, run(false));
  loopState(db, userA.id, { projectId: 'P1', loops: [{ loopId: loop, templateKey: 'tpl', stageKeys: [] }] });
  const read = signalsSinceReview(db, userA.id, 'P1', loop);
  saveProposals(db, userA.id, { projectId: 'P1', loopId: loop, cursor: read.lastId, expectedCursor: read.cursor, proposals: [] });
  const kept = signalsSinceReview(db, userA.id, 'P1', loop);
  assert.deepEqual(kept.signals.map((x) => x.kind), ['improvement_outcome']);
  assert.equal(kept.signals[0].payload.verdict, 'worse');
  decide(db, userA.id, { projectId: 'P1', id: row.id, action: 'revert' });
  assert.equal(signalsSinceReview(db, userA.id, 'P1', loop).signals.length, 0);
});
