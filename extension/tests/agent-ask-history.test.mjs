// Persistence tests for the Ask-the-Agent sheet history (Cmd-Shift-A).
//
// Exercises the public kb helpers — append, list, clear — against an
// isolated SQLite file, asserting both ordering (oldest-first within
// the listing window) and per-user isolation (one user's transcript
// must never leak into another's). Doesn't go through the HTTP route
// because that's a thin pass-through; if the helpers hold, the route
// holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-ask-history-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function provision(email) {
  return users.registerUser(db.getDb(), {
    email,
    password: 'CorrectHorseBattery',
    displayName: email.split('@')[0],
  });
}

test('append then list returns chronological order (oldest first)', () => {
  reset();
  const a = provision('alpha@example.test');
  db.appendAgentAskMessage(a.id, { role: 'user',      content: 'first ask' });
  db.appendAgentAskMessage(a.id, { role: 'assistant', content: 'first reply' });
  db.appendAgentAskMessage(a.id, { role: 'user',      content: 'second ask' });

  const msgs = db.listAgentAskMessages(a.id);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content, 'first ask');
  assert.equal(msgs[2].content, 'second ask');
  assert.ok(msgs[2].seq > msgs[0].seq);
});

test('list respects limit and returns the newest window oldest-first', () => {
  reset();
  const a = provision('alpha@example.test');
  for (let i = 0; i < 10; i++) {
    db.appendAgentAskMessage(a.id, { role: 'user', content: `msg-${i}` });
  }
  const msgs = db.listAgentAskMessages(a.id, { limit: 3 });
  assert.equal(msgs.length, 3);
  // Newest 3 should be msg-7, msg-8, msg-9 in order.
  assert.equal(msgs[0].content, 'msg-7');
  assert.equal(msgs[2].content, 'msg-9');
});

test('per-user isolation — alpha never sees bravo history', () => {
  reset();
  const a = provision('alpha@example.test');
  const b = provision('bravo@example.test');
  db.appendAgentAskMessage(a.id, { role: 'user', content: 'alpha secret' });
  db.appendAgentAskMessage(b.id, { role: 'user', content: 'bravo secret' });

  const aMsgs = db.listAgentAskMessages(a.id);
  const bMsgs = db.listAgentAskMessages(b.id);
  assert.equal(aMsgs.length, 1);
  assert.equal(bMsgs.length, 1);
  assert.equal(aMsgs[0].content, 'alpha secret');
  assert.equal(bMsgs[0].content, 'bravo secret');
});

test('clearAgentAskMessages wipes only the calling user', () => {
  reset();
  const a = provision('alpha@example.test');
  const b = provision('bravo@example.test');
  db.appendAgentAskMessage(a.id, { role: 'user', content: 'a1' });
  db.appendAgentAskMessage(a.id, { role: 'user', content: 'a2' });
  db.appendAgentAskMessage(b.id, { role: 'user', content: 'b1' });

  const result = db.clearAgentAskMessages(a.id);
  assert.equal(result.removed, 2);
  assert.equal(db.listAgentAskMessages(a.id).length, 0);
  assert.equal(db.listAgentAskMessages(b.id).length, 1);
});

test('append rejects unknown roles', () => {
  reset();
  const a = provision('alpha@example.test');
  assert.throws(
    () => db.appendAgentAskMessage(a.id, { role: 'system', content: 'x' }),
    /role must be/,
  );
});

test('append rejects empty content', () => {
  reset();
  const a = provision('alpha@example.test');
  assert.throws(
    () => db.appendAgentAskMessage(a.id, { role: 'user', content: '' }),
    /content is required/,
  );
});

// KB-4: created_at must be stored as a numeric unix epoch (REAL column),
// not an ISO string.  The migration schema declares it REAL NOT NULL.
test('appended message stores created_at as a numeric unix epoch', () => {
  reset();
  const a = provision('alpha@example.test');
  const before = Date.now() / 1000;
  db.appendAgentAskMessage(a.id, { role: 'user', content: 'epoch check' });
  const after = Date.now() / 1000;

  const raw = db.getDb().prepare(
    'SELECT created_at FROM agent_ask_messages WHERE user_id = ? ORDER BY seq DESC LIMIT 1',
  ).get(a.id);
  assert.ok(raw, 'row must exist');
  assert.equal(typeof raw.created_at, 'number',
    `created_at must be numeric (REAL), got ${typeof raw.created_at}: ${raw.created_at}`);
  assert.ok(raw.created_at >= before && raw.created_at <= after + 1,
    `created_at ${raw.created_at} must be in unix-seconds range [${before}, ${after + 1}]`);
});
