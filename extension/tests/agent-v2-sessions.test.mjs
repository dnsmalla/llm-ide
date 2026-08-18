// Tests for the agent_sessions mapping (kb/agent-sessions.mjs) — the table
// that binds a Mac ChatSession UUID to the Claude Agent SDK session id so
// subsequent turns resume the same server-side SDK conversation.
//
// Hermetic: scratch DB (applyMigrations runs on first getDb), no network,
// no SDK subprocess. Pins the exact contract the v2 engine (Task 7)
// consumes: create→null sdk id, mark-used upsert, per-user tenancy,
// replace→fresh start, delete→returns the row's sdkSessionId for cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-sessions-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const {
  getOrCreateAgentSession,
  markAgentSessionUsed,
  replaceAgentSession,
  deleteAgentSession,
} = await import('../kb/agent-sessions.mjs');

test('agent_sessions: create, mark used, replace, delete', () => {
  const db = getDb();
  const u = registerUser(db, { email: 'v2sess@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const u2 = registerUser(db, { email: 'v2sess-other@example.com', password: 'CorrectHorseBattery', displayName: 'o' });

  // Fresh mapping has no sdk session yet — the engine mints one on turn 1.
  const row1 = getOrCreateAgentSession(db, u.id, 'chat-1', 'explorer');
  assert.equal(row1.sdk_session_id, null);
  assert.equal(row1.model, null);
  assert.equal(row1.last_mode, null);

  // First turn records the sdk id (upsert on the existing row).
  markAgentSessionUsed(db, u.id, 'chat-1', { sdkSessionId: 'sdk-1', model: 'claude-sonnet-5', mode: 'execute' });
  const row2 = getOrCreateAgentSession(db, u.id, 'chat-1', 'explorer');
  assert.equal(row2.sdk_session_id, 'sdk-1');
  assert.equal(row2.id, row1.id, 'mark-used upserts, never re-creates');
  assert.equal(row2.model, 'claude-sonnet-5');
  assert.equal(row2.last_mode, 'execute');

  // Tenancy: another user's chat with the same id is a different row.
  const other = getOrCreateAgentSession(db, u2.id, 'chat-1', 'explorer');
  assert.notEqual(other.id, row2.id);
  assert.equal(other.sdk_session_id, null);

  // Replace nulls the sdk id for a fresh start, keeping the same row.
  replaceAgentSession(db, u.id, 'chat-1');
  assert.equal(getOrCreateAgentSession(db, u.id, 'chat-1', 'explorer').sdk_session_id, null);

  // Delete returns the row's sdkSessionId so the caller can clean transcripts.
  assert.equal(deleteAgentSession(db, u.id, 'chat-1').sdkSessionId, null); // already nulled by replace
  // The load-bearing return path: a row holding a LIVE sdk id hands that id
  // back on delete — Task 7 uses it to clean up SDK transcripts.
  markAgentSessionUsed(db, u.id, 'chat-1', { sdkSessionId: 'sdk-2', model: 'claude-sonnet-5', mode: 'execute' });
  assert.equal(deleteAgentSession(db, u.id, 'chat-1').sdkSessionId, 'sdk-2');
  // Row is gone — a subsequent getOrCreate mints a new one.
  const row3 = getOrCreateAgentSession(db, u.id, 'chat-1', 'explorer');
  assert.notEqual(row3.id, row2.id);
  // Deleting a mapping that never existed returns null.
  assert.equal(deleteAgentSession(db, u2.id, 'no-such-chat'), null);
});
