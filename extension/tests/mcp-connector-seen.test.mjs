// Tests for the per-user, per-connector MCP dedup ledger (migration 0031).
// Twin of the slack_seen ledger; setup mirrors tests/kb-router-slack.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_mcp-connector-seen-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

let n = 0;
const newUser = () => users.registerUser(db.getDb(), {
  email: `mcp-seen-${Date.now()}-${++n}@example.com`,
  password: 'CorrectHorseBattery', displayName: 'T',
});

test('the ledger round-trips and is idempotent', () => {
  const u = newUser().id;
  assert.deepEqual(db.getMcpConnectorSeenIds(u, 'miro'), []);
  assert.equal(db.markMcpConnectorSeen(u, 'miro', ['a', 'b']), 2);
  assert.deepEqual(db.getMcpConnectorSeenIds(u, 'miro').sort(), ['a', 'b']);
  // Re-marking is a harmless no-op — the composite PK dedups, so a retried
  // markSeen after a partial note-write must not error or double-count.
  assert.equal(db.markMcpConnectorSeen(u, 'miro', ['a', 'b', 'c']), 1);
  assert.deepEqual(db.getMcpConnectorSeenIds(u, 'miro').sort(), ['a', 'b', 'c']);
});

test('the ledger is scoped by BOTH user and connector', () => {
  const a = newUser().id;
  const b = newUser().id;
  db.markMcpConnectorSeen(a, 'miro', ['shared-id']);
  assert.deepEqual(db.getMcpConnectorSeenIds(b, 'miro'), [],
    'another user must not inherit a seen mark');
  assert.deepEqual(db.getMcpConnectorSeenIds(a, 'gdrive'), [],
    'a different connector reusing the same item id must not be suppressed');
});

test('junk input is filtered, not persisted', () => {
  const u = newUser().id;
  assert.equal(db.markMcpConnectorSeen(u, 'miro', ['ok', '', null, 42, undefined]), 1);
  assert.deepEqual(db.getMcpConnectorSeenIds(u, 'miro'), ['ok']);
  assert.equal(db.markMcpConnectorSeen(u, 'miro', 'not-an-array'), 0);
  assert.equal(db.markMcpConnectorSeen(u, 'miro', []), 0);
});

test('deleting a user wipes their ledger and reports the count', () => {
  const a = newUser().id;
  const b = newUser().id;
  db.markMcpConnectorSeen(a, 'miro', ['x', 'y']);
  db.markMcpConnectorSeen(b, 'miro', ['z']);

  const counts = db.deleteUserCascade(a);
  assert.equal(counts.mcp_connector_seen, 2,
    'the cascade must name this table explicitly — there is no FK cascade');
  assert.deepEqual(db.getMcpConnectorSeenIds(b, 'miro'), ['z'],
    'the other user is untouched');
});
