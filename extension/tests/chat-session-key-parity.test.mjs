// I8: every "which chat is this?" read in the legacy turn must resolve the
// SAME key.
//
// `resolveChatSessionId` (kb/session-memory.mjs) prefers the client's stable
// `chatSessionId` and falls back to the volatile per-turn `sessionId`.
// route.mjs has THREE places that key on a chat: the task-tool dispatch ctx
// (what task-create/task-update/task-list write and read), the prompt's
// "## Your current task list" block, and the response's `tasks` /
// `continueNeeded` fields. Only the first had been converted; the other two
// still read the raw `agentContext.sessionId`.
//
// That combination is worse than either extreme. With `chatSessionId` absent
// (as it was, because server/ai-routes.mjs never forwarded it) all three
// happened to agree on `sessionId`, so the earlier fix was a silent no-op.
// The moment `chatSessionId` IS forwarded — which it now is — a half-converted
// route.mjs would write tasks under one key and read them back under another:
// the model would create a task, then be told on the next turn that it has no
// tasks, and the Mac client's task panel would stay empty forever.
//
// These tests supply BOTH ids, deliberately different, and pin all three sites
// to the chatSessionId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-session-key-parity-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { handleCodeAssist } = await import('../llm_agent/runtime/route.mjs');
const { tasks } = await import('../llm_agent/runtime/handlers/session-tasks.mjs');

const fakeKb = { search: () => [], listMeetings: () => ({ items: [] }) };

// Emits one task-create fence on the first call, then a plain reply.
function scriptedClaude(prompts, toolCall) {
  let calls = 0;
  return async (prompt) => {
    prompts.push(prompt);
    calls += 1;
    if (calls === 1 && toolCall) {
      return `Starting.\n<<<TOOL_CALL>>>\n${JSON.stringify(toolCall)}\n<<<END_TOOL_CALL>>>`;
    }
    return 'Done.';
  };
}

test('tasks are written, prompted about, and reported under chatSessionId — never the volatile sessionId', async () => {
  const userId = 'i8-user-1';
  const turn1Prompts = [];
  const out1 = await handleCodeAssist({
    message: 'do a multi-step job',
    history: [],
    agentContext: { sessionId: 'volatile-turn-1', chatSessionId: 'stable-chat-1', workspaceRoot: process.cwd(), recentIssues: [], recentMeetings: [] },
    runClaude: scriptedClaude(turn1Prompts, { name: 'task-create', arguments: { title: 'Step one' } }),
    kb: fakeKb,
    userId,
  });

  // 1. WRITE site — the dispatch ctx keyed the row to the stable chat id.
  assert.equal(tasks.listTasks(userId, 'stable-chat-1').length, 1, 'the task must land under chatSessionId');
  assert.equal(tasks.listTasks(userId, 'volatile-turn-1').length, 0, 'nothing may land under the volatile sessionId');

  // 2. RESPONSE site — tasks/continueNeeded read the same key, so the client
  //    actually sees the task the model just created.
  assert.equal(out1.tasks.length, 1, 'the response must report the task it just created');
  assert.equal(out1.tasks[0].title, 'Step one');
  assert.equal(out1.continueNeeded, true, 'a pending task means more work is needed');

  // 3. PROMPT site — a LATER turn in the same chat (new volatile sessionId,
  //    same chatSessionId) must be told about the existing task.
  const turn2Prompts = [];
  const out2 = await handleCodeAssist({
    message: 'carry on',
    history: [],
    agentContext: { sessionId: 'volatile-turn-2', chatSessionId: 'stable-chat-1', workspaceRoot: process.cwd(), recentIssues: [], recentMeetings: [] },
    runClaude: scriptedClaude(turn2Prompts, null),
    kb: fakeKb,
    userId,
  });
  assert.ok(turn2Prompts.length > 0, 'the second turn must have called the model');
  assert.match(turn2Prompts[0], /## Your current task list/, 'the prompt must carry the task-list block');
  assert.match(turn2Prompts[0], /Step one/, 'the prompt must name the task created in the previous turn');
  assert.equal(out2.tasks.length, 1, 'the second turn still reports the same task');
});

test('with no chatSessionId the resolver still falls back to sessionId (back-compat)', async () => {
  const userId = 'i8-user-2';
  const prompts = [];
  const out = await handleCodeAssist({
    message: 'do a job',
    history: [],
    agentContext: { sessionId: 'only-session-id', workspaceRoot: process.cwd(), recentIssues: [], recentMeetings: [] },
    runClaude: scriptedClaude(prompts, { name: 'task-create', arguments: { title: 'Legacy step' } }),
    kb: fakeKb,
    userId,
  });
  assert.equal(tasks.listTasks(userId, 'only-session-id').length, 1);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].title, 'Legacy step');
});

test('route.mjs has no raw agentContext.sessionId reads left for chat-keyed state', () => {
  // The three sites must all go through resolveChatSessionId. A raw
  // `agentContext?.sessionId` read reintroduces the split-key regression the
  // behavioural tests above pin, so it is banned outright in this file.
  const src = readFileSync(path.join(__dirname, '..', 'llm_agent', 'runtime', 'route.mjs'), 'utf8');
  const raw = src.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /agentContext\?\.sessionId/.test(line) && !line.trim().startsWith('//'));
  assert.deepEqual(raw, [], `route.mjs must use resolveChatSessionId, not a raw sessionId read: ${JSON.stringify(raw)}`);
});

test('server/ai-routes.mjs forwards the client chatSessionId into enrichedAgentContext', () => {
  // The server-side half: without this field the resolver above always falls
  // back to `sessionId` and the whole parity fix is a no-op. Asserted on the
  // source because the surrounding route can only be driven end-to-end with a
  // live model call.
  const src = readFileSync(path.join(__dirname, '..', 'server', 'ai-routes.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const enrichedAgentContext'), src.indexOf('const enrichedAgentContext') + 1400);
  assert.match(block, /chatSessionId:\s*typeof body\.agentContext\.chatSessionId === 'string'/,
    'enrichedAgentContext must forward the client-supplied chatSessionId');
});
