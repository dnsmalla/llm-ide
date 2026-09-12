// The Agent engine's `memory` event (server API v49): how much of a turn's
// prompt is the chat's own session memory. The legacy route has reported
// memoryChars/approxTokens on its result since the footnote existed; this
// engine reported nothing, so the Mac's brain button read "0 — no memory
// injected" on every v2 turn whether or not "This session's memory" was in
// the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-memory-event-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');

function capturingQuery(capture) {
  return (prompt, options) => {
    capture.prompt = prompt;
    capture.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: capture.sessionId, tools: [], capabilities: [] };
      yield { type: 'result', subtype: 'success', session_id: capture.sessionId };
    })();
  };
}

function withAnthropicKey(value, fn) {
  return async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = value;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  };
}

async function turnWith({ sessionFacts, tag }) {
  const user = registerUser(getDb(), { email: `mem-${tag}@example.com`, password: 'CorrectHorseBattery', displayName: 't' });
  const capture = { sessionId: `sdk-mem-${tag}` };
  const events = [];
  await runAgentV2Turn({
    message: 'continue', userId: user.id, mode: 'execute',
    agentContext: { workspaceRoot: process.cwd(), sessionId: 'agent-1', chatSessionId: `chat-${tag}` },
    resumeSdkSessionId: capture.sessionId,
    onEvent: (e) => events.push(e),
    queryFactory: capturingQuery(capture),
  }, {
    readSkill: () => null, roots: () => [],
    sessionMemory: () => sessionFacts, persistMemory: async () => null,
  });
  return { events, capture };
}

test('a turn with session facts emits one memory event whose counts match the injected block',
  withAnthropicKey('sk-ant-mem-1', async () => {
    const facts = ['User chose the phased approach', 'Plan title is Dead Code Removal'];
    const { events, capture } = await turnWith({ sessionFacts: facts, tag: 'two' });
    const mem = events.filter((e) => e.type === 'memory');
    assert.equal(mem.length, 1, 'exactly one footnote per turn');
    assert.equal(mem[0].sessionFacts, 2);
    assert.ok(mem[0].chars > 0);
    assert.equal(mem[0].approxTokens, Math.round(mem[0].chars / 4));
    // The block it counts is really in the prompt the model sees.
    const appended = capture.options.systemPrompt?.append ?? JSON.stringify(capture.options);
    assert.match(appended, /This session's memory/);
    assert.match(appended, /Plan title is Dead Code Removal/);
  }));

test('a turn with no session facts still emits the event, at zero — the client can tell "none" from "unknown"',
  withAnthropicKey('sk-ant-mem-2', async () => {
    const { events } = await turnWith({ sessionFacts: [], tag: 'none' });
    const mem = events.filter((e) => e.type === 'memory');
    assert.equal(mem.length, 1);
    assert.deepEqual(mem[0], { type: 'memory', sessionFacts: 0, chars: 0, approxTokens: 0 });
  }));
