// R-034 #3: codegen reads file context named by a plan's task refs. A plan row can carry any
// absolute path (`/etc/hosts`, the hub's data.db, `~/.ssh/id_rsa`, another repo), so every ref is
// contained to the caller's allow-list AND the plan project's root before readFileSafely sees it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-codegen-refs-'));
process.env.LLMIDE_DB_PATH = path.join(dir, 'kb.db');

const kb = await import('../kb/db.mjs');
const { addUserRepo } = await import('../kb/db.mjs');
const { codegenContextRoots, containedCodegenRef, generateCodeForTask } = await import('../agents/codegen.mjs');
const { canonicalRoot } = await import('../kb/projects.mjs');

const db = kb.getDb();
const userId = 'cg-u1';
db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, ?, ?, 'x', 'user', 'active')")
  .run(userId, 'cg@example.com', 'CG');

const PROJECT = path.join(dir, 'project');
const OTHER = path.join(dir, 'other');
const HUB_DATA = path.join(dir, 'hub-data');
const HOME = path.join(dir, 'home');
for (const d of [path.join(PROJECT, 'src'), path.join(OTHER, 'src'), HUB_DATA, path.join(HOME, '.ssh')]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(path.join(PROJECT, 'src', 'app.ts'), 'export const APP_MARK = 1;\n');
fs.writeFileSync(path.join(OTHER, 'src', 'secret.ts'), 'export const OTHER_REPO_SECRET = 2;\n');
fs.writeFileSync(path.join(HUB_DATA, 'data.db'), 'SQLITE_HUB_SECRET');
fs.writeFileSync(path.join(HOME, '.ssh', 'id_rsa'), 'SSH_PRIVATE_SECRET');
addUserRepo(userId, PROJECT, 'project');
addUserRepo(userId, OTHER, 'other');
addUserRepo(userId, HUB_DATA, 'hub-data');

const plan = kb.savePlan(userId, {
  title: 'P', goal: 'g',
  tasks: [{
    id: 't-refs', title: 'Do it', description: 'd',
    files: [
      { ref: path.join(PROJECT, 'src', 'app.ts') },
      { ref: path.join(OTHER, 'src', 'secret.ts') },
      { ref: path.join(HUB_DATA, 'data.db') },
      { ref: '/etc/hosts' },
      { ref: '~/.ssh/id_rsa' },
    ],
  }],
});
const taskId = plan.tasks[0].id;

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R-034 #3: refs are contained to the allow-list ∩ the plan project root', () => {
  const roots = codegenContextRoots(userId, PROJECT);
  assert.deepEqual(roots, [canonicalRoot(PROJECT)], 'only the project root inside the project survives');
  assert.equal(containedCodegenRef(path.join(PROJECT, 'src', 'app.ts'), roots, PROJECT), canonicalRoot(path.join(PROJECT, 'src', 'app.ts')));
  assert.equal(containedCodegenRef(path.join(OTHER, 'src', 'secret.ts'), roots, PROJECT), null);
  assert.equal(containedCodegenRef(path.join(HUB_DATA, 'data.db'), roots, PROJECT), null);
  assert.equal(containedCodegenRef('/etc/hosts', roots, PROJECT), null);
  assert.equal(containedCodegenRef('~/.ssh/id_rsa', roots, PROJECT), null);
  assert.equal(containedCodegenRef(path.join(PROJECT, 'src', '..', '..', '..', 'etc', 'hosts'), roots, PROJECT), null,
    'a .. segment is refused before any resolution');
});

test('R-034 #3: the model prompt carries only the project file, never /etc/hosts, data.db or ~/.ssh', async () => {
  const oldHome = process.env.HOME;
  process.env.HOME = HOME;
  const prompts = [];
  const fakeClaude = async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ summary: 's', files: [], tests: [], notes: 'no change' });
  };
  try {
    await generateCodeForTask(userId, { taskId, includeFileContext: true, projectRoot: PROJECT, _runClaude: fakeClaude });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  }
  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  assert.match(prompt, /APP_MARK/);
  assert.doesNotMatch(prompt, /OTHER_REPO_SECRET/, 'another repo is not read even when allow-listed');
  assert.doesNotMatch(prompt, /SQLITE_HUB_SECRET/, 'the hub data DB is not read');
  assert.doesNotMatch(prompt, /SSH_PRIVATE_SECRET/, '~/.ssh is not read');
  assert.doesNotMatch(prompt, /\/etc\/hosts/, '/etc/hosts is not read');
  assert.doesNotMatch(prompt, /secret\.ts|data\.db|id_rsa/, 'no refused ref reaches the prompt');
});
