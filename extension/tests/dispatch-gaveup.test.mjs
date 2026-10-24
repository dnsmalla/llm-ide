// Gave-up dispatch retries must stop being re-dispatched, and a `skipped`
// (already-claimed) retry result is neutral — not a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_dispatch-gaveup-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { retryFailedDispatches } = await import('../agents/dispatcher.mjs');

let U;
function seed() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) fs.rmSync(f, { force: true });
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `gu-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'gu',
  }).id;
  db.savePlan(U, { id: 'plan1', title: 'p', tasks: [{ id: 't1', title: 'Build', owner: 'A', risk: 'low' }] });
}
const GH = { repo: 'octo/repo', token: 'ghp_x' };
function stubFetch(status = 500) {
  const orig = globalThis.fetch;
  const state = { posts: 0 };
  globalThis.fetch = async () => {
    state.posts += 1;
    return new Response(JSON.stringify({ html_url: 'https://github.com/octo/repo/issues/1', number: 1 }), { status });
  };
  return { state, restore: () => { globalThis.fetch = orig; } };
}
const past = () => new Date(Date.now() - 60_000).toISOString();

test('gaveUp records are not re-dispatched', async () => {
  seed();
  db.mergeTaskMeta(U, 't1', { dispatchRetry: { attempts: 5, nextRetryAt: past(), gaveUp: true, target: 'github' } });
  const f = stubFetch(201);
  try {
    const r = await retryFailedDispatches(U, GH_CFG());
    assert.equal(f.state.posts, 0);
    assert.equal(r.retried, 0);
  } finally { f.restore(); }
});

function GH_CFG() { return GH; }

test('giving up clears nextRetryAt', async () => {
  seed();
  db.mergeTaskMeta(U, 't1', { dispatchRetry: { attempts: 5, nextRetryAt: past(), gaveUp: false, target: 'github' } });
  const f = stubFetch(500);
  try {
    await retryFailedDispatches(U, GH_CFG());
  } finally { f.restore(); }
  const dr = db.getTaskById(U, 't1').meta.dispatchRetry;
  assert.equal(dr.gaveUp, true);
  assert.equal(dr.nextRetryAt, null);
  const f2 = stubFetch(500);
  try {
    await retryFailedDispatches(U, GH_CFG());
    assert.equal(f2.state.posts, 0);
  } finally { f2.restore(); }
});

test('skipped retry result does not bump attempts or count as failure', async () => {
  seed();
  db.mergeTaskMeta(U, 't1', { dispatchRetry: { attempts: 2, nextRetryAt: past(), gaveUp: false, target: 'github' } });
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true); // another dispatcher holds the claim
  const f = stubFetch(201);
  try {
    const r = await retryFailedDispatches(U, GH_CFG());
    assert.equal(f.state.posts, 0);
    assert.equal(r.failed, 0);
  } finally { f.restore(); }
  assert.equal(db.getTaskById(U, 't1').meta.dispatchRetry.attempts, 2);
});
