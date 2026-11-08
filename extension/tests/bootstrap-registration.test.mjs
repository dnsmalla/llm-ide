// P2.6: a one-time bootstrap token creates the first owner on a closed hub. One use only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_HUB = '1';
process.env.LLMIDE_DISABLE_REGISTRATION = '1';
process.env.LLMIDE_BOOTSTRAP_TOKEN = 'c'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-bootstrap-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'data.db');

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { getMember } = await import('../kb/members.mjs');

after(() => {
  try { closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const reg = (email, extra = {}) => registerUser(getDb(), { email, password: 'CorrectHorseBattery', displayName: 'x', ...extra });

test('bootstrap creates only the first owner', () => {
  const u = reg('owner@example.com', { bootstrap: 'c'.repeat(64) });
  const m = getMember(getDb(), u.id);
  assert.equal(m.teamRole, 'owner');
  assert.equal(m.maxMode, 'execute');
  assert.equal(m.usdCapMonth, 0);
  assert.throws(() => reg('second@example.com', { bootstrap: 'c'.repeat(64) }), /Registration is disabled/);
});

test('a wrong or absent bootstrap is refused while registration is closed', () => {
  assert.throws(() => reg('wrong@example.com', { bootstrap: 'd'.repeat(64) }), /Registration is disabled/);
  assert.throws(() => reg('absent@example.com'), /Registration is disabled/);
});
