// Regression: a batch containing a duplicate (kind, ref, chunk_idx) must not
// abort the whole ingest. Before the dedupe, one duplicated path from a repo
// walk hit the UNIQUE(kind,ref,chunk_idx) index and threw, leaving the entire
// code index EMPTY — which is exactly what made the agent's code search blank
// after a project-root index (the walk produced a dup path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, `_sources-dedupe-${process.pid}.db`);
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { ingestSources } = await import('../kb/sources.mjs');

const U = users.registerUser(db.getDb(), {
  email: `dedupe-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'd',
}).id;

test('ingestSources tolerates a duplicate (kind,ref,chunk_idx) in the batch — no throw, last wins', () => {
  let n;
  assert.doesNotThrow(() => {
    n = ingestSources(U, [
      { kind: 'code', ref: '/a/b.swift', chunkIdx: 0, title: 'b', body: 'first' },
      { kind: 'code', ref: '/a/b.swift', chunkIdx: 0, title: 'b', body: 'LAST wins' }, // dup key
      { kind: 'code', ref: '/a/c.swift', chunkIdx: 0, title: 'c', body: 'other' },
    ]);
  });
  assert.equal(n, 2, 'duplicate collapsed → 2 distinct rows, not a crash');
  // last occurrence persisted
  const hit = db.search(U, { q: 'LAST wins', kind: 'code', limit: 5 });
  assert.ok(hit.length >= 1 && hit.some((h) => h.ref === '/a/b.swift'), 'last body for the dup key is searchable');
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch {} }
});
