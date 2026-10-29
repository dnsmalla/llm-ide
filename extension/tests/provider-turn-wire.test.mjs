// Every event a provider turn emits must be a declared agent/v2 event, with no
// key the schema does not name: the Mac decodes this stream with the same
// decoder as a Claude turn. (The route's own contract entry cannot use
// x-events, which demands every variant be exercised; see provider-catalog.schema.json.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { freshDb, fakeFetch, jsonResponse } from './provider-test-env.mjs';

const { readJson, makeSchemaWalker, variantFor, checkDoc } = await import('../../scripts/lib/conformance.mjs');
const conns = await import('../server/provider-connections.mjs');
const { runProviderTurn } = await import('../llm_agent/adapter/provider-turn.mjs');
const { answerDecision } = await import('../llm_agent/sdk/decisions.mjs');
const { flagQuota } = await import('../kb/usage.mjs');
const models = await import('../providers/provider-models.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readJson(path.join(here, '../../schema/agent-v2/agent-v2.schema.json'));
const walker = makeSchemaWalker(schema);

function validate(evs) {
  assert.ok(evs.length > 0);
  for (const ev of evs) {
    const v = variantFor(schema.oneOf, ev);
    assert.ok(v, `no agent/v2 variant for ${JSON.stringify(ev)}`);
    const { problems } = checkDoc({ walker, node: v, doc: ev, name: ev.type, label: `the schema variant "${v.title}"` });
    assert.deepEqual(problems, [], `${ev.type}: ${problems.join('; ')}`);
  }
}

const usage = (i, o) => ({ inputTokens: { total: i }, outputTokens: { total: o } });
const toolStep = (id, name, input) => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id, toolName: name }, { type: 'tool-input-delta', id, delta: JSON.stringify(input) }, { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(10, 5) },
];
const textStep = (t) => [
  { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(12, 2) },
];
const script = (...steps) => { let i = 0; return new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: steps[Math.min(i++, steps.length - 1)] }) }) }); };

function setup() {
  const { db, users: [a] } = freshDb(1);
  models._clearModelCacheForTests();
  conns.connectProvider(a, { catalogId: 'groq', apiKey: 'sk-wire-test-0123456789abcdef' }, db);
  conns.connectProvider(a, { catalogId: 'cerebras', apiKey: 'sk-wire-test-0123456789abcdef' }, db);
  conns.updateSettings(a, { toolsEnabled: true }, db);
  const fetchImpl = fakeFetch((url) => jsonResponse({ data: [{ id: url.includes('cerebras') ? 'llama-3.3-70b' : 'llama-3.3-70b-versatile' }] }));
  return { db, a, fetchImpl };
}
const run = (s, over, model) => {
  const evs = [];
  const p = runProviderTurn({
    userId: s.a, provider: 'custom:cat-groq', model: 'llama-3.3-70b-versatile', message: 'go', mode: 'execute', agentContext: {},
    onEvent: (e) => { evs.push(e); over?.on?.(e, evs); }, deps: { db: s.db, fetchImpl: s.fetchImpl, modelFor: () => model }, ...over?.args,
  });
  return p.then(() => evs);
};

test('a tool turn emits only declared agent/v2 events', async () => {
  const s = setup();
  validate(await run(s, null, script(toolStep('c1', 'task-create', { title: 't' }), textStep('done'))));
});

test('approval events match the ToolApproval variant', async () => {
  const s = setup();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptw-'));
  const evs = await run(s, {
    args: { agentContext: { workspaceRoot: ws } },
    on: (e, all) => {
      if (e.type === 'approval_request') {
        const init = all.find((x) => x.type === 'init');
        setImmediate(() => answerDecision({ requestId: e.requestId, sdkSessionId: init.sessionId, userId: s.a, action: 'deny' }));
      }
    },
  }, script(toolStep('c1', 'run-bash', { command: 'echo a && echo b' }), textStep('ok')));
  assert.ok(evs.some((e) => e.type === 'approval_request'));
  validate(evs);
});

test('the fallback and tools-unavailable notices and an error event are declared', async () => {
  const s = setup();
  conns.updateSettings(s.a, { fallbackEnabled: true, fallbackOrder: [{ provider: 'custom:cat-cerebras', model: 'llama-3.3-70b' }] }, s.db);
  flagQuota(s.db, s.a, 'custom:cat-groq', 'llama-3.3-70b-versatile');
  const evs = await run(s, null, script(textStep('x')));
  assert.equal(evs[0].kind, 'provider_fallback');
  validate(evs);
  const s2 = setup();
  const bad = new MockLanguageModelV3({ doStream: async () => { throw Object.assign(new Error('nope'), { statusCode: 503 }); } });
  const errEvs = await run(s2, { args: { model: 'brand-new', mode: 'ask' } }, bad);
  assert.ok(errEvs.some((e) => e.kind === 'tools_unavailable'));
  assert.ok(errEvs.some((e) => e.type === 'error'));
  validate(errEvs);
});
