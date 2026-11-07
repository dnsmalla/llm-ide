// Plan H1.2 Task 1: registerUser writes the members row itself, so no code path creates an account
// without team authority (ADR 0021: no row = refused).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_register-grant-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { getMember } = await import('../kb/members.mjs');

after(() => {
  try { closeDb(); } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});

const reg = (email, extra = {}) => registerUser(getDb(), { email, password: 'CorrectHorseBattery', displayName: 'x', ...extra });

test('the first account is the owner with execute and no cap', () => {
  const u = reg('first@example.com');
  assert.deepEqual(getMember(getDb(), u.id), { userId: u.id, teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
});

test('a later account without an invite gets the solo default: member, execute, no cap', () => {
  const u = reg('second@example.com');
  const m = getMember(getDb(), u.id);
  assert.equal(m.teamRole, 'member');
  assert.equal(m.maxMode, 'execute');
  assert.equal(m.usdCapMonth, 0);
});

test('an explicit grant is written as given', () => {
  const owner = getDb().prepare("SELECT user_id FROM members WHERE team_role = 'owner'").get().user_id;
  const u = reg('third@example.com', { grant: { teamRole: 'viewer', maxMode: 'read_only', usdCapMonth: 20, grantedBy: owner } });
  const m = getMember(getDb(), u.id);
  assert.equal(m.teamRole, 'viewer');
  assert.equal(m.maxMode, 'read_only');
  assert.equal(m.usdCapMonth, 20);
});

test('a failed registration leaves no members row behind', () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM members').get().n;
  assert.throws(() => reg('second@example.com'), /already registered/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM members').get().n, before);
});
