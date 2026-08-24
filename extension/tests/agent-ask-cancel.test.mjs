import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-ask-cancel-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

test('retractLastAgentAskMessage removes only the newest matching row', () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `retract-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'r',
  });
  db.appendAgentAskMessage(u.id, { role: 'user', content: 'one' });
  db.appendAgentAskMessage(u.id, { role: 'assistant', content: 'two' });
  db.appendAgentAskMessage(u.id, { role: 'user', content: 'three' });

  assert.equal(db.retractLastAgentAskMessage(u.id, { role: 'user' }), true);
  const rows = db.listAgentAskMessages(u.id, { limit: 10 });
  assert.deepEqual(rows.map((r) => r.content), ['one', 'two']);
});

test('retractLastAgentAskMessage with no rows returns false', () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `retract-empty-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'empty',
  });
  assert.equal(db.retractLastAgentAskMessage(u.id, { role: 'user' }), false);
});
