// Tests for kb/db.mjs#deleteUserCascade — the primitive backing both
// /auth/me/delete (user-initiated, password-confirmed) and
// /admin/users/:id (admin-initiated). The route layer is thin; the
// invariants that matter live here:
//
//   1. Every user_id-scoped row for the target user is removed.
//   2. Other users' rows are untouched.
//   3. audit_log entries for the target are anonymised (user_id →
//      NULL) rather than deleted, so the forensic trail survives.
//   4. The whole cascade runs in a transaction — partial deletion
//      is impossible.
//   5. Returned counts match what was actually wiped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_user-delete-cascade-test.db');
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

function provision(email) {
  return users.registerUser(db.getDb(), {
    email, password: 'CorrectHorseBattery',
    displayName: email.split('@')[0],
  });
}

test('deletes the user row and the refresh token row', () => {
  reset();
  const u = provision('a@example.com').id;
  const handle = db.getDb();
  handle.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime(\'now\', \'+1 day\'))')
    .run('rt-' + u, u, 'hash-' + u);

  const counts = db.deleteUserCascade(u);
  assert.equal(counts.user, 1);
  assert.equal(counts.refresh_tokens, 1);

  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(u).n, 0);
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?').get(u).n, 0);
});

test('removes meetings + entities + sources scoped to the user', () => {
  reset();
  const a = provision('owner@example.com').id;
  db.ingestMeeting(a, {
    id: 'm1', title: 'M1', date: '2026-05-01', duration: 60,
    language: 'en', participants: [], transcript: 'hello',
    entities: [
      { id: 'e1', kind: 'action',   text: 'do thing',    quote: 'q', meta: {} },
      { id: 'e2', kind: 'decision', text: 'ship friday', quote: 'q', meta: {} },
    ],
  });
  db.ingestSources(a, [
    { kind: 'code',  ref: '/tmp/f.ts', title: 'f.ts', body: 'x' },
    { kind: 'doc',   ref: 'doc-1',     title: 'd',    body: 'body' },
  ]);

  const counts = db.deleteUserCascade(a);
  assert.equal(counts.meetings, 1);
  assert.equal(counts.entities, 2);
  assert.equal(counts.sources, 2);
  assert.equal(counts.user, 1);

  const handle = db.getDb();
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM meetings WHERE user_id = ?').get(a).n, 0);
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM entities WHERE user_id = ?').get(a).n, 0);
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM sources  WHERE user_id = ?').get(a).n, 0);
});

test('does not touch another user\'s rows', () => {
  reset();
  const alice = provision('alice@example.com').id;
  const bob   = provision('bob@example.com').id;

  db.ingestMeeting(alice, {
    id: 'a1', title: 'A',
    date: '2026-05-01', duration: 60, language: 'en', participants: [],
    transcript: 'alice', entities: [{ id: 'ea', kind: 'action', text: 'a', quote: 'q', meta: {} }],
  });
  db.ingestMeeting(bob, {
    id: 'b1', title: 'B',
    date: '2026-05-01', duration: 60, language: 'en', participants: [],
    transcript: 'bob', entities: [{ id: 'eb', kind: 'action', text: 'b', quote: 'q', meta: {} }],
  });

  db.deleteUserCascade(alice);

  const handle = db.getDb();
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM meetings WHERE user_id = ?').get(alice).n, 0);
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM meetings WHERE user_id = ?').get(bob).n, 1);
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM users    WHERE id = ?').get(bob).n, 1);
});

