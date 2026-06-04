// Tenant isolation tests.  Spins up an isolated SQLite DB, runs the
// real DB module's helpers as user A and user B, and asserts that
// neither sees the other's data through ANY of the read paths
// (search empty-query, search FTS, getMeeting, getPlan, listOutcomes,
// review queue, stats).  This is the contract that holds the whole
// multi-user system together; if these regress, the system is unsafe
// regardless of whatever else still works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Test-time secrets MUST be set before kb/db imports the config module
// (which validates env at load time).
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

// Per-test database file — isolated under a temp dir, deleted in
// after-each.  We can't use :memory: because better-sqlite3 keeps a
// process-wide singleton in db.mjs and we'd need to reset it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_tenancy-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

// Import AFTER env is set — order matters because config validates
// LLMIDE_VAULT_KEY length at import time.
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function reset() {
  // Module-level singleton DB — close, delete, re-open.
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  // Force lazy reopen on the next getDb() call.
  db.getDb();
}

function provision(email) {
  return users.registerUser(db.getDb(), {
    email,
    password: 'CorrectHorseBattery',
    displayName: email.split('@')[0],
  });
}

// Set up two distinct tenants for every test below.
async function setup() {
  reset();
  const alice = provision(`alice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  const bob   = provision(`bob-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  return { alice: alice.id, bob: bob.id };
}

test('ingestMeeting refuses to clobber another tenant\'s meeting id', async () => {
  const { alice, bob } = await setup();
  db.ingestMeeting(alice, {
    id: 'shared-id', title: 'Alice meeting', date: '2026-05-01',
    duration: 60, language: 'en', participants: ['Alice'],
    transcript: 'alice secret', entities: [],
  });
  assert.throws(() => db.ingestMeeting(bob, {
    id: 'shared-id', title: 'Bob hijack attempt', date: '2026-05-01',
    duration: 60, language: 'en', participants: ['Bob'],
    transcript: 'bob payload', entities: [],
  }), /owned by another user/);
});

test('getMeeting returns null for a meeting owned by another user', async () => {
  const { alice, bob } = await setup();
  db.ingestMeeting(alice, {
    id: 'a1', title: 'Alice', date: '2026-05-01', duration: 60,
    language: 'en', participants: ['Alice'], transcript: 'private',
    entities: [],
  });
  assert.ok(db.getMeeting(alice, 'a1'));
  assert.equal(db.getMeeting(bob, 'a1'), null);
});

test('getMeetingTranscript returns empty for cross-tenant ID', async () => {
  const { alice, bob } = await setup();
  db.ingestMeeting(alice, {
    id: 'a1', title: 'Alice', date: '2026-05-01', duration: 60,
    transcript: 'CROSS-TENANT-CANARY', entities: [],
  });
  assert.equal(db.getMeetingTranscript(alice, 'a1'), 'CROSS-TENANT-CANARY');
  assert.equal(db.getMeetingTranscript(bob, 'a1'), '');
});

test('search empty-query path drops cross-tenant rows', async () => {
  const { alice, bob } = await setup();
  db.ingestMeeting(alice, {
    id: 'a1', title: 'Alice planning', date: '2026-05-01', duration: 60,
    transcript: 'roadmap secrets', entities: [
      { id: 'a1-act-1', kind: 'action', text: 'Build thing', quote: '', meta: {} },
    ],
  });
  // Bob with no data: every kind returns []
  assert.deepEqual(db.search(bob, { kind: 'meeting' }), []);
  assert.deepEqual(db.search(bob, { kind: 'action'  }), []);
  // Alice sees her own data
  const aliceMeetings = db.search(alice, { kind: 'meeting' });
  assert.equal(aliceMeetings.length, 1);
  assert.equal(aliceMeetings[0].title, 'Alice planning');
});

test('search FTS path drops cross-tenant hits', async () => {
  const { alice, bob } = await setup();
  db.ingestMeeting(alice, {
    id: 'a-fts', title: 'Confidential roadmap',
    date: '2026-05-01', duration: 60,
    transcript: 'unique-canary-token-zzzqx', entities: [],
  });
  // Bob's FTS search for the unique canary returns nothing.
  const bobHits = db.search(bob, { q: 'unique-canary-token-zzzqx' });
  assert.equal(bobHits.length, 0);
  // Alice's same query DOES return it.
  const aliceHits = db.search(alice, { q: 'unique-canary-token-zzzqx' });
  assert.ok(aliceHits.some((h) => h.kind === 'meeting' && h.title === 'Confidential roadmap'));
});

test('findContext drops cross-tenant FTS hits during hydration', async () => {
  const { alice, bob } = await setup();
  db.ingestMeeting(alice, {
    id: 'fc-1', title: 'tenancy-canary', date: '2026-05-01', duration: 60,
    transcript: 'tenancy-canary content body', entities: [],
  });
  const aliceCtx = db.findContext(alice, 'tenancy-canary');
  assert.ok(aliceCtx.meetings.length > 0);
  const bobCtx = db.findContext(bob, 'tenancy-canary');
  assert.equal(bobCtx.meetings.length, 0);
});

test('savePlan refuses to overwrite another tenant\'s plan', async () => {
  const { alice, bob } = await setup();
  db.savePlan(alice, { id: 'shared-plan', title: 'Alice plan', tasks: [] });
  assert.throws(() => db.savePlan(bob, { id: 'shared-plan', title: 'Bob hijack', tasks: [] }),
    /owned by another user/);
});

test('listPlans / getPlan are scoped', async () => {
  const { alice, bob } = await setup();
  db.savePlan(alice, { id: 'p-a', title: 'Alice', tasks: [
    { id: 't-a-1', title: 'task1' },
  ]});
  db.savePlan(bob,   { id: 'p-b', title: 'Bob',   tasks: [
    { id: 't-b-1', title: 'task1' },
  ]});
  assert.equal(db.listPlans(alice).length, 1);
  assert.equal(db.listPlans(bob).length,   1);
  assert.ok(db.getPlan(alice, 'p-a'));
  assert.equal(db.getPlan(alice, 'p-b'), null);
  assert.equal(db.getPlan(bob, 'p-a'), null);
  assert.ok(db.getPlan(bob, 'p-b'));
});

test('updateTask only mutates rows the caller owns', async () => {
  const { alice, bob } = await setup();
  db.savePlan(alice, { id: 'p', title: 'Alice plan', tasks: [
    { id: 'shared-task', title: 'Alice task', status: 'planned' },
  ]});
  // Bob tries to flip status → no-op, returns null.
  assert.equal(db.updateTask(bob, 'shared-task', { status: 'done' }), null);
  // Alice's task is unchanged.
  const t = db.getTaskById(alice, 'shared-task');
  assert.equal(t.status, 'planned');
});

test('submitReview rejects refs to another tenant\'s plan/task', async () => {
  const { alice, bob } = await setup();
  db.savePlan(alice, { id: 'plan-a', title: 'Alice', tasks: [
    { id: 'task-a', title: 'A task' },
  ]});
  // Bob references Alice's plan in his review submission — reject.
  assert.throws(() => db.submitReview(bob, {
    kind: 'dispatch', planId: 'plan-a', title: 'evil',
    payload: { target: 'github' },
  }), /not found or not owned/);
});

test('listReviews / getReview are scoped', async () => {
  const { alice, bob } = await setup();
  db.savePlan(alice, { id: 'p-a', title: 'p', tasks: [] });
  const r = db.submitReview(alice, {
    kind: 'dispatch', planId: 'p-a', title: 'a-review', payload: {},
  });
  assert.equal(db.listReviews(alice).length, 1);
  assert.equal(db.listReviews(bob).length, 0);
  assert.ok(db.getReview(alice, r.id));
  assert.equal(db.getReview(bob, r.id), null);
});

test('recordOutcome refuses tasks owned by another user', async () => {
  const { alice, bob } = await setup();
  db.savePlan(alice, { id: 'p', title: 'p', tasks: [
    { id: 't-x', title: 'x' },
  ]});
  assert.throws(() => db.recordOutcome(bob, {
    taskId: 't-x', provider: 'github',
    ref: 'http://example/1', state: 'closed',
  }), /not found or not owned/);
});

test('userRepoAllowlist is scoped per user', async () => {
  const { alice, bob } = await setup();
  db.addUserRepo(alice, '/tmp/alice-repo', 'Alice repo');
  assert.deepEqual(db.userRepoAllowlist(alice), ['/tmp/alice-repo']);
  assert.deepEqual(db.userRepoAllowlist(bob),   []);
});

test('stats reflects only the caller\'s data', async () => {
  const { alice, bob } = await setup();
  for (let i = 0; i < 3; i += 1) {
    db.ingestMeeting(alice, {
      id: `a-${i}`, title: `m${i}`, date: '2026-05-01',
      duration: 60, transcript: 'x', entities: [],
    });
  }
  assert.equal(db.stats(alice).meetings, 3);
  assert.equal(db.stats(bob).meetings, 0);
});

test('search filters by projectId when supplied', async () => {
  const { alice } = await setup();
  db.ingestMeeting(alice, {
    id: 'mtg-p1', title: 'roadmap', date: '2026-05-01', duration: 60,
    transcript: 'the product roadmap discussion', entities: [],
    projectId: 'projectA',
  });
  db.ingestMeeting(alice, {
    id: 'mtg-unt', title: 'misc', date: '2026-05-01', duration: 60,
    transcript: 'the product roadmap discussion', entities: [],
  });
  const all = db.search(alice, { q: 'roadmap' });
  const filtered = db.search(alice, { q: 'roadmap', projectId: 'projectA' });
  assert.equal(all.length, 2, 'no filter should return both rows');
  assert.equal(filtered.length, 1, 'projectId filter should drop the untagged row');
  assert.equal(filtered[0].meetingId, 'mtg-p1');
});

// Final cleanup — remove the test DB file so subsequent runs start fresh.
test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});
