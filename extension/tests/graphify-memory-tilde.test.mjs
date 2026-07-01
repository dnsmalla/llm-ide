// The Mac client sends home-relative ("~/…") indexedRepos paths, but the
// Graphify memory reader (and allow-list) work in absolute terms — without
// tilde expansion, every home-dir repo's memory was dropped at the
// isAbsolute() gate, so the agent's "Repository memory" block stayed empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-memory-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { renderGraphifyMemory, expandTilde } = await import('../graphkit/memory.mjs');
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

// ── expandTilde (pure) ───────────────────────────────────────────────
test('expandTilde expands ~ and ~/ against the given home', () => {
  assert.equal(expandTilde('~/Developer/foo', '/home/u'), '/home/u/Developer/foo');
  assert.equal(expandTilde('~', '/home/u'), '/home/u');
  assert.equal(expandTilde('/abs/path', '/home/u'), '/abs/path');
  assert.equal(expandTilde('relative/x', '/home/u'), 'relative/x');
});

// ── end-to-end: an absolute (post-expansion) allow-listed path reads memory.
// (The literal "~/" → absolute conversion is covered by the expandTilde unit
// test above; the sandbox blocks writing under $HOME, so we exercise the
// read+allow-list+files path with the absolute form expandTilde produces.)
test('renderGraphifyMemory reads memory for an absolute allow-listed repo path', () => {
  const U = freshUser('gm');
  const repoAbs = path.join(__dirname, `_graphify-mem-repo-${Date.now()}`);
  const memDir = path.join(repoAbs, 'graphify-out', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'repo.md'), '# Repo summary\nHello memory.');
  try {
    db.addUserRepo(U, repoAbs);   // allow-list stores the absolute path
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'gm' }] }, U);
    assert.match(out, /Repository memory \(Graphify\)/);
    assert.match(out, /Hello memory/);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

// ── regression: a genuinely relative path is still rejected ──────────
test('renderGraphifyMemory rejects a non-absolute, non-tilde path', () => {
  const U = freshUser('gm2');
  const out = renderGraphifyMemory({ indexedRepos: [{ path: 'relative/repo', name: 'r' }] }, U);
  assert.equal(out, '');
});
