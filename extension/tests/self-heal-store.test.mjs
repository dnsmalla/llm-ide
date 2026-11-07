// The Self-Heal incident store (kb/incidents.mjs, table self_heal_incidents): upsert by signature, reopen, cap, tenancy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_self-heal-store-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
const wipe = () => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } };
wipe();

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const store = await import('../kb/incidents.mjs');
after(() => { kb.closeDb(); wipe(); });

let n = 0;
const mkUser = () => users.registerUser(kb.getDb(), { email: `shs-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 's' }).id;
const sql = (q, ...a) => kb.getDb().prepare(q).run(...a);

test('a repeat bumps count and lastSeen, keeps the first stack when the repeat has none, and stays per user', () => {
  const u = mkUser();
  const other = mkUser();
  const first = store.recordIncident(u, { source: 'server', category: 'server', message: 'Error: boom 1', stack: 'S' }, 10);
  assert.equal(first.status, 'new');
  const again = store.recordIncident(u, { source: 'server', category: 'server', message: 'Error: boom 2' }, 5);
  assert.equal(again.id, first.id, 'numbers do not change the signature');
  assert.deepEqual([again.count, again.firstSeen, again.lastSeen, again.stack, again.message], [2, 10, 10, 'S', 'Error: boom 2']);
  assert.equal(store.recordIncident(u, { source: 'nope', category: 'c', message: 'm' }), null);
  assert.deepEqual(store.listIncidents(other), []);
  assert.equal(store.listIncidents(u).length, 1);
});

test('a fixed incident that recurs reopens as new with attempts + 1 and no proposal', () => {
  const u = mkUser();
  const inc = store.recordIncident(u, { source: 'log', category: 'uncaught_exception', message: 'uncaught_exception: x' }, 1);
  sql(`UPDATE self_heal_incidents SET status = 'fixed', proposal_main_repo = '/r', proposal_worktree = '/w', proposal_branch = 'b',
    proposal_base_commit = 'c' WHERE user_id = ? AND id = ?`, u, inc.id);
  assert.deepEqual(store.listIncidents(u)[0].proposal, { mainRepo: '/r', worktreePath: '/w', branch: 'b', baseCommit: 'c' });
  const back = store.recordIncident(u, { source: 'log', category: 'uncaught_exception', message: 'uncaught_exception: x' }, 2);
  assert.deepEqual([back.status, back.attempts, back.count, back.proposal], ['new', 1, 2, null]);
});

test('200 per user: the least recently seen that is not fixing or proposed is evicted', () => {
  const u = mkUser();
  for (let i = 0; i < 200; i++) store.recordIncident(u, { source: 'log', category: `c-${i}`, message: 'boom' }, 1000 + i);
  sql("UPDATE self_heal_incidents SET status = 'fixing' WHERE user_id = ? AND category = 'c-0'", u);
  store.recordIncident(u, { source: 'log', category: 'c-200', message: 'boom' }, 5000);
  const cats = new Set(store.listIncidents(u).map((i) => i.category));
  assert.equal(cats.size, store.INCIDENT_CAP);
  assert.ok(cats.has('c-0'), 'a fixing incident is never evicted');
  assert.ok(!cats.has('c-1'), 'the oldest other one is');
  assert.ok(cats.has('c-200'));
});

test('ignore and clear spare fixing and proposed incidents; orphaned fixing rows go back to new', () => {
  const u = mkUser();
  const a = store.recordIncident(u, { source: 'ui', category: 'chat', message: 'a failed' }, 1);
  const b = store.recordIncident(u, { source: 'ui', category: 'loop', message: 'b failed' }, 2);
  assert.equal(store.ignoreIncident(u, a.id), true);
  assert.equal(store.ignoreIncident(mkUser(), a.id), false, 'another user cannot');
  assert.equal(store.ignoreIncident(u, '0000000000000000'), false);
  sql("UPDATE self_heal_incidents SET status = 'fixing' WHERE user_id = ? AND id = ?", u, b.id);
  assert.equal(store.ignoreIncident(u, b.id), false);
  assert.equal(store.clearIncidents(u), 1);
  assert.deepEqual(store.listIncidents(u).map((i) => [i.id, i.status]), [[b.id, 'fixing']]);
  assert.ok(store.reopenOrphanedIncidents() >= 1);
  assert.equal(store.listIncidents(u)[0].status, 'new');
});

test('the incidents go with the account', () => {
  const u = mkUser();
  store.recordIncident(u, { source: 'crash', category: 'crash', message: 'index out of bounds' }, 1);
  const counts = kb.deleteUserCascade(u);
  assert.equal(counts.self_heal_incidents, 1);
  assert.equal(kb.getDb().prepare('SELECT COUNT(*) AS n FROM self_heal_incidents WHERE user_id = ?').get(u).n, 0);
});
