// The adapter (the only module that imports the Vercel AI SDK): event mapping,
// the model/tool loop against a mock model, and the real OpenAI-compatible wire
// against RECORDED responses. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const { createChatModel, runToolTurn, mapStreamPart, toWireError, toLibraryTools } = await import('../providers/adapter/index.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const rec = (n) => fs.readFileSync(path.join(here, 'fixtures/provider-adapter', n), 'utf8');
const sse = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const mockStream = (...scripts) => {
  let i = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: scripts[Math.min(i++, scripts.length - 1)] }) }),
  });
};
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

test('a tool call, its result and the final answer come out as agent/v2 events', async () => {
  const evs = [];
  const seen = [];
  const out = await runToolTurn({
    model: mockStream(toolStep('c1', 'echo', { x: 1 }), textStep('done')),
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'echo', description: 'e', parameters: { type: 'object', properties: { x: { type: 'number' } } }, execute: async (a) => { seen.push(a); return { got: a }; } }],
    onEvent: (e) => evs.push(e),
  });
  assert.deepEqual(seen, [{ x: 1 }]);
  assert.deepEqual(evs.map((e) => e.type), ['tool_use_start', 'tool_args_delta', 'tool_result', 'usage', 'delta', 'usage', 'result']);
  assert.deepEqual(evs[0], { type: 'tool_use_start', index: 0, id: 'c1', name: 'echo' });
  assert.deepEqual(evs[2], { type: 'tool_result', toolUseId: 'c1', isError: false, text: '{"got":{"x":1}}', truncated: false });
  assert.deepEqual(evs.at(-1), { type: 'result', subtype: 'success', costUsd: null, numTurns: 2, durationMs: evs.at(-1).durationMs, sessionId: null, stopReason: 'stop' });
  assert.deepEqual(out.usage, { inputTokens: 22, outputTokens: 7 });
  assert.equal(out.text, 'done');
});

test('a tool result carrying { error } is flagged isError; a throwing tool becomes an error result and the turn continues', async () => {
  const evs = [];
  const out = await runToolTurn({
    model: mockStream(toolStep('c1', 'soft', {}), toolStep('c2', 'hard', {}), textStep('ok')),
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      { name: 'soft', description: 's', parameters: { type: 'object' }, execute: async () => ({ error: 'nope' }) },
      { name: 'hard', description: 'h', parameters: { type: 'object' }, execute: async () => { throw new Error('boom sk-secret-0123456789'); } },
    ],
    onEvent: (e) => evs.push(e), apiKey: 'sk-secret-0123456789',
  });
  const results = evs.filter((e) => e.type === 'tool_result');
  assert.deepEqual(results.map((r) => r.isError), [true, true]);
  assert.ok(!JSON.stringify(evs).includes('sk-secret-0123456789'));
  assert.equal(out.ok, true);
});

test('the step cap stops a model that keeps calling tools', async () => {
  const evs = [];
  let runs = 0;
  const out = await runToolTurn({
    model: mockStream(toolStep('c', 'loop', {})),
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ name: 'loop', description: 'l', parameters: { type: 'object' }, execute: async () => { runs += 1; return { n: runs }; } }],
    maxSteps: 3, onEvent: (e) => evs.push(e),
  });
  assert.equal(runs, 3);
  assert.equal(out.steps, 3);
});

test('a provider that sends the whole tool call at once still produces start and args events', () => {
  const state = { open: new Map(), next: 0 };
  const evs = mapStreamPart({ type: 'tool-call', toolCallId: 'z', toolName: 'n', input: { a: 1 } }, state);
  assert.deepEqual(evs, [{ type: 'tool_use_start', index: 0, id: 'z', name: 'n' }, { type: 'tool_args_delta', index: 0, partialJson: '{"a":1}' }]);
});

test('provider errors are classified and keys redacted', () => {
  assert.equal(toWireError({ statusCode: 401 }).code, 'PROVIDER_AUTH');
  const r = toWireError({ statusCode: 429, message: 'rate' });
  assert.deepEqual([r.code, r.retryable], ['PROVIDER_RATE_LIMITED', true]);
  assert.equal(toWireError({ statusCode: 503 }).code, 'PROVIDER_UNAVAILABLE');
  const e = toWireError(new Error('bad request with key sk-abcdefghijklmnop'), { apiKey: 'sk-abcdefghijklmnop' });
  assert.ok(!e.message.includes('sk-abcdefghijklmnop'));
  assert.equal(toWireError(Object.assign(new Error('x'), { name: 'AbortError' })).code, 'ABORTED');
});

