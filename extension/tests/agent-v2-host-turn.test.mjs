// The in-process turn seam (startHostTurn / cancelChatTurn / clearChatSessionState) the Host API gateway
// drives: the same lock, refusals and bookkeeping as POST /agent/v2/stream, without HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-host-turn-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const v2 = await import('../routes/agent-v2.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { createChatSession, appendChatMessage, getChatSession } = await import('../kb/chat-sessions.mjs');
const { getOrCreateAgentSession } = await import('../kb/agent-sessions.mjs');

let seq = 0;
async function makeUser() {
  seq += 1;
  const u = await registerUser(getDb(), { email: `host-turn-${seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't' });
  return u.id ?? u.user?.id;
}

// No classifier model call in tests: the mode is resolved locally.
const classifyMode = async () => ({ mode: 'ask' });
const fakeRun = (events, seen) => async (args) => { if (seen) Object.assign(seen, args); for (const e of events) args.onEvent(e); return {}; };

test('startHostTurn delivers the engine events in order and resolves at the end', async () => {
  const userId = await makeUser();
  const got = [];
  const seen = {};
  await v2.startHostTurn({
    userId, chatSessionId: 'c-host-1', message: 'hi', files: [{ name: 'a.txt' }], onEvent: (e) => got.push(e.type),
    deps: { classifyMode, runTurn: fakeRun([{ type: 'init', sessionId: 's-1' }, { type: 'delta', text: 'yo' }, { type: 'result', subtype: 'success', sessionId: 's-1' }], seen) },
  });
  assert.deepEqual(got.filter((t) => ['init', 'delta', 'result'].includes(t)), ['init', 'delta', 'result']);
  assert.ok(got.includes('mode_set') && got.at(-1) === 'tasks', 'the same injected events as the SSE stream');
  assert.equal(seen.mode, 'ask');
  assert.equal(seen.permissionMode, null, 'never Bypass');
  assert.equal(seen.agentContext.surface, 'host-api');
  assert.ok(seen.agentContext.workspaceRoot);
  assert.deepEqual(seen.attachments, [{ name: 'a.txt' }]);
  // The chat→SDK-session mapping is bound like an HTTP turn's.
  assert.equal(getOrCreateAgentSession(getDb(), userId, 'c-host-1').sdk_session_id, 's-1');
});

test('a write mode from the classifier is clamped to read-only', async () => {
  const userId = await makeUser();
  const seen = {};
  await v2.startHostTurn({
    userId, chatSessionId: 'c-host-ro', message: 'edit the file', onEvent: () => {},
    deps: { classifyMode: async () => ({ mode: 'execute' }), runTurn: fakeRun([], seen) },
  });
  assert.notEqual(seen.mode, 'execute');
});

test('a second host turn on the same chat is refused with TURN_IN_PROGRESS', async () => {
  const userId = await makeUser();
  let release;
  const slow = async ({ onEvent }) => { onEvent({ type: 'init', sessionId: 's' }); await new Promise((r) => { release = r; }); return {}; };
  const first = v2.startHostTurn({ userId, chatSessionId: 'c-host-2', message: 'a', onEvent: () => {}, deps: { classifyMode, runTurn: slow } });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(v2.startHostTurn({ userId, chatSessionId: 'c-host-2', message: 'b', onEvent: () => {}, deps: { classifyMode, runTurn: slow } }),
    (e) => e.code === 'TURN_IN_PROGRESS');
  assert.equal(v2.cancelChatTurn(userId, 'c-host-2'), true);
  release(); await first.catch(() => {});
  assert.equal(v2.cancelChatTurn(userId, 'c-host-2'), false, 'the lock is released when the turn ends');
});

test('clearChatSessionState refuses while a turn runs and clears afterwards', async () => {
  const userId = await makeUser();
  const chat = createChatSession(userId, { title: 'Phone chat', surface: 'any', mode: 'agent' });
  const chatId = chat.id;
  appendChatMessage(userId, chatId, { role: 'user', content: 'hello' });
  let release;
  const slow = async ({ onEvent }) => { onEvent({ type: 'init', sessionId: 's-3' }); await new Promise((r) => { release = r; }); return {}; };
  const run = v2.startHostTurn({ userId, chatSessionId: chatId, message: 'a', onEvent: () => {}, deps: { classifyMode, runTurn: slow } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(v2.clearChatSessionState(userId, chatId), { cleared: false });
  release(); await run;
  assert.deepEqual(v2.clearChatSessionState(userId, chatId), { cleared: true });
  assert.equal(getChatSession(userId, chatId).messages.length, 0);
  assert.equal(getOrCreateAgentSession(getDb(), userId, chatId).sdk_session_id, null, 'the SDK mapping is dropped');
});

test('a host turn ends the chat\'s Bypass grant when host approval is enabled (like a non-Bypass HTTP turn)', async () => {
  const H = await import('../core/host-approval.mjs');
  const userId = await makeUser();
  const prev = process.env.LLMIDE_HOST_APPROVAL_KEY;
  process.env.LLMIDE_HOST_APPROVAL_KEY = 'ab'.repeat(32);
  try {
    H.bypassGrants.grant(userId, 'c-host-grant');
    assert.equal(H.bypassGrants.has(userId, 'c-host-grant'), true);
    await v2.startHostTurn({ userId, chatSessionId: 'c-host-grant', message: 'hi', onEvent: () => {}, deps: { classifyMode, runTurn: fakeRun([]) } });
    assert.equal(H.bypassGrants.has(userId, 'c-host-grant'), false);
  } finally {
    if (prev === undefined) delete process.env.LLMIDE_HOST_APPROVAL_KEY; else process.env.LLMIDE_HOST_APPROVAL_KEY = prev;
  }
});

test('a chat at its token cap rejects with SESSION_TOKEN_LIMIT and the same used/limit details as the HTTP 402', async () => {
  const { putRoute } = await import('../kb/chat-route.mjs');
  const userId = await makeUser();
  process.env.LLMIDE_ROUTER = 'on'; process.env.LLMIDE_ROUTER_CAP = 'on';
  try {
    putRoute(getDb(), userId, 'c-host-cap', { tokenLimit: 100, tokensUsed: 100 });
    let ran = false;
    await assert.rejects(
      v2.startHostTurn({ userId, chatSessionId: 'c-host-cap', message: 'hi', onEvent: () => {}, deps: { classifyMode, runTurn: async () => { ran = true; return {}; } } }),
      (e) => e.code === 'SESSION_TOKEN_LIMIT' && e.details?.used === 100 && e.details?.limit === 100,
    );
    assert.equal(ran, false);
  } finally { delete process.env.LLMIDE_ROUTER; delete process.env.LLMIDE_ROUTER_CAP; }
});

test('startHostTurn: an allowed mode runs as asked and a model is passed through', async () => {
  const userId = await makeUser();
  const seen = {};
  await v2.startHostTurn({
    userId, chatSessionId: 'c-host-mode', message: 'plan the change', mode: 'plan', model: 'claude-sonnet-5-5', onEvent: () => {},
    deps: { classifyMode: async () => { throw new Error('an explicit mode must not classify'); }, runTurn: fakeRun([], seen) },
  });
  assert.equal(seen.mode, 'plan');
  assert.equal(seen.model, 'claude-sonnet-5-5');
  assert.equal(seen.permissionMode, null, 'never Bypass');
});
test('startHostTurn: execute, a permission mode or junk never runs as asked; auto stays auto_read_only', async () => {
  const userId = await makeUser();
  for (const mode of ['execute', 'bypass', 'accept-edits', 'auto_read_only', 'nonsense', 'auto', undefined]) {
    const seen = {};
    await v2.startHostTurn({
      userId, chatSessionId: `c-host-${String(mode)}`, message: 'edit the file', mode, onEvent: () => {},
      deps: { classifyMode: async () => ({ mode: 'execute' }), runTurn: fakeRun([], seen) },
    });
    assert.equal(seen.mode, 'ask', `${String(mode)} is clamped to read-only`);
  }
});
test('HOST_TURN_MODES matches the shared compose vector', async () => {
  const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../../schema/host-api/v1/fixtures/security/compose.json'), 'utf8'));
  assert.deepEqual([...v2.HOST_TURN_MODES], vector.modes.allowed);
});
