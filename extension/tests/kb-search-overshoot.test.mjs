// kb.search must not come back short because the LIMIT ran before the
// tenancy / projectId filters.
//
// Regression (2026-09 review): the FTS path took the top `cap` rows of the
// SHARED index, then dropped other tenants' rows and other projects' rows
// during hydration — so a caller with real matches ranked below them got a
// short or empty page. The empty-query list path had the same shape for
// projectId (LIMIT, then filter in JS).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-search-overshoot-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function provision(name) {
  return users.registerUser(db.getDb(), {
    email: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: name,
  }).id;
}

function meeting(userId, id, { transcript = 'filler', projectId, date = '2026-05-01' } = {}) {
  db.ingestMeeting(userId, {
    id, title: `Meeting ${id}`, date, duration: 60, transcript, entities: [], projectId,
  });
}

test('FTS: another tenant\'s higher-ranked hits do not starve the caller', () => {
  reset();
  const alice = provision('alice');
  const bob = provision('bob');
  // Bob's rows repeat the term, so bm25 ranks every one of them above Alice's.
  for (let i = 0; i < 120; i++) {
    meeting(bob, `b${i}`, { transcript: 'roadmap roadmap roadmap roadmap roadmap' });
  }
  for (let i = 0; i < 3; i++) {
    meeting(alice, `a${i}`, { transcript: 'the roadmap is long and full of other words here' });
  }
  const hits = db.search(alice, { q: 'roadmap', kind: 'meeting', limit: 3 });
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.meetingId).sort(), ['a0', 'a1', 'a2']);
});

test('FTS: projectId filter still fills the page from deeper hits', () => {
  reset();
  const alice = provision('alice');
  for (let i = 0; i < 120; i++) {
    meeting(alice, `other${i}`, { transcript: 'budget budget budget budget', projectId: 'p-other' });
  }
  for (let i = 0; i < 5; i++) {
    meeting(alice, `mine${i}`, { transcript: 'budget and many unrelated words', projectId: 'p-mine' });
  }
  const hits = db.search(alice, { q: 'budget', kind: 'meeting', limit: 5, projectId: 'p-mine' });
  assert.equal(hits.length, 5);
  assert.ok(hits.every((h) => h.meetingId.startsWith('mine')));
});

test('FTS: result count is still capped at limit', () => {
  reset();
  const alice = provision('alice');
  for (let i = 0; i < 30; i++) meeting(alice, `m${i}`, { transcript: 'ledger' });
  assert.equal(db.search(alice, { q: 'ledger', kind: 'meeting', limit: 7 }).length, 7);
});

test('list path: projectId filter runs before LIMIT', () => {
  reset();
  const alice = provision('alice');
  // Older rows belong to the requested project; the newest `cap` do not.
  for (let i = 0; i < 4; i++) meeting(alice, `mine${i}`, { projectId: 'p-mine', date: `2026-01-0${i + 1}` });
  for (let i = 0; i < 30; i++) meeting(alice, `new${i}`, { projectId: 'p-other', date: '2026-06-01' });
  const rows = db.search(alice, { q: '', kind: 'meeting', limit: 10, projectId: 'p-mine' });
  assert.deepEqual(rows.map((r) => r.meetingId).sort(), ['mine0', 'mine1', 'mine2', 'mine3']);
});

test('list path: malformed source meta is excluded from a project filter, not an error', () => {
  reset();
  const alice = provision('alice');
  const insert = db.getDb().prepare(
    `INSERT INTO sources (kind, ref, title, body, meta, user_id) VALUES ('ticket', ?, ?, 'b', ?, ?)`,
  );
  insert.run('ok', 'ok', JSON.stringify({ projectId: 'p1' }), alice);
  insert.run('bad', 'bad', '{not json', alice);
  const rows = db.search(alice, { q: '', kind: 'ticket', projectId: 'p1' });
  assert.deepEqual(rows.map((r) => r.ref), ['ok']);
  // Unfiltered listing still includes it.
  assert.equal(db.search(alice, { q: '', kind: 'ticket' }).length, 2);
});

// Code rows carry no project tag, so the agent's search-kb scopes them to the
// open workspace by path. Measured 2026-10-16 on a real 5-repo index: filtering
// after the LIMIT returned 0 hits for 6 of 30 queries whose matches existed in
// the workspace, because other repos' chunks filled the fetched window.
function codeRow(userId, ref, body) {
  db.getDb().prepare(
    `INSERT INTO sources (kind, ref, title, body, meta, user_id) VALUES ('code', ?, ?, ?, '{}', ?)`,
  ).run(ref, ref, body, userId);
}

test('FTS: codeRoot keeps in-workspace code hits ranked below a deep window of other repos', () => {
  reset();
  const alice = provision('alice');
  // 500 > the deepest overshoot window for a page of 10, so only a filter
  // applied before the LIMIT can reach the workspace's rows.
  for (let i = 0; i < 500; i++) codeRow(alice, `/other/repo/f${i}.ts`, 'graphnode graphnode graphnode graphnode');
  for (let i = 0; i < 3; i++) codeRow(alice, `/work/proj/src/f${i}.ts`, 'graphnode among many other unrelated words');
  const hits = db.search(alice, { q: 'graphnode', limit: 10, codeRoot: '/work/proj' });
  assert.deepEqual(hits.map((h) => h.ref).sort(), [
    '/work/proj/src/f0.ts', '/work/proj/src/f1.ts', '/work/proj/src/f2.ts',
  ]);
});

test('FTS: codeRoot matches whole path segments only and leaves non-code kinds alone', () => {
  reset();
  const alice = provision('alice');
  codeRow(alice, '/work/proj/a.ts', 'ledgerline');
  codeRow(alice, '/work/proj-other/b.ts', 'ledgerline');
  codeRow(alice, '/work/proj_x/c.ts', 'ledgerline');
  meeting(alice, 'm1', { transcript: 'ledgerline in a meeting' });
  const hits = db.search(alice, { q: 'ledgerline', limit: 10, codeRoot: '/work/proj' });
  assert.deepEqual(hits.filter((h) => h.kind === 'code').map((h) => h.ref), ['/work/proj/a.ts']);
  assert.ok(hits.some((h) => h.kind === 'meeting'), 'meeting hits are not path-scoped');
});

test('LIKE path (query shorter than a trigram): codeRoot still scopes code hits', () => {
  reset();
  const alice = provision('alice');
  for (let i = 0; i < 500; i++) codeRow(alice, `/other/repo/f${i}.ts`, 'qz qz qz');
  codeRow(alice, '/work/p%_\\x/a.ts', 'qz once');
  const hits = db.search(alice, { q: 'qz', limit: 10, codeRoot: '/work/p%_\\x/' });
  assert.deepEqual(hits.map((h) => h.ref), ['/work/p%_\\x/a.ts']);
});
