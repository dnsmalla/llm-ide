// Plan B's store helpers (kb/incidents.mjs): triage, a run's outcome, resolving a proposal, reopening a lapsed run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_self-heal-fix-store-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const store = await import('../kb/incidents.mjs');
after(() => { kb.closeDb(); wipe(); });

let n = 0;
const mkUser = () => users.registerUser(kb.getDb(), { email: `shf-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 's' }).id;
const rec = (u, message, times = 1) => {
  let i;
  for (let k = 0; k < times; k++) i = store.recordIncident(u, { source: 'server', category: 'server', message });
  return i;
};
const status = (u) => Object.fromEntries(store.listIncidents(u).map((i) => [i.message, [i.status, i.attempts, i.note]]));
const OK = { runSucceeded: true, agentDown: false, aborted: false };
const FAILED = { runSucceeded: false, agentDown: false, aborted: false };
const P = (runId = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b') => ({
  mainRepo: '/src/llm-ide', worktreePath: `/data/self-heal/loop-worktrees/${runId}`, branch: `self-heal/${runId}`, baseCommit: 'a'.repeat(40),
});

test('triage picks the most frequent new incidents, ignores environmental ones with a reason, and never picks twice', () => {
  const u = mkUser();
  const other = mkUser();
  rec(u, 'Error: alpha broke', 3);
  rec(u, 'Error: beta broke');
  rec(u, 'fetch failed', 5);
  rec(u, 'Error: delta broke', 2);
  rec(other, 'Error: alpha broke', 9);
  assert.deepEqual(store.triageIncidents(u, 2).map((i) => [i.message, i.status]), [['Error: alpha broke', 'fixing'], ['Error: delta broke', 'fixing']]);
  assert.deepEqual(status(u)['fetch failed'], ['ignored', 0, 'environment: offline']);
  assert.deepEqual(status(u)['Error: beta broke'], ['new', 0, null]);
  assert.deepEqual(store.triageIncidents(u, 5).map((i) => i.message), ['Error: beta broke']);
  assert.deepEqual(store.triageIncidents(u, 5), []);
  assert.equal(store.listIncidents(other)[0].status, 'new', 'per user');
});

test('an outcome proposes only a fixed verdict on a run that succeeded, ignores environmental ones and counts failed attempts', () => {
  const u = mkUser();
  const [a, b, c] = ['Error: one broke', 'Error: two broke', 'Error: three broke'].map((m) => rec(u, m));
  const ids = store.triageIncidents(u, 5).map((i) => i.id);
  const results = new Map([[a.id, { verdict: 'fixed', reason: 'guard the null' }], [b.id, { verdict: 'environmental', reason: 'needs the network' }]]);
  assert.equal(store.applyRunOutcome(u, ids, results, OK, P()), 1);
  const by = Object.fromEntries(store.listIncidents(u).map((i) => [i.id, i]));
  assert.deepEqual([by[a.id].status, by[a.id].note, by[a.id].proposal], ['proposed', 'guard the null', P()]);
  assert.deepEqual([by[b.id].status, by[b.id].note], ['ignored', 'environment: needs the network']);
  assert.deepEqual([by[c.id].status, by[c.id].attempts, by[c.id].note], ['new', 1, null]);
});

test('fixed on a run that did not succeed is a failed attempt; three make needsHuman; agent down only reopens', () => {
  const u = mkUser();
  const a = rec(u, 'Error: stubborn broke');
  const fixed = new Map([[a.id, { verdict: 'fixed', reason: 'tried' }]]);
  for (let k = 1; k <= 3; k++) {
    const ids = store.triageIncidents(u, 5).map((i) => i.id);
    assert.deepEqual(ids, [a.id]);
    assert.equal(store.applyRunOutcome(u, ids, fixed, FAILED, null), 0);
  }
  assert.deepEqual(status(u)['Error: stubborn broke'], ['needsHuman', 3, 'tried']);
  const b = rec(u, 'Error: later broke');
  const ids = store.triageIncidents(u, 5).map((i) => i.id);
  assert.deepEqual(ids, [b.id], 'needsHuman is never picked');
  store.applyRunOutcome(u, ids, new Map([[b.id, { verdict: 'fixed', reason: 'x' }]]), { ...FAILED, agentDown: true }, null);
  assert.deepEqual(status(u)['Error: later broke'], ['new', 0, null]);
});

test('resolving a proposal marks its incidents fixed or ignored and clears it; a lapsed run reopens; others are untouched', () => {
  const u = mkUser();
  const other = mkUser();
  const runA = '11111111-1111-4111-8111-111111111111';
  const runB = '22222222-2222-4222-8222-222222222222';
  const a = rec(u, 'Error: apply me');
  let ids = store.triageIncidents(u, 5).map((i) => i.id);
  store.applyRunOutcome(u, ids, new Map([[a.id, { verdict: 'fixed', reason: 'r' }]]), OK, P(runA));
  assert.equal(store.resolveProposal(other, `self-heal/${runA}`, true), 0, 'per user');
  assert.equal(store.resolveProposal(u, `self-heal/${runA}`, true), 1);
  assert.deepEqual(status(u)['Error: apply me'], ['fixed', 0, 'r']);
  assert.equal(store.listIncidents(u)[0].proposal, null);
  const b = rec(u, 'Error: discard me');
  ids = store.triageIncidents(u, 5).map((i) => i.id);
  store.applyRunOutcome(u, ids, new Map([[b.id, { verdict: 'fixed', reason: 'r' }]]), OK, P(runB));
  assert.equal(store.resolveProposal(u, `self-heal/${runB}`, false), 1);
  assert.deepEqual(status(u)['Error: discard me'], ['ignored', 0, 'proposal discarded']);
  const c = rec(u, 'Error: lapsed');
  ids = store.triageIncidents(u, 5).map((i) => i.id);
  assert.equal(store.reopenIncidents(other, ids), 0);
  assert.equal(store.reopenIncidents(u, ids), 1);
  assert.equal(status(u)['Error: lapsed'][0], 'new');
  assert.equal(store.applyRunOutcome(u, [c.id], new Map(), FAILED, null), 0);
  assert.deepEqual(status(u)['Error: lapsed'], ['new', 0, null], 'a row no longer fixing is left alone');
});
