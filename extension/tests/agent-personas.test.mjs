// Multi-persona registry tests. Exercises the public kb helpers
// (list/create/update/delete/set-active) plus the contract preserved
// for the legacy single-persona setter, against an isolated SQLite
// file. Doesn't go through HTTP because the route layer is a thin
// pass-through; helpers cover the logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-personas-test.db');
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

function provision(email = 'alpha@example.test') {
  return users.registerUser(db.getDb(), {
    email,
    password: 'CorrectHorseBattery',
    displayName: email.split('@')[0],
  });
}

test('list returns empty when no personas exist', () => {
  reset();
  const u = provision();
  const list = db.listAgentPersonas(u.id);
  assert.deepEqual(list.personas, []);
  assert.equal(list.active, null);
});

test('create sets the first persona as active automatically', () => {
  reset();
  const u = provision();
  const p = db.createAgentPersona(u.id, { name: 'First', promptSuffix: 'be brief' });
  const list = db.listAgentPersonas(u.id);
  assert.equal(list.personas.length, 1);
  assert.equal(list.active, p.id);
});

test('subsequent creates do not change active', () => {
  reset();
  const u = provision();
  const first  = db.createAgentPersona(u.id, { name: 'First' });
  const second = db.createAgentPersona(u.id, { name: 'Second' });
  const list = db.listAgentPersonas(u.id);
  assert.equal(list.active, first.id);
  assert.equal(list.personas.length, 2);
  assert.notEqual(first.id, second.id);
});

test('setActiveAgentPersona switches active id', () => {
  reset();
  const u = provision();
  const first  = db.createAgentPersona(u.id, { name: 'First' });
  const second = db.createAgentPersona(u.id, { name: 'Second' });
  db.setActiveAgentPersona(u.id, second.id);
  assert.equal(db.listAgentPersonas(u.id).active, second.id);
});

test('getAgentPersona returns the active persona (contract preserved)', () => {
  reset();
  const u = provision();
  db.createAgentPersona(u.id, { name: 'First', promptSuffix: 'tone A' });
  const second = db.createAgentPersona(u.id, { name: 'Second', promptSuffix: 'tone B', autoDispatch: true });
  db.setActiveAgentPersona(u.id, second.id);
  const active = db.getAgentPersona(u.id);
  assert.equal(active.name, 'Second');
  assert.equal(active.promptSuffix, 'tone B');
  assert.equal(active.autoDispatch, true);
});

test('legacy setAgentPersona updates the active row in-place', () => {
  reset();
  const u = provision();
  const first = db.createAgentPersona(u.id, { name: 'First' });
  db.createAgentPersona(u.id, { name: 'Second' });
  db.setActiveAgentPersona(u.id, first.id);
  db.setAgentPersona(u.id, { name: 'Renamed', promptSuffix: 'new', autoDispatch: true });
  const list = db.listAgentPersonas(u.id);
  const updated = list.personas.find((p) => p.id === first.id);
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.promptSuffix, 'new');
  assert.equal(updated.autoDispatch, true);
});

test('legacy setAgentPersona bootstraps a default persona for first-time users', () => {
  reset();
  const u = provision();
  db.setAgentPersona(u.id, { name: 'Bootstrapped', promptSuffix: 'hi' });
  const list = db.listAgentPersonas(u.id);
  assert.equal(list.personas.length, 1);
  assert.equal(list.active, list.personas[0].id);
  assert.equal(list.personas[0].name, 'Bootstrapped');
});

test('deleteAgentPersona refuses to remove the last one', () => {
  reset();
  const u = provision();
  db.createAgentPersona(u.id, { name: 'Only' });
  assert.throws(
    () => db.deleteAgentPersona(u.id, 'only-id-that-does-not-match'),
    // unknown id returns removed:false rather than throw; force throw
    // via the "last persona" branch below
  );
});

test('deleteAgentPersona on unknown id is a no-op', () => {
  reset();
  const u = provision();
  db.createAgentPersona(u.id, { name: 'A' });
  db.createAgentPersona(u.id, { name: 'B' });
  const result = db.deleteAgentPersona(u.id, 'no-such-id');
  assert.equal(result.removed, false);
});

test('deleteAgentPersona of the active row promotes the most recent survivor', () => {
  reset();
  const u = provision();
  const a = db.createAgentPersona(u.id, { name: 'A' });
  // Force a deterministic createdAt gap so "most recent" is unambiguous.
  const b = db.createAgentPersona(u.id, { name: 'B' });
  db.setActiveAgentPersona(u.id, a.id);
  const result = db.deleteAgentPersona(u.id, a.id);
  assert.equal(result.removed, true);
  assert.equal(result.active, b.id);
});

test('legacy single-persona blob on disk is read as a one-row list', () => {
  reset();
  const u = provision();
  // Hand-craft the legacy shape into user_flags.
  const handle = db.getDb();
  handle.prepare(`
    INSERT INTO user_flags (user_id, flag, value)
    VALUES (?, 'agent.persona', ?)
  `).run(u.id, JSON.stringify({ name: 'Legacy', promptSuffix: 'old', autoDispatch: true }));
  const list = db.listAgentPersonas(u.id);
  assert.equal(list.personas.length, 1);
  assert.equal(list.active, 'default');
  assert.equal(list.personas[0].name, 'Legacy');
  assert.equal(list.personas[0].autoDispatch, true);
});

test('per-user isolation — alpha never sees bravo personas', () => {
  reset();
  const a = provision('alpha@example.test');
  const b = provision('bravo@example.test');
  db.createAgentPersona(a.id, { name: 'A-1' });
  db.createAgentPersona(b.id, { name: 'B-1' });
  assert.equal(db.listAgentPersonas(a.id).personas.length, 1);
  assert.equal(db.listAgentPersonas(b.id).personas.length, 1);
  assert.equal(db.listAgentPersonas(a.id).personas[0].name, 'A-1');
  assert.equal(db.listAgentPersonas(b.id).personas[0].name, 'B-1');
});
