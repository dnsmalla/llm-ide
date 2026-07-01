// Per-user, cross-machine settings blob (getUserSettings / setUserSettings).
// Backs /kb/settings so a new machine restores the same Issues/Gantt view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_user-settings-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db    = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}
let seq = 0;
function provision() {
  return users.registerUser(db.getDb(), {
    email: `us${seq++}@example.test`, password: 'CorrectHorseBattery', displayName: 'us',
  }).id;
}

test('getUserSettings defaults to {} for a fresh user', () => {
  reset();
  const u = provision();
  assert.equal(db.getUserSettings(u), '{}');
});

test('setUserSettings round-trips and overwrites (last write wins)', () => {
  reset();
  const u = provision();
  db.setUserSettings(u, { provider: 'gitlab', savedProjects: ['a', 'b'] });
  assert.deepEqual(JSON.parse(db.getUserSettings(u)), { provider: 'gitlab', savedProjects: ['a', 'b'] });
  db.setUserSettings(u, { provider: 'github' });   // overwrite
  assert.deepEqual(JSON.parse(db.getUserSettings(u)), { provider: 'github' });
});

test('user settings are tenant-scoped', () => {
  reset();
  const a = provision();
  const b = provision();
  db.setUserSettings(a, { provider: 'gitlab' });
  assert.equal(db.getUserSettings(b), '{}', "user B cannot see user A's settings");
});

test('deleteUserCascade removes the settings row', () => {
  reset();
  const u = provision();
  db.setUserSettings(u, { provider: 'gitlab' });
  const counts = db.deleteUserCascade(u);
  assert.ok((counts.user_settings ?? 0) >= 1, 'cascade reports the deleted settings row');
  assert.equal(db.getUserSettings(u), '{}');
});
