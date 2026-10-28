// agent.db corruption handling (plan T1.5): quarantine under a unique name,
// never overwrite an earlier quarantine (K1a rule), recreate and keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const agent = await import('../kb/agent-db.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-corrupt-'));
const file = path.join(tmp, 'agent.db');
const GARBAGE = Buffer.alloc(8192, 'x');
const quarantines = () => fs.readdirSync(tmp).filter((f) => f.startsWith('agent.db.corrupt-') && !f.endsWith('-wal') && !f.endsWith('-shm')).sort();

function plantGarbage() {
  agent.closeAgentDb();
  agent.setAgentDbForTests(null);
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  fs.writeFileSync(file, GARBAGE);
}

test('garbage bytes at the store path are quarantined and a fresh store opens', () => {
  plantGarbage();
  const db = agent.openAgentDb({ file });
  assert.ok(db, 'boot does not fail');
  assert.equal(quarantines().length, 1);
  assert.ok(fs.readFileSync(path.join(tmp, quarantines()[0])).equals(GARBAGE), 'the damaged bytes are kept for inspection');
  assert.ok(agent.readMeta(db, 'history_reset_at'), 'the reset is recorded');
  assert.equal(agent.agentStoreStatus().quarantinesThisProcess, 1);
  assert.equal(agent.agentStoreStatus().health, 'degraded');
  // The fresh store works.
  assert.equal(agent.enqueueAgentWrite('activity', 'INSERT INTO activity (user_id, kind, title) VALUES (?,?,?)', ['u', 'k', 't']), true);
  assert.equal(agent.flushAgentQueue(), 1);
  agent.closeAgentDb();
});

test('quarantinePath never picks a name that is already taken', () => {
  const when = new Date('2026-10-28T10:00:00.000Z');
  const stamp = when.toISOString().replace(/[:.]/g, '-');
  const first = agent.quarantinePath(file, when);
  assert.equal(path.basename(first), `agent.db.corrupt-${stamp}`);
  fs.writeFileSync(first, 'earlier quarantine');
  const second = agent.quarantinePath(file, when);
  assert.equal(path.basename(second), `agent.db.corrupt-${stamp}-2`);
  fs.writeFileSync(second, 'second');
  const third = agent.quarantinePath(file, when);
  assert.equal(path.basename(third), `agent.db.corrupt-${stamp}-3`);
  // A leftover -wal sibling of the candidate also counts as taken.
  fs.writeFileSync(`${third}-wal`, 'x');
  const fourth = agent.quarantinePath(file, when);
  assert.equal(path.basename(fourth), `agent.db.corrupt-${stamp}-4`);
  assert.equal(fs.readFileSync(first, 'utf8'), 'earlier quarantine');
  for (const f of fs.readdirSync(tmp).filter((n) => n.includes(`corrupt-${stamp}`))) fs.rmSync(path.join(tmp, f));
});

test('a second corruption adds a second quarantine and keeps the first', () => {
  plantGarbage();
  const first = agent.openAgentDb({ file });
  assert.ok(first);
  agent.closeAgentDb();
  fs.writeFileSync(file, Buffer.alloc(8192, 'y'));
  const second = agent.openAgentDb({ file });
  assert.ok(second, 'still boots');
  const names = quarantines();
  assert.equal(names.length, 2, `expected two quarantines, got ${names.join(', ')}`);
  const contents = names.map((n) => fs.readFileSync(path.join(tmp, n), 'utf8')[0]).sort();
  assert.deepEqual(contents, ['x', 'y'], 'neither quarantine was overwritten');
  agent.closeAgentDb();
});

test('a corrupt error during a flush quarantines the file and the store keeps working', () => {
  plantGarbage();
  const real = agent.openAgentDb({ file });
  assert.ok(real);
  agent.closeAgentDb();
  // Reopen, then wrap the handle so the next write reports corruption, the
  // way SQLite does when a page is damaged under an open connection.
  const handle = agent.openAgentDb({ file });
  const beforeFlush = quarantines().length; // the garbage above is already set aside
  const corrupt = Object.create(handle);
  corrupt.transaction = () => () => {
    const err = new Error('database disk image is malformed');
    err.code = 'SQLITE_CORRUPT';
    throw err;
  };
  agent.setAgentDbForTests(corrupt, { file });
  agent.enqueueAgentWrite('activity', 'INSERT INTO activity (user_id, kind, title) VALUES (?,?,?)', ['u', 'k', 't']);
  assert.equal(agent.flushAgentQueue(), 0, 'the lost batch is counted, not thrown');
  assert.equal(quarantines().length, beforeFlush + 1, 'the damaged file was set aside');
  assert.equal(agent.agentStoreStatus().state, 'ok', 'a fresh store replaced it');
  assert.equal(agent.enqueueAgentWrite('activity', 'INSERT INTO activity (user_id, kind, title) VALUES (?,?,?)', ['u', 'k', 'after']), true);
  assert.equal(agent.flushAgentQueue(), 1);
  agent.closeAgentDb();
});
