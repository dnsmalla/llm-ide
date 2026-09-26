// The runner half of llm_agent/sdk/turn-context.mjs.
//
// buildEngineOptions decides WHAT to send given what an SDK session already
// holds (agent-v2-prompt-order.test.mjs). This file pins WHEN that record is
// written: only once the model actually received the turn, under the session
// id the stream reported, and never across a compaction, which may summarise
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-turn-context-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn } = await import('../llm_agent/sdk/engine.mjs');
const { __resetDeliveredForTest, deliveredFor } = await import('../llm_agent/sdk/turn-context.mjs');

beforeEach(() => __resetDeliveredForTest());

const FACTS = ['User chose the phased approach'];
const ATTACH = [{ path: 'A.swift', content: 'A'.repeat(500) }];

// A scripted SDK stream. `progress: false` models a turn that dies before the
// model produced anything — the prompt may never have been delivered.
function scriptedQuery(capture, { sessionId, progress = true, compact = false } = {}) {
  return (prompt, options) => {
    capture.prompts.push(prompt);
    capture.options = options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: sessionId, tools: [], capabilities: [] };
      if (compact) yield { type: 'system', subtype: 'compact_boundary', session_id: sessionId };
      if (progress) {
        yield { type: 'stream_event', session_id: sessionId,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } };
      }
      yield { type: 'result', subtype: 'success', session_id: sessionId };
    })();
  };
}

async function turn({ resume = null, sessionId = 'sdk-1', ...script } = {}, capture = { prompts: [] }) {
  const out = await runAgentV2Turn({
    message: 'continue', userId: 'u-ctx', mode: 'execute',
    agentContext: { workspaceRoot: process.cwd(), chatSessionId: 'chat-ctx' },
    attachments: ATTACH,
    resumeSdkSessionId: resume,
    allowAmbientAuth: true,
    onEvent: () => {},
    queryFactory: scriptedQuery(capture, { sessionId, ...script }),
  }, {
    readSkill: () => null, roots: () => [],
    sessionMemory: () => FACTS, persistMemory: async () => null,
  });
  return { ...out, capture };
}

test('a delivered turn is recorded under the reported session; the resumed turn does not repeat it', async () => {
  const capture = { prompts: [] };
  await turn({ resume: null, sessionId: 'sdk-1' }, capture);
  assert.match(capture.prompts[0], /A{500}/);
  assert.match(capture.prompts[0], /User chose the phased approach/);
  assert.ok(deliveredFor('sdk-1'), 'recorded under the id the stream reported');

  await turn({ resume: 'sdk-1', sessionId: 'sdk-1' }, capture);
  assert.ok(!capture.prompts[1].includes('A'.repeat(500)), 'the same attachment is not re-sent');
  assert.ok(!capture.prompts[1].includes('User chose the phased approach'), 'a known fact is not re-sent');
});

test('a turn that never produced anything records nothing — the next turn re-delivers', async () => {
  const capture = { prompts: [] };
  await turn({ resume: null, sessionId: 'sdk-2', progress: false }, capture);
  assert.equal(deliveredFor('sdk-2'), null);
  await turn({ resume: 'sdk-2', sessionId: 'sdk-2' }, capture);
  assert.match(capture.prompts[1], /A{500}/);
});

test('a compaction forgets what was delivered, so the next turn re-delivers', async () => {
  const capture = { prompts: [] };
  await turn({ resume: null, sessionId: 'sdk-3' }, capture);
  await turn({ resume: 'sdk-3', sessionId: 'sdk-3', compact: true }, capture);
  assert.equal(deliveredFor('sdk-3'), null);
  await turn({ resume: 'sdk-3', sessionId: 'sdk-3' }, capture);
  assert.match(capture.prompts[2], /User chose the phased approach/);
});

test('a session resumed under a new id moves the record', async () => {
  await turn({ resume: null, sessionId: 'sdk-4' });
  await turn({ resume: 'sdk-4', sessionId: 'sdk-4b' });
  assert.equal(deliveredFor('sdk-4'), null);
  assert.ok(deliveredFor('sdk-4b'));
});
