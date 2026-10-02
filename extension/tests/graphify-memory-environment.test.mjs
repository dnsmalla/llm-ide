// environment.md (the runtime-environment note — venv, PATH, project files — written by the Mac
// app's Core EnvironmentNoteWriter) must be surfaced in the agent's "Repository memory" block,
// so the agent can answer "how do I run this?" without rediscovering it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_graphify-envnote-test.db');
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

test('renderGraphifyMemory includes environment.md content', () => {
  const U = freshUser('env');
  const repoAbs = path.join(__dirname, `_graphify-envnote-repo-${Date.now()}`);
  const memDir = path.join(repoAbs, 'system', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'environment.md'), '# Runtime environment\n- Python virtualenv: `.venv`');
  try {
    db.addUserRepo(U, repoAbs);
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'env' }] }, U);
    assert.match(out, /### environment.md\n# Runtime environment/);
    assert.match(out, /Python virtualenv: `\.venv`/);
  } finally {
    db.closeDb();
    for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('environment.md survives a memory block whose bulk files fill the budget', () => {
  const U = freshUser('envfull');
  const repoAbs = path.join(__dirname, `_graphify-envnote-full-repo-${Date.now()}`);
  const sysDir = path.join(repoAbs, 'system');
  const memDir = path.join(sysDir, 'memory');
  fs.mkdirSync(path.join(sysDir, 'graph'), { recursive: true });
  fs.mkdirSync(memDir, { recursive: true });
  const bulk = (tag) => Array.from({ length: 400 }, (_, i) => `- ${tag} fact ${i} lorem ipsum`).join('\n');
  fs.writeFileSync(path.join(sysDir, 'repo.md'), bulk('repo'));
  fs.writeFileSync(path.join(sysDir, 'graph', 'index.md'), bulk('index'));
  fs.writeFileSync(path.join(memDir, 'chat-memory.md'), bulk('chat'));
  fs.writeFileSync(path.join(memDir, 'graph-notes.md'), bulk('graph'));
  fs.writeFileSync(path.join(memDir, 'doc-notes.md'), bulk('doc'));
  fs.writeFileSync(path.join(memDir, 'environment.md'), '# Runtime environment\n- Python virtualenv: `.venv`');
  try {
    db.addUserRepo(U, repoAbs);
    // A caller-lowered budget (totalChars) is the realistic tight case.
    const out = renderGraphifyMemory({ indexedRepos: [{ path: repoAbs, name: 'envfull' }] }, U, undefined, '',
      { totalChars: 14_000 });
    assert.match(out, /### environment.md\n# Runtime environment/);
  } finally {
    db.closeDb();
    for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});
