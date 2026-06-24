// Option A regression: the GLOBAL Code Assistant agent must receive the
// Graphify "Repository memory" block directly (not only the internal agent),
// so it grounds project answers in real memory even when it answers directly
// instead of delegating to ask-internal. Guards route.mjs's renderGraphifyMemory
// injection into personaBase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Secrets + temp DB must be set before route.mjs (→ kb/db) loads.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_global-memory-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');
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

const kbStub = { search: () => [], listMeetings: () => ({ items: [] }), getAgentPersona: () => null };

test('global agent receives Graphify repo memory directly (Option A)', async () => {
  const U = freshUser('gmem');
  const repoAbs = path.join(__dirname, `_global-mem-repo-${Date.now()}`);
  const memDir = path.join(repoAbs, 'graphify-out', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'repo.md'), '# Repo summary\nUNIQUE_MEMORY_MARKER_42 lives here.');
  db.addUserRepo(U, repoAbs);

  let globalPrompt = '';
  const capturingClaude = async (prompt) => {
    if (!globalPrompt) globalPrompt = prompt;       // first call = global's turn
    return 'Direct answer, no delegation.';          // plain reply → loop ends
  };

  try {
    const out = await handleCodeAssist({
      message: 'Summarize this repository.',
      history: [],
      agentContext: { indexedRepos: [{ path: repoAbs, name: 'gmem' }] },
      runClaude: capturingClaude,
      kb: kbStub,
      userId: U,
    });
    assert.match(out.reply, /Direct answer/);
    // The global agent answered DIRECTLY (no ask-internal), yet its prompt
    // must still carry the repo memory — that's the whole point of Option A.
    assert.match(globalPrompt, /Repository memory \(Graphify\)/);
    assert.match(globalPrompt, /UNIQUE_MEMORY_MARKER_42/);
  } finally {
    fs.rmSync(repoAbs, { recursive: true, force: true });
  }
});

test('global agent gets NO memory block when there are no indexed repos', async () => {
  const U = freshUser('gmem2');
  let globalPrompt = '';
  const capturingClaude = async (prompt) => { if (!globalPrompt) globalPrompt = prompt; return 'ok'; };
  await handleCodeAssist({
    message: 'hi',
    history: [],
    agentContext: { recentIssues: [], recentMeetings: [] },   // no indexedRepos
    runClaude: capturingClaude,
    kb: kbStub,
    userId: U,
  });
  assert.doesNotMatch(globalPrompt, /Repository memory \(Graphify\)/);
});
