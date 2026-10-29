// Phase 0 (T0.4) of docs/superpowers/plans/2026-10-29-live-then-archive.md.
// Builds a legacy-shaped DB through the real migrations and pins today's
// behaviour the later phases must preserve or consciously change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_lta-legacy-fixtures-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { seedLegacyDb } = await import('./fixtures/lta/build-legacy-db.mjs');
const { getChatSession } = await import('../kb/chat-sessions.mjs');
const { listSessionMemory } = await import('../kb/session-memory.mjs');

function fresh() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) fs.rmSync(f, { force: true });
  const u = users.registerUser(db.getDb(), { email: `lta-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'lta' });
  return { userId: u.id, ...seedLegacyDb(u.id) };
}

test('legacy DB seeds meetings, entities, FTS, chat and working state', () => {
  const s = fresh();
  assert.equal(db.stats(s.userId).meetings, 3);
  assert.equal(db.stats(s.userId).entities, 3);
  const hits = db.search(s.userId, { q: 'rollback', kind: 'meeting' });
  assert.ok(hits.some((h) => h.meetingId === 'm-legacy-en'));
  assert.ok(db.search(s.userId, { q: '予算' }).some((h) => h.meetingId === 'm-legacy-ja'));
  const secret = db.getMeetingTranscript(s.userId, 'm-legacy-secret');
  assert.ok(!secret.includes('sk-ant-api03'), 'transcript is redacted at ingest');
  const chat = getChatSession(s.userId, s.extChatId);
  assert.equal(chat.messages.length, 2);
  assert.equal(listSessionMemory(s.userId, s.macChatId).length, 1);
  const row = db.getDb().prepare('SELECT sdk_session_id FROM agent_sessions WHERE mac_chat_session_id = ?').get(s.macChatId);
  assert.ok(row?.sdk_session_id);
  db.closeDb();
});

test('characterization: deleting a meeting nulls plans.meeting_id (FK SET NULL) and the plan stays', () => {
  const s = fresh();
  db.deleteMeeting(s.userId, 'm-legacy-en');
  const plan = db.getDb().prepare('SELECT meeting_id FROM plans WHERE id = ?').get(s.planId);
  assert.ok(plan, 'plan survives');
  assert.equal(plan.meeting_id, null);
  // entities cascade
  assert.equal(db.getDb().prepare('SELECT COUNT(*) n FROM entities WHERE meeting_id = ?').get('m-legacy-en').n, 0);
  assert.ok(!db.search(s.userId, { q: 'rollback', kind: 'meeting' }).some((h) => h.meetingId === 'm-legacy-en'));
  db.closeDb();
});

test('characterization: the plan keeps its FTS row when its meeting is deleted', () => {
  const s = fresh();
  const count = () => db.getDb().prepare("SELECT COUNT(*) n FROM search WHERE kind = 'plan'").get().n;
  assert.equal(count(), 1);
  db.deleteMeeting(s.userId, 'm-legacy-en');
  assert.equal(count(), 1);
  db.closeDb();
});
