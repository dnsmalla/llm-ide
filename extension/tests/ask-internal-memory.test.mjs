// The legacy global agent already carries the repo-memory block; ask-internal
// re-rendered all of it (up to 40k chars) into a fresh, uncached sub-loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_ask-internal-memory-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { runAgentLoop } = await import('../llm_agent/runtime/loop.mjs');
const { loadSkills } = await import('../llm_agent/skills/loader.mjs');

const U = users.registerUser(db.getDb(), {
  email: `aim-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'a',
}).id;
const REPO = fs.mkdtempSync(path.join(__dirname, '_aim-repo-'));
fs.mkdirSync(path.join(REPO, 'system'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'system', 'repo.md'), '# Facts\n\nMARKER_REPO_MEMORY\n');
db.addUserRepo(U, REPO);

test.after(() => {
  db.closeDb();
  fs.rmSync(REPO, { recursive: true, force: true });
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

async function firstPrompt(agentContext) {
  const prompts = [];
  const { skills } = loadSkills(path.join(__dirname, '..', 'llm_agent', 'global'));
  await runAgentLoop({
    skills, userMessage: 'what is open?', history: [], kb: null, userId: U, handlers: {},
    agentContext: { base: '', indexedRepos: [{ path: REPO, name: 'r' }], ...agentContext },
    runClaude: async (p) => { prompts.push(p); return 'Done.'; },
  });
  return prompts[0];
}

test('system context includes repo memory by default', async () => {
  assert.match(await firstPrompt({ includeSystemContext: true }), /MARKER_REPO_MEMORY/);
});

test('includeRepoMemory:false omits it', async () => {
  assert.doesNotMatch(
    await firstPrompt({ includeSystemContext: true, includeRepoMemory: false }),
    /MARKER_REPO_MEMORY/);
});
