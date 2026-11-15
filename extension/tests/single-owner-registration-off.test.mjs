// Flag off (LLMIDE_REGISTRATION_SINGLE_OWNER unset): registration stays as it was. Dev default is open,
// so a second account is accepted and the reported open value does not change after the first owner.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
delete process.env.LLMIDE_REGISTRATION_SINGLE_OWNER;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-open-reg-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'data.db');

const { config } = await import('../core/config.mjs');
const { registerUser, selfRegistrationOpen } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');

after(() => {
  try { closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const reg = (email) => registerUser(getDb(), { email, password: 'CorrectHorseBattery', displayName: 'x' });

test('the flag is off by default', () => {
  assert.equal(config.registrationSingleOwner, false);
});

test('with the flag off, registration stays open after the first owner', () => {
  reg('first@example.com');
  assert.equal(selfRegistrationOpen(getDb()), true);
  assert.doesNotThrow(() => reg('second@example.com'));
});
