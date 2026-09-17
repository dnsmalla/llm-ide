// Pins the invariant that the `meetings` SQLite row for a live-captured
// session never outlives the live session itself — see the file header
// of agents/live-sessions.mjs. The DB row is crash-recovery only; the
// durable copy is the Mac app's raw .md file, built from the live mirror.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_live-sessions-db-cleanup-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const liveSessions = await import('../agents/live-sessions.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  liveSessions._resetForTests();
  // meetings.user_id is a foreign key — register a real user row so
  // ingestMeeting (simulating the periodic flush) doesn't violate it.
  return users.registerUser(db.getDb(), {
    email: `live-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'live-sessions test user',
  }).id;
}

test('finalizeSession deletes the periodic-flush meetings row', () => {
  const userId = resetDb();
  liveSessions.appendCaptions(userId, 'sess-A', [
    { speaker: 'Alice', text: 'hello', ts: Date.now(), source: 'extension-cc' },
  ]);
  // Simulate the 60s periodic flush that runs while the session is live.
  db.ingestMeeting(userId, {
    id: 'sess-A',
    title: 'Standup',
    date: new Date().toISOString(),
    duration: 30,
    participants: ['Alice'],
    transcript: '[00:00:00] Alice: hello',
    entities: [],
  });
  assert.ok(db.getMeeting(userId, 'sess-A'), 'row exists before finalize');

  const result = liveSessions.finalizeSession(userId, 'sess-A');
  assert.equal(result.finalized, true);
  assert.equal(result.dbCleaned, true);
  assert.equal(db.getMeeting(userId, 'sess-A'), null, 'row must not outlive the live session');
});

test('finalizeSession succeeds even when no periodic flush ever happened', () => {
  const userId = resetDb();
  liveSessions.appendCaptions(userId, 'sess-B', [
    { speaker: 'Bob', text: 'quick meeting', ts: Date.now(), source: 'extension-cc' },
  ]);
  const result = liveSessions.finalizeSession(userId, 'sess-B');
  assert.equal(result.finalized, true);
  assert.equal(result.dbCleaned, true);
  assert.equal(db.getMeeting(userId, 'sess-B'), null);
});

test('TTL eviction of an abandoned (never-finalized) session also cleans its DB row', () => {
  const userId = resetDb();
  liveSessions.appendCaptions(userId, 'sess-C', [
    { speaker: 'Carol', text: 'still going', ts: Date.now(), source: 'extension-cc' },
  ]);
  // Simulate the periodic flush persisting the row while the session was
  // still live, then the tab crashing (never finalized) and going idle.
  db.ingestMeeting(userId, {
    id: 'sess-C',
    title: 'Crashed meeting',
    date: new Date().toISOString(),
    duration: 10,
    participants: ['Carol'],
    transcript: '[00:00:00] Carol: still going',
    entities: [],
  });
  assert.ok(db.getMeeting(userId, 'sess-C'), 'row exists before eviction');

  liveSessions._backdateForTests(userId, 'sess-C', 31 * 60 * 1000);
  liveSessions._evictNowForTests();

  assert.equal(
    db.getMeeting(userId, 'sess-C'),
    null,
    'an abandoned session must not leak its meetings row forever',
  );
});
