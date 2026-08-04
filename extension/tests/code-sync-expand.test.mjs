import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-sync-expand-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { codeSync } = await import('../agents/code-sync.mjs');
const { findRelatedSymbols } = await import('../graphkit/index.mjs');

const U = users.registerUser(db.getDb(), {
  email: `cse-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c',
}).id;

test('setup: a tiny graph where Widget <- Button <- Toolbar (references)', () => {
  db.writeCodeGraph(U, '/repo', {
    nodes: [
      { id: 's Widget', title: 'Widget', kind: 'classType', metadata: { source_file: 'w.ts', line: 'L1' } },
      { id: 's Button', title: 'Button', kind: 'classType', metadata: { source_file: 'b.ts', line: 'L2' } },
      { id: 's Toolbar', title: 'Toolbar', kind: 'classType', metadata: { source_file: 't.ts', line: 'L3' } },
    ],
    edges: [
      { fromId: 's Button', toId: 's Widget', kind: 'references', confidence: 'EXTRACTED' },
      { fromId: 's Toolbar', toId: 's Button', kind: 'references', confidence: 'EXTRACTED' },
    ],
  });
});

test('findRelatedSymbols seeds by title and expands 1 hop', () => {
  const syms = findRelatedSymbols(U, 'Button', { hops: 1, limit: 10 });
  const ids = syms.map((s) => s.symbol_id);
  assert.ok(ids.includes('s Button'), 'seed included');
  assert.ok(ids.includes('s Widget'), '1-hop reference target included');
});

test('codeSync attaches a symbols field expanded from each task query', () => {
  const plan = { tasks: [{ title: 'Fix the Button component', description: '' }] };
  const out = codeSync(U, { plan });
  const ids = out.tasks[0].symbols.map((s) => s.symbol_id);
  assert.ok(ids.includes('s Button'));
  assert.ok(ids.includes('s Widget'), 'relationship neighbor pulled in');
  // files field still present (unchanged behavior)
  assert.ok(Array.isArray(out.tasks[0].files));
});

test('codeSync with no graph returns empty symbols (no regression)', () => {
  const U2 = users.registerUser(db.getDb(), {
    email: `cse2-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c2',
  }).id;
  const out = codeSync(U2, { plan: { tasks: [{ title: 'anything', description: '' }] } });
  assert.deepEqual(out.tasks[0].symbols, []);
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
