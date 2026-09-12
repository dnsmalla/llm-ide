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

// Just under SKILL_INLINE_MAX_CHARS, so this fixture's skill is INLINED —
// which is what makes it a test of ordering. A skill over the threshold is
// announced instead of inlined (see the deferral test at the bottom), and
// would prove nothing about where inline text sits.
const SKILL_CHARS = 3_900;
const deps = {
  readSkill: (id) => ({ name: id, content: 'S'.repeat(SKILL_CHARS) }),
  roots: () => [], sessionMemory: () => [], getSubagents: () => new Set(),
};
const HEAVY_CHARS = 32_000;

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
  // Assert the BODY is present, not the absence of the pointer phrase — the
  // skills-block header mentions "NOT INCLUDED HERE" unconditionally, to
  // explain the marker, so searching for it proves nothing.
  assert.match(before, /S{500}/,
    'this fixture must be inlined, or the ordering it checks is not being exercised');

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

test('the pipeline stage skill is ALWAYS inlined, however large', async () => {
  // Regression: a size threshold used to defer it, so Plan mode's first turn
  // carried a pointer to brainstorming (15KB) instead of the process, and an
  // execute-plan turn with subagents carried a pointer to
  // subagent-driven-development (32KB). Assist Plan kept working only because
  // grilling is small enough to stay inline — which is what made the breakage
  // look like "assist plan behaves differently".
  //
  // This is the process the binding tells the model to follow for THIS turn.
  // It is not reference material, and it must not depend on the model
  // volunteering a `load-skill` call before it does anything.
  const user = registerUser(getDb(), { email: 'order-3@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const heavy = {
    readSkill: (id) => ({
      name: 'subagent-driven-development', id,
      description: 'Dispatch each plan task to a subagent and review the result.',
      content: 'S'.repeat(HEAVY_CHARS),
    }),
    roots: () => [], sessionMemory: () => [],
    getSubagents: () => new Set(['some-agent']),
  };
  const append = buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'go', planExecute: true,
      agentContext: { workspaceRoot: process.cwd(), sessionId: 'a3', chatSessionId: 'chat-order-3' },
      skills: [], attachments: [] },
    heavy,
  ).queryOptions.systemPrompt.append;

  assert.ok(append.length > HEAVY_CHARS,
    `the stage skill must be inlined whole; append was only ${append.length} chars`);
  assert.match(append, /## Skill: subagent-driven-development/);
  assert.doesNotMatch(append, /NOT INCLUDED HERE/,
    'a stage skill is never announced — the turn has no process without it');
});
