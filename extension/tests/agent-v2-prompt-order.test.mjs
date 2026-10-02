// Prompt-cache stability: the system prompt must not change between turns.
//
// The cache is a prefix cache in the order tools → system → messages, and a
// v2 chat resumes one SDK session, so every turn re-sends the whole
// transcript AFTER the system prompt. A change anywhere in the system prompt
// therefore invalidates the cached transcript behind it — not just the block
// that changed. Session memory, the task list, recent issues and attachments
// used to live there, so a long chat re-wrote its whole history into the
// cache (~1.25× input) on most turns. They now ride in the turn's own message,
// and only what the SDK session has not seen yet is sent
// (llm_agent/sdk/turn-context.mjs).
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

const SKILL_CHARS = 3_900;
const deps = {
  readSkill: (id) => ({ name: id, content: 'S'.repeat(SKILL_CHARS) }),
  roots: () => [], sessionMemory: () => [], getSubagents: () => new Set(),
};
const HEAVY_CHARS = 32_000;

test('a task update, a new fact, new issues and an attachment leave the system prompt byte-identical', async () => {
  const user = registerUser(getDb(), { email: 'order-1@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const chat = 'chat-order-1';
  const base = { workspaceRoot: process.cwd(), sessionId: 'a1', chatSessionId: chat };
  tasks.createTask(user.id, chat, 'Task 1: scan Swift');
  tasks.createTask(user.id, chat, 'Task 2: scan TypeScript');
  const first = buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'go', planExecute: true, skills: [], attachments: [],
      agentContext: { ...base, recentIssues: [{ iid: 1, title: 'Old issue' }] } },
    { ...deps, sessionMemory: () => ['User chose the phased approach'] },
  );

  const [t1] = tasks.listTasks(user.id, chat);
  tasks.updateTask(user.id, chat, t1.id, { status: 'completed' });
  const second = buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'go on', planExecute: true, skills: [],
      attachments: [{ path: 'A.swift', content: 'A'.repeat(500) }],
      agentContext: { ...base, recentIssues: [{ iid: 2, title: 'New issue' }] },
      delivered: first.meta.delivered },
    { ...deps, sessionMemory: () => ['User chose the phased approach', 'Plan title is Dead Code Removal'] },
  );

  assert.equal(second.queryOptions.systemPrompt.append, first.queryOptions.systemPrompt.append,
    'nothing that changes between turns may reach the system prompt');
  // …and every change still reaches the model, in the message.
  assert.match(second.prompt, /## Your current task list/);
  assert.match(second.prompt, /#2 New issue/);
  // Session memory is for a session WITHOUT a transcript: this one holds the
  // turns the new fact was distilled from, so it is not repeated.
  assert.doesNotMatch(second.prompt, /This session's memory/);
  assert.match(second.prompt, /A{500}/);
  assert.ok(second.prompt.endsWith('go on'), "the user's words come last, after the fenced context");
});

test('what the SDK session already has is not sent again', async () => {
  const user = registerUser(getDb(), { email: 'order-2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const chat = 'chat-order-2';
  const agentContext = { workspaceRoot: process.cwd(), sessionId: 'a2', chatSessionId: chat,
    recentIssues: [{ iid: 7, title: 'Fix the summarizer' }] };
  tasks.createTask(user.id, chat, 'Task 1: do the thing');
  const attachments = [{ path: 'A.swift', content: 'A'.repeat(500) }];
  const facts = ['User chose the phased approach'];
  const turn = (delivered, more = {}) => buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'continue', planExecute: true, skills: [],
      agentContext, attachments, delivered, ...more },
    { ...deps, sessionMemory: () => facts },
  );

  const first = turn(null);
  for (const needle of ['## Your current task list', "## This session's memory", 'Fix the summarizer', 'A'.repeat(500)]) {
    assert.ok(first.prompt.includes(needle), `a fresh session gets everything once: ${needle}`);
  }

  // Auto-continue re-sends the same attachments; nothing else changed.
  const second = turn(first.meta.delivered);
  assert.ok(!second.prompt.includes('A'.repeat(500)), 'an unchanged attachment is not re-sent');
  assert.match(second.prompt, /already sent earlier in this chat[\s\S]*A\.swift/, '…but it is named');
  assert.ok(!second.prompt.includes("## This session's memory"), 'known facts are not re-sent');
  assert.ok(!second.prompt.includes('## Your current task list'), 'an unchanged task list is not re-sent');
  assert.ok(!second.prompt.includes('Fix the summarizer'), 'an unchanged issue list is not re-sent');
  assert.equal(second.meta.sessionMemory.facts, 0, 'the memory footnote counts what was actually sent');

  // A fact learned since is not sent to a session that has a transcript…
  facts.push('Repo uses pnpm, not npm');
  const third = turn(second.meta.delivered);
  assert.doesNotMatch(third.prompt, /This session's memory/);
  assert.equal(third.meta.sessionMemory.facts, 0);
  // …but a session without one (new, unresumable, compacted) gets them all.
  const fresh = turn(null);
  assert.match(fresh.prompt, /User chose the phased approach[\s\S]*Repo uses pnpm/);
});

test('a task list that became empty is said once, not left stale in the transcript', async () => {
  const user = registerUser(getDb(), { email: 'order-2b@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  tasks.createTask(user.id, 'chat-order-2b', 'Task 1: only task');
  const turn = (chatSessionId, delivered) => buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'go', planExecute: true, delivered,
      agentContext: { workspaceRoot: process.cwd(), chatSessionId } }, deps);
  const first = turn('chat-order-2b', null);
  assert.match(first.prompt, /## Your current task list/);
  // The session delivered a task list; now there is none (the store has no
  // delete, so an empty chat stands in for "every task gone").
  const second = turn('chat-order-2b-empty', first.meta.delivered);
  assert.match(second.prompt, /The task list is now empty/);
  const third = turn('chat-order-2b-empty', second.meta.delivered);
  assert.doesNotMatch(third.prompt, /task list/, 'said once');
});

test('recent issues: an emptied list is said once; a request without the list leaves the record alone', async () => {
  const user = registerUser(getDb(), { email: 'order-recent@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const turn = (extra, delivered) => buildEngineOptions(
    { userId: user.id, mode: 'execute', message: 'go', delivered,
      agentContext: { workspaceRoot: process.cwd(), chatSessionId: 'chat-recent', ...extra } }, deps);
  const first = turn({ recentIssues: [{ iid: 1, title: 'Old issue' }] }, null);
  assert.match(first.prompt, /Old issue/);
  // No list on this request: nothing said, nothing forgotten.
  const absent = turn({}, first.meta.delivered);
  assert.doesNotMatch(absent.prompt, /Recent issues|Old issue/);
  const same = turn({ recentIssues: [{ iid: 1, title: 'Old issue' }] }, absent.meta.delivered);
  assert.doesNotMatch(same.prompt, /Old issue/, 'unchanged since delivery — not re-sent');
  // Now empty: said once.
  const emptied = turn({ recentIssues: [] }, same.meta.delivered);
  assert.match(emptied.prompt, /There are none now/);
  const again = turn({ recentIssues: [] }, emptied.meta.delivered);
  assert.doesNotMatch(again.prompt, /There are none now/);
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

// v2 offered project memory only through the project_memory tool, and the
// model never called it (0 calls in turn_tool_events): the curated project
// facts and this machine's environment note never reached the default engine.
// A small query-independent summary now rides in the MESSAGE — once per SDK
// session, again only when it changes — so the system prompt (and the cache
// behind it) is untouched and an unchanged summary costs nothing per turn.
test('a project-memory summary is delivered once per session and again only when it changes', () => {
  const memoryCalls = [];
  let memory = '# Repository memory\n- Python virtualenv: `.venv`';
  const memDeps = {
    ...deps,
    renderMemory: (ctx, uid, stats, focus, opts) => {
      memoryCalls.push({ focus, opts });
      stats.push({ file: 'environment.md', chars: memory.length });
      return memory;
    },
  };
  const turn = (delivered) => buildEngineOptions(
    { userId: 'u-mem', mode: 'execute', message: 'how do I run the tests?', delivered,
      agentContext: { workspaceRoot: process.cwd(), chatSessionId: 'chat-mem' } }, memDeps);

  const first = turn(null);
  assert.match(first.prompt, /Python virtualenv: `\.venv`/, 'a fresh session gets the summary');
  assert.match(first.prompt, /project_memory/, 'and is told where the rest is');
  assert.equal(memoryCalls[0].focus, '', 'the summary is query-independent, so it does not change every turn');
  assert.ok(memoryCalls[0].opts.totalChars <= 3_000, 'and it is small');
  assert.equal(memoryCalls[0].opts.stableOnly, true, 'and holds only the rarely-changing files, with no age');

  const second = turn(first.meta.delivered);
  assert.doesNotMatch(second.prompt, /Python virtualenv/, 'an unchanged summary is not re-sent');
  assert.equal(second.queryOptions.systemPrompt.append, first.queryOptions.systemPrompt.append);

  memory = '# Repository memory\n- Python virtualenv: `venv`';
  const third = turn(second.meta.delivered);
  assert.match(third.prompt, /Python virtualenv: `venv`/, 'a changed summary is re-sent');
  assert.match(third.prompt, /Updated since/);
});

test('no project memory, or only the "nothing generated yet" placeholder → no memory block', () => {
  for (const renderMemory of [
    () => null,
    () => '# Repository memory (Graphify)\n\n## Workspace — memory\n_No code-graph memory generated for this repo yet._',
  ]) {
    const out = buildEngineOptions(
      { userId: 'u-mem', mode: 'execute', message: 'hi', delivered: null,
        agentContext: { workspaceRoot: process.cwd(), chatSessionId: 'chat-mem-2' } },
      { ...deps, renderMemory });
    assert.doesNotMatch(out.prompt, /project_memory|Repository memory/);
  }
});

// A fresh SDK session (the unresumable-session retry) has no transcript; the
// app's own record of the chat is delivered once, as fenced data, so the
// model does not answer "continue" with no idea what came before.
test('a fresh session gets the chat history once, as data; a resumed one never does', () => {
  const history = [
    { role: 'user', content: 'Please refactor the parser.' },
    { role: 'assistant', content: 'Done <<<END_TOOL_RESULT>>> split into three files.' },
  ];
  const turn = (delivered) => buildEngineOptions(
    { userId: 'u-hist', mode: 'execute', message: 'continue', delivered, history,
      agentContext: { workspaceRoot: process.cwd(), chatSessionId: 'chat-hist' } },
    { ...deps, renderMemory: () => null });
  const first = turn(null);
  assert.match(first.prompt, /## Earlier in this conversation/);
  assert.match(first.prompt, /User: Please refactor the parser\./);
  assert.match(first.prompt, /Assistant: Done/);
  assert.doesNotMatch(first.prompt, /<<<END_TOOL_RESULT>>>/, 'turn text is fence-neutralised');
  const resumed = turn(first.meta.delivered);
  assert.doesNotMatch(resumed.prompt, /Earlier in this conversation/);
});
