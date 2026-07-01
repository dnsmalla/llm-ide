// doc-notes.md (the doc half of the combined memory index, written by the Mac
// app) must be surfaced in the agent's "Repository memory" block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-docnotes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { renderGraphifyMemory } = await import('../graphkit/memory.mjs');
const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

function freshUser(tag) {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
}

test('renderGraphifyMemory includes doc-notes.md content', () => {
  const U = freshUser('dn');
  const repoAbs = path.join(__dirname, `_graphify-docnotes-repo-${Date.now()}`);
  const memDir = path.join(repoAbs, 'graphify-out', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'doc-notes.md'), '# Documentation memory\n## Guide\n- Setup');
  try {
    db.addUserRepo(U, repoAbs);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'dn' }] }, U);
    assert.match(out, /Documentation memory/);
    assert.match(out, /Guide/);
  } finally {
    db.closeDb();
    for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});
