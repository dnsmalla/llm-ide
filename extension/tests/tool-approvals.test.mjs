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
