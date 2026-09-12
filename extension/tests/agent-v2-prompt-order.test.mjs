// Prompt-prefix stability: volatile blocks must sit BELOW stable ones.
//
// The system prompt is re-sent on every turn and only the identical PREFIX
// can be a cache hit — anything after the first differing byte is billed as
// fresh input. The task list used to sit immediately before the pipeline
// skill, the largest block in the prompt, so one `task-update` re-sent the
// whole skill: measured 36.1KB → 4.4KB identical prefix, i.e. 31.7KB
// re-billed, a dozen-plus times over a 7-step plan run.
//
// This is a cost property, invisible in any output, so it needs a test or it
// will regress the next time a block is appended "somewhere sensible".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-prompt-order-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { buildEngineOptions } = await import('../llm_agent/sdk/engine.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { tasks } = await import('../llm_agent/runtime/handlers/session-tasks.mjs');

const SKILL_CHARS = 32_000;
const deps = {
  readSkill: (id) => ({ name: id, content: 'S'.repeat(SKILL_CHARS) }),
  roots: () => [], sessionMemory: () => [], getSubagents: () => new Set(),
};

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

test('a task-update does not invalidate the pipeline skill in the cached prefix', async () => {
  const user = registerUser(getDb(), { email: 'order-1@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const agentContext = { workspaceRoot: process.cwd(), sessionId: 'a1', chatSessionId: 'chat-order-1' };
  const build = () => buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'go', agentContext, skills: [], attachments: [], planExecute: true },
    deps,
  ).queryOptions.systemPrompt.append;

  tasks.createTask(user.id, 'chat-order-1', 'Task 1: scan Swift');
  tasks.createTask(user.id, 'chat-order-1', 'Task 2: scan TypeScript');
  const before = build();
  const skillAt = before.indexOf('# Skills to apply');
  assert.ok(skillAt >= 0, 'the fixture must actually inject a skill, or this test proves nothing');
  assert.ok(before.length > SKILL_CHARS, 'and it must be the large block this is about');

  const [first] = tasks.listTasks(user.id, 'chat-order-1');
  tasks.updateTask(user.id, 'chat-order-1', first.id, { status: 'completed' });
  const after = build();
  assert.notEqual(before, after, 'the task list really did change — otherwise this asserts nothing');

  const stable = commonPrefix(before, after);
  assert.ok(stable > skillAt + SKILL_CHARS,
    `the skill must survive inside the identical prefix; prefix ended at ${stable}, `
    + `skill spans ${skillAt}..${skillAt + SKILL_CHARS}`);
  // The churn a task update may cost: the task block and whatever follows it.
  assert.ok(before.length - stable < 2_000,
    `a task update should re-send well under 2KB, re-sent ${before.length - stable}`);
});

test('the volatile blocks are the LAST things in the prompt', async () => {
  const user = registerUser(getDb(), { email: 'order-2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const agentContext = { workspaceRoot: process.cwd(), sessionId: 'a2', chatSessionId: 'chat-order-2' };
  tasks.createTask(user.id, 'chat-order-2', 'Task 1: do the thing');
  const append = buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'go',
      agentContext, skills: [], planExecute: true,
      attachments: [{ path: 'A.swift', content: 'A'.repeat(500) }] },
    { ...deps, sessionMemory: () => ['User chose the phased approach'] },
  ).queryOptions.systemPrompt.append;

  const at = (needle) => {
    const i = append.indexOf(needle);
    assert.ok(i >= 0, `expected "${needle}" in the prompt`);
    return i;
  };
  const skill = at('# Skills to apply');
  // Each volatile block must come after the stable skill text.
  for (const volatileBlock of ['## Your current task list', "## This session's memory"]) {
    assert.ok(at(volatileBlock) > skill,
      `${volatileBlock} must sit below the skills — it changes between turns`);
  }
});