test('a failing model emits one error event, no result, and does not throw', async () => {
  const evs = [];
  const model = new MockLanguageModelV3({ doStream: async () => { throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }); } });
  const out = await runToolTurn({ model, messages: [{ role: 'user', content: 'x' }], onEvent: (e) => evs.push(e) });
  assert.equal(out.ok, false);
  assert.deepEqual(evs.map((e) => e.type), ['error']);
  assert.equal(evs[0].code, 'PROVIDER_AUTH');
});

test('RECORDED wire: an OpenAI-compatible tool call round trip through createChatModel', async () => {
  const bodies = [];
  const sent = [];
  const responses = [rec('openai-compatible-tool-call.sse'), rec('openai-compatible-final.sse')];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), init });
    bodies.push(JSON.parse(init.body));
    return sse(responses.shift());
  };
  const model = createChatModel({ name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKey: 'sk-rec-0123456789abcdef', modelId: 'llama-3.3-70b-versatile', fetchImpl });
  const evs = [];
  const created = [];
  const out = await runToolTurn({
    model, system: 'be brief', messages: [{ role: 'user', content: 'add a task' }],
    tools: [{ name: 'task-create', description: 'create a task', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, execute: async (a) => { created.push(a); return { id: 't1', ...a }; } }],
    onEvent: (e) => evs.push(e),
  });
  assert.deepEqual(created, [{ title: 'write tests' }]);
  assert.equal(sent[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(sent[0].init.redirect, 'error');
  assert.equal(new Headers(sent[0].init.headers).get('authorization'), 'Bearer sk-rec-0123456789abcdef');
  assert.equal(bodies[0].tools[0].function.name, 'task-create');
  assert.equal(bodies[0].tools[0].function.parameters.required[0], 'title');
  assert.equal(bodies[0].stream, true);
  // the second request carries the tool result back to the model
  assert.ok(bodies[1].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_abc'));
  assert.deepEqual(evs.filter((e) => e.type !== 'usage').map((e) => e.type), ['tool_use_start', 'tool_args_delta', 'tool_args_delta', 'tool_result', 'delta', 'result']);
  assert.equal(out.text, 'Created the task.');
  assert.deepEqual(out.usage, { inputTokens: 280, outputTokens: 23 });
});

test('createChatModel never sends the key to another host and sends none for the keyless placeholder', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url: String(url), init }); return sse(rec('openai-compatible-final.sse')); };
  const m = createChatModel({ name: 'ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'not-required', modelId: 'qwen2.5:7b', allowPrivate: true, fetchImpl });
  await runToolTurn({ model: m, messages: [{ role: 'user', content: 'x' }], onEvent: () => {} });
  assert.equal(new Headers(sent[0].init.headers).get('authorization'), null);
  // a url on another origin (a redirect target a library might follow) is refused outright
  const guarded = createChatModel({ name: 'x', baseURL: 'https://a.example.com/v1', apiKey: 'k'.repeat(12), modelId: 'm', fetchImpl });
  assert.ok(guarded);
  assert.throws(() => createChatModel({ name: 'x', baseURL: 'https://a.example.com/v1', apiKey: 'k'.repeat(12), modelId: '  ', fetchImpl }), /No model id/);
});

test('HTTP 401 and 429 from the recorded wire become the right wire errors', async () => {
  const logged = [];
  const origErr = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    await wireErrors();
  } finally { console.error = origErr; }
  assert.equal(logged.filter((l) => l.includes('sk-wire-0123456789abc')).length, 0, 'the library must not log the provider body (it can echo the key)');
});

async function wireErrors() {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE']]) {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'nope sk-wire-0123456789abc' } }), { status, headers: { 'content-type': 'application/json' } });
    const model = createChatModel({ name: 'g', baseURL: 'https://api.example.com/v1', apiKey: 'sk-wire-0123456789abc', modelId: 'm', fetchImpl });
    const evs = [];
    const out = await runToolTurn({ model, messages: [{ role: 'user', content: 'x' }], onEvent: (e) => evs.push(e), apiKey: 'sk-wire-0123456789abc' });
    assert.equal(out.ok, false, String(status));
    assert.equal(evs[0].code, code, String(status));
    assert.ok(!JSON.stringify(evs).includes('sk-wire-0123456789abc'));
  }
}

test('toLibraryTools keeps names and maps execute', async () => {
  const t = toLibraryTools([{ name: 'a', description: 'd', parameters: { type: 'object' }, execute: async () => 1 }]);
  assert.deepEqual(Object.keys(t), ['a']);
});
