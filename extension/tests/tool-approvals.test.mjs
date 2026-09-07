import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_tool-approvals-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

test('a tool starts with no always-allow row', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { hasAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  assert.equal(hasAlwaysAllow(u.id, 'run-bash'), false);
});

test('setAlwaysAllow persists, scoped per (user, tool)', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { hasAlwaysAllow, setAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const other = registerUser(getDb(), { email: 'toolapprovals3@example.com', password: 'CorrectHorseBattery', displayName: 'o' });
  setAlwaysAllow(u.id, 'run-bash');
  assert.equal(hasAlwaysAllow(u.id, 'run-bash'), true);
  assert.equal(hasAlwaysAllow(u.id, 'task-create'), false, 'always-allow is per-tool, not global');
  assert.equal(hasAlwaysAllow(other.id, 'run-bash'), false, 'always-allow is per-user');
});

test('setAlwaysAllow is idempotent (no unique-constraint error on repeat)', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { setAlwaysAllow, hasAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals4@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAlwaysAllow(u.id, 'run-bash');
  setAlwaysAllow(u.id, 'run-bash');
  assert.equal(hasAlwaysAllow(u.id, 'run-bash'), true);
});

// Revocation. "Always Allow" used to be a one-way door — granted once, with
// no list, no delete and no route, so a standing permission to run shell
// commands could never be withdrawn from any surface.

test('listAlwaysAllow reports the grants with their timestamps, per user', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { setAlwaysAllow, listAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals5@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const other = registerUser(getDb(), { email: 'toolapprovals6@example.com', password: 'CorrectHorseBattery', displayName: 'o' });
  assert.deepEqual(listAlwaysAllow(u.id), [], 'no grants to start');
  setAlwaysAllow(u.id, 'run-bash');
  setAlwaysAllow(other.id, 'task-create');
  const mine = listAlwaysAllow(u.id);
  assert.deepEqual(mine.map((a) => a.toolName), ['run-bash'], 'only this user\'s grants');
  assert.match(mine[0].grantedAt, /^\d{4}-\d{2}-\d{2}T/, 'grantedAt is an ISO timestamp');
});

test('clearAlwaysAllow revokes exactly one tool and reports whether it removed anything', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { setAlwaysAllow, hasAlwaysAllow, clearAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals7@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAlwaysAllow(u.id, 'run-bash');
  setAlwaysAllow(u.id, 'task-create');
  assert.equal(clearAlwaysAllow(u.id, 'run-bash'), true, 'reports the removal');
  assert.equal(hasAlwaysAllow(u.id, 'run-bash'), false, 'the grant is gone');
  assert.equal(hasAlwaysAllow(u.id, 'task-create'), true, 'the other grant survives');
  assert.equal(clearAlwaysAllow(u.id, 'run-bash'), false, 'revoking twice removes nothing the second time');
});

test('clearAlwaysAllow cannot revoke another user\'s grant', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const { setAlwaysAllow, hasAlwaysAllow, clearAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals8@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const other = registerUser(getDb(), { email: 'toolapprovals9@example.com', password: 'CorrectHorseBattery', displayName: 'o' });
  setAlwaysAllow(other.id, 'run-bash');
  assert.equal(clearAlwaysAllow(u.id, 'run-bash'), false);
  assert.equal(hasAlwaysAllow(other.id, 'run-bash'), true, 'the owner keeps their grant');
});

test('clearAllAlwaysAllow revokes only the calling user\'s grants', async () => {
  const { registerUser } = await import('../server/users.mjs');
  const { getDb } = await import('../kb/db.mjs');
  const {
    setAlwaysAllow, hasAlwaysAllow, clearAllAlwaysAllow, listAlwaysAllow,
  } = await import('../kb/tool-approvals.mjs');
  const u = registerUser(getDb(), { email: 'toolapprovals10@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const other = registerUser(getDb(), { email: 'toolapprovals11@example.com', password: 'CorrectHorseBattery', displayName: 'o' });
  setAlwaysAllow(u.id, 'run-bash');
  setAlwaysAllow(u.id, 'task-create');
  setAlwaysAllow(other.id, 'run-bash');
  assert.equal(clearAllAlwaysAllow(u.id), 2, 'reports how many were removed');
  assert.deepEqual(listAlwaysAllow(u.id), []);
  assert.equal(hasAlwaysAllow(other.id, 'run-bash'), true, 'another user is untouched');
});