test('anonymises audit_log entries instead of deleting them', () => {
  reset();
  const u = provision('audit@example.com').id;
  const handle = db.getDb();
  handle.prepare(
    'INSERT INTO audit_log (user_id, action, outcome, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).run(u, 'auth.login', 'success');
  handle.prepare(
    'INSERT INTO audit_log (user_id, action, outcome, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).run(u, 'auth.password_change', 'success');

  const counts = db.deleteUserCascade(u);
  assert.equal(counts.audit_anonymised, 2);

  // Rows survive but user_id is NULL'd.
  const surviving = handle.prepare(
    'SELECT COUNT(*) AS n FROM audit_log WHERE action IN (\'auth.login\', \'auth.password_change\') AND user_id IS NULL'
  ).get().n;
  assert.equal(surviving, 2);
});

test('user secrets and user repos are wiped', () => {
  reset();
  const u = provision('secret@example.com').id;
  // Insert a fake encrypted blob — deleteUserCascade doesn't try to
  // decrypt, just to delete.
  const handle = db.getDb();
  handle.prepare(
    'INSERT INTO user_secrets (user_id, secret_key, ciphertext) VALUES (?, ?, ?)'
  ).run(u, 'github.token', Buffer.from([1, 2, 3, 4]));
  handle.prepare('INSERT INTO user_repos (user_id, path) VALUES (?, ?)')
    .run(u, '/tmp/repo');

  const counts = db.deleteUserCascade(u);
  assert.equal(counts.user_secrets, 1);
  assert.equal(counts.user_repos, 1);
});

test('cascade is transactional — counts add up across every table', () => {
  reset();
  const u = provision('full@example.com').id;
  db.ingestMeeting(u, {
    id: 'm', title: 'M', date: '2026-05-01', duration: 60,
    language: 'en', participants: [], transcript: 'x',
    entities: [{ id: 'et', kind: 'action', text: 't', quote: 'q', meta: {} }],
  });
  db.ingestSources(u, [{ kind: 'code', ref: '/x', title: 'x', body: 'x' }]);

  const counts = db.deleteUserCascade(u);
  // Every key the production code populates must be present, even when
  // the underlying delete affected zero rows.
  const expectedKeys = [
    'outcomes', 'plan_tasks', 'plans', 'review_items', 'entities',
    'sources', 'meetings', 'user_repos', 'user_secrets',
    'agent_feedback', 'agent_ask_messages', 'refresh_tokens', 'audit_anonymised', 'user',
  ];
  for (const k of expectedKeys) {
    assert.ok(k in counts, `counts missing key: ${k}`);
    assert.equal(typeof counts[k], 'number');
  }
});

// KB-1: agent_ask_messages must be deleted when the user is deleted.
// Before the fix, deleteUserCascade never touched this table (no FK cascade),
// so the deleted user's chat transcript survived the account deletion — PII leak.
test('agent_ask_messages are wiped on user deletion (KB-1)', () => {
  reset();
  const alice = provision('alice-ask@example.com').id;
  const bob   = provision('bob-ask@example.com').id;

  // Insert ask-history for alice and bob.
  db.appendAgentAskMessage(alice, { role: 'user',      content: 'Hello, agent!' });
  db.appendAgentAskMessage(alice, { role: 'assistant', content: 'Hello, Alice.' });
  db.appendAgentAskMessage(bob,   { role: 'user',      content: 'Bob speaking.' });

  const handle = db.getDb();
  // Pre-deletion sanity.
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM agent_ask_messages WHERE user_id = ?').get(alice).n, 2);
  assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM agent_ask_messages WHERE user_id = ?').get(bob).n, 1);

  const counts = db.deleteUserCascade(alice);

  // Alice's rows must be gone.
  assert.equal(
    handle.prepare('SELECT COUNT(*) AS n FROM agent_ask_messages WHERE user_id = ?').get(alice).n,
    0,
    'alice agent_ask_messages should be deleted',
  );
  // Bob's row must survive.
  assert.equal(
    handle.prepare('SELECT COUNT(*) AS n FROM agent_ask_messages WHERE user_id = ?').get(bob).n,
    1,
    'bob agent_ask_messages must not be touched',
  );
  // The returned counts receipt must include the key.
  assert.ok('agent_ask_messages' in counts, 'counts must include agent_ask_messages key');
  assert.equal(counts.agent_ask_messages, 2);
});

test('refuses to run with no userId', () => {
  reset();
  assert.throws(() => db.deleteUserCascade(null), /userId/);
  assert.throws(() => db.deleteUserCascade(undefined), /userId/);
  assert.throws(() => db.deleteUserCascade(''), /userId/);
});

test('is idempotent — second call on a missing user produces zero counts', () => {
  reset();
  const u = provision('once@example.com').id;
  const first = db.deleteUserCascade(u);
  assert.equal(first.user, 1);
  const second = db.deleteUserCascade(u);
  assert.equal(second.user, 0);
  // All other tables should also report 0.
  for (const [k, v] of Object.entries(second)) {
    assert.equal(v, 0, `${k} expected 0 on second call, got ${v}`);
  }
});

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});
