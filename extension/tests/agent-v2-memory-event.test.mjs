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

// The block is re-sent on every turn, so it is capped to the NEWEST facts —
// the on-disk list (up to 200 × 500 chars) stays complete, only the prompt
// copy is trimmed. The memory event must count what was actually injected,
// not what is stored, or the brain button would overstate the cost.
test('a long session injects only the newest facts, under both the count and the char ceiling',
  withAnthropicKey('sk-ant-mem-3', async () => {
    const facts = Array.from({ length: 200 }, (_, i) => `fact ${String(i).padStart(3, '0')} ${'x'.repeat(180)}`);
    const { events, capture } = await turnWith({ sessionFacts: facts, tag: 'long' });
    const mem = events.filter((e) => e.type === 'memory');
    assert.equal(mem.length, 1);
    assert.ok(mem[0].sessionFacts < 200, 'not every stored fact rides the prompt');
    assert.ok(mem[0].sessionFacts <= 40);
    assert.ok(mem[0].chars <= 8_000 + '## This session\'s memory\n'.length);
    const appended = capture.options.systemPrompt?.append ?? JSON.stringify(capture.options);
    assert.match(appended, /fact 199 /, 'the newest fact is kept');
    assert.doesNotMatch(appended, /fact 000 /, 'the oldest fact is dropped');
    assert.equal(mem[0].approxTokens, Math.round(mem[0].chars / 4));
  }));

test('capSessionMemory keeps order (oldest-first) and never returns an empty list for one oversized fact', async () => {
  const { capSessionMemory } = await import('../kb/session-memory.mjs');
  assert.deepEqual(capSessionMemory(['a', 'b', 'c'], { maxFacts: 2 }), ['b', 'c']);
  assert.deepEqual(capSessionMemory(['a'.repeat(50), 'b'.repeat(50)], { maxChars: 60 }), ['b'.repeat(50)]);
  assert.deepEqual(capSessionMemory(['z'.repeat(500)], { maxChars: 10 }), ['z'.repeat(500)]);
  assert.deepEqual(capSessionMemory([], {}), []);
  assert.deepEqual(capSessionMemory(null, {}), []);
});
