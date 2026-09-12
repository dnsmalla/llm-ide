// The two engines must frame a turn the same way.
//
// `sdk/engine.mjs` (Agent) and `runtime/route.mjs` (legacy) assemble their own
// prompts, and today the rule that they agree is carried by seven comments
// saying "mirrors the legacy loop's exact framing". Comments do not fail when
// someone edits one side: the plan-binding bug that shipped in September was
// exactly this — v2 was told to call a `save-plan` tool it does not mount,
// because the binding had been written for the legacy engine alone.
//
// This is the executable version of those comments. It deliberately checks
// STRUCTURE (which blocks are present, in which modes) rather than byte
// equality: the engines genuinely differ — v2 exposes project memory as a
// tool while legacy inlines it, and v2 has no save-plan — so demanding
// identical text would be wrong and would be deleted the first time it fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_engine-parity-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');
const { buildEngineOptions } = await import('../llm_agent/sdk/engine.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { tasks } = await import('../llm_agent/runtime/handlers/session-tasks.mjs');

const user = registerUser(getDb(), { email: 'parity@example.com', password: 'CorrectHorseBattery', displayName: 'p' });
const fakeKb = () => ({ getUserPrefs: () => ({ language: 'en' }) });

/** The legacy engine's assembled prompt for one turn. */
async function legacyPrompt({ mode, message, sessionId }) {
  // The FIRST call is the turn. Later ones are the fire-and-forget memory
  // extractor (and, in auto mode, the classifier) — capturing the last would
  // compare the extraction prompt against the agent's turn prompt.
  const prompts = [];
  await handleCodeAssist({
    message, history: [], agentContext: { sessionId, chatSessionId: sessionId },
    runClaude: async (p) => { prompts.push(p); return 'ok'; },
    kb: fakeKb(), userId: user.id, mode,
  });
  assert.ok(prompts.length > 0, 'the legacy engine must have composed a turn prompt');
  return prompts[0];
}

/** The Agent engine's assembled prompt for the same turn. */
function agentPrompt({ mode, message, sessionId }) {
  const { queryOptions, prompt } = buildEngineOptions(
    { userId: user.id, mode, message, skills: [], attachments: [],
      agentContext: { workspaceRoot: process.cwd(), sessionId, chatSessionId: sessionId } },
    { readSkill: (id) => ({ id, name: id, description: 'd', content: 'S'.repeat(500) }),
      roots: () => [], sessionMemory: () => ['User chose the phased approach'],
      getSubagents: () => new Set() },
  );
  return `${queryOptions.systemPrompt.append}\n${prompt}`;
}

test('both engines frame a plan turn with the mode binding and its stage skill', async () => {
  const args = { mode: 'plan', message: 'plan the refactor', sessionId: 'parity-plan' };
  const legacy = await legacyPrompt(args);
  const agent = agentPrompt(args);
  for (const [name, text] of [['legacy', legacy], ['agent', agent]]) {
    assert.match(text, /PLAN mode/, `${name} must say which mode it is in`);
    assert.match(text, /# Skills to apply/, `${name} must carry the stage skill block`);
    assert.match(text, /save-plan/, `${name} must name the one write action plan modes get`);
    assert.match(text, /One document per piece of work/, `${name} must carry the one-document rule`);
  }
  // NOT parity: the question CHANNEL is an engine capability, not a shared
  // rule. Only the Agent engine mounts AskUserQuestion; asserting the name on
  // both is what kept the classic engine being told to call a tool it does
  // not have, which it obeyed by hand-drawing an options card in prose.
  assert.match(agent, /AskUserQuestion/, 'agent must route questions through the card');
  assert.doesNotMatch(legacy, /AskUserQuestion/, 'legacy has no such tool to route to');
  assert.match(legacy, /Asking ends the turn here/, 'legacy must still say how to ask');
});

test('session memory reaches both engines under the same heading', async () => {
  // Recall has to READ identically across engines or a chat that switches
  // engine mid-life silently loses its own memory.
  const { appendSessionMemory } = await import('../kb/session-memory.mjs');
  appendSessionMemory(user.id, 'parity-mem', ['User chose the phased approach']);
  const args = { mode: 'execute', message: 'continue', sessionId: 'parity-mem' };
  const legacy = await legacyPrompt(args);
  const agent = agentPrompt(args);
  for (const [name, text] of [['legacy', legacy], ['agent', agent]]) {
    assert.match(text, /## This session's memory/, `${name} must inject session memory under the shared heading`);
    assert.match(text, /phased approach/, `${name} must carry the fact itself`);
  }
});

test('the task list reaches both engines under the same heading', async () => {
  tasks.createTask(user.id, 'parity-tasks', 'Task 1: wire the exporter');
  const args = { mode: 'execute', message: 'go', sessionId: 'parity-tasks' };
  const legacy = await legacyPrompt(args);
  const agent = agentPrompt(args);
  for (const [name, text] of [['legacy', legacy], ['agent', agent]]) {
    assert.match(text, /## Your current task list/, `${name} must show the task list`);
    assert.match(text, /wire the exporter/, `${name} must carry the task itself`);
  }
});

test('a restricted mode tells both engines the same thing about tools', async () => {
  const args = { mode: 'review', message: 'review this', sessionId: 'parity-review' };
  const legacy = await legacyPrompt(args);
  const agent = agentPrompt(args);
  // Neither engine may leave a review-mode turn thinking it can edit files.
  for (const [name, text] of [['legacy', legacy], ['agent', agent]]) {
    assert.ok(!/save-plan/.test(text), `${name}: review mode must not offer save-plan`);
  }
});
