// A plain completion on a catalog connection: through the adapter (pinned fetch), no tools, metered,
// errors shaped like completeViaApi's. Fake model only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { freshDb } from './provider-test-env.mjs';

const conns = await import('../server/provider-connections.mjs');
const { completeViaAdapter } = await import('../providers/adapter-complete.mjs');
const { runClaude } = await import('../providers/runtime.mjs');

const KEY = 'sk-complete-0123456789abcdef';
const usage = (i, o) => ({ inputTokens: { total: i }, outputTokens: { total: o } });
const textChunks = (t) => [
  { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(12, 3) },
];
const modelOf = (chunks) => new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) });

function setup() {
  const { db, users: [a, b] } = freshDb();
  conns.connectProvider(a, { catalogId: 'deepseek', apiKey: KEY }, db);
  return { db, a, b, provider: 'custom:cat-deepseek' };
}

test('returns the reply text, sends no tools, meters the call under the connection id', async () => {
  const s = setup();
  const model = modelOf(textChunks('the summary'));
  const out = await completeViaAdapter(s.provider, { userId: s.a, model: 'deepseek-chat', prompt: 'summarise', meter: { userId: s.a, endpoint: '/generate-notes' }, deps: { db: s.db, modelFor: () => model } });
  assert.equal(out, 'the summary');
  assert.ok(!model.doStreamCalls[0].tools?.length, 'a completion never offers tools');
  const row = s.db.prepare('SELECT provider, model, endpoint, input_tokens, output_tokens FROM usage_ledger WHERE user_id=?').get(s.a);
  assert.deepEqual({ ...row }, { provider: s.provider, model: 'deepseek-chat', endpoint: '/generate-notes', input_tokens: 12, output_tokens: 3 });
});

test('a connection that is missing, another user\'s, or keyless is PROVIDER_UNAVAILABLE', async () => {
  const s = setup();
  const run = (over) => completeViaAdapter(s.provider, { userId: s.a, model: 'm', prompt: 'x', deps: { db: s.db, modelFor: () => modelOf(textChunks('x')) }, ...over });
  await assert.rejects(run({ userId: s.b }), { code: 'PROVIDER_UNAVAILABLE' });
  await assert.rejects(completeViaAdapter('custom:cat-openai', { userId: s.a, model: 'm', prompt: 'x', deps: { db: s.db } }), { code: 'PROVIDER_UNAVAILABLE' });
  s.db.prepare('DELETE FROM user_secrets WHERE user_id=? AND secret_key=?').run(s.a, 'custom.cat-deepseek.apiKey');
  await assert.rejects(run({}), { code: 'PROVIDER_UNAVAILABLE' });
});

test('a provider failure is thrown with its status and a redacted message; a 401 is not retried', async () => {
  const s = setup();
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => { calls += 1; throw Object.assign(new Error(`bad key ${KEY}`), { statusCode: 401 }); } });
  await assert.rejects(
    completeViaAdapter(s.provider, { userId: s.a, model: 'm', prompt: 'x', deps: { db: s.db, modelFor: () => model } }),
    (e) => e.status === 401 && e.transient === false && !String(e.message).includes(KEY));
  assert.equal(calls, 1);
});

test('a transient 503 is retried then succeeds', async () => {
  const s = setup();
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('overloaded'), { statusCode: 503 });
    return { stream: simulateReadableStream({ chunks: textChunks('ok now') }) };
  } });
  const out = await completeViaAdapter(s.provider, { userId: s.a, model: 'm', prompt: 'x', deps: { db: s.db, modelFor: () => model, sleepImpl: async () => {} } });
  assert.equal(out, 'ok now');
  assert.equal(calls, 2);
});

test('runClaude with a catalog provider reaches the adapter, not the OpenAI-compatible HTTP path', async () => {
  const s = setup();
  const seen = [];
  const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
  _setPinnedFetchForTests(async (url) => {
    seen.push(String(url));
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const body = sse({ id: '1', object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'via pinned' }, finish_reason: null }] })
      + sse({ id: '1', object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
      + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    // runClaude resolves the connection from the live DB handle, so use it through the module's own db
    const { getDb } = await import('../kb/db.mjs');
    assert.equal(getDb(), s.db, 'freshDb installs itself as the live db');
    const out = await runClaude('hello', { userId: s.a, provider: s.provider, model: 'deepseek-chat', autoFallback: false });
    assert.equal(out, 'via pinned');
    assert.ok(seen.every((u) => u.startsWith('https://api.deepseek.com')), seen.join());
  } finally { _setPinnedFetchForTests(null); }
});

test('POST /kb/complete accepts a catalog provider and model end to end (DeepSeek, fake transport)', async () => {
  const s = setup();
  const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
  const { handleCompleteRoutes } = await import('../routes/complete.mjs');
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  let sentBody;
  _setPinnedFetchForTests(async (url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response(
      sse({ id: '1', object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'notes from deepseek' }, finish_reason: null }] })
      + sse({ id: '1', object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })
      + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const chunks = [Buffer.from(JSON.stringify({ prompt: 'Summarise the meeting', provider: s.provider, model: 'deepseek-chat' }))];
  const req = { method: 'POST', url: '/kb/complete', headers: {}, on(e, cb) { if (e === 'data') chunks.forEach(cb); else if (e === 'end') cb(); return req; }, once() { return req; } };
  const res = { statusCode: 200, headers: {}, _b: '', writeHead(c, h) { this.statusCode = c; Object.assign(this.headers, h || {}); }, setHeader() {}, write(c) { this._b += c; }, end(c) { if (c) this._b += c; }, on() { return this; }, once() { return this; } };
  try {
    await handleCompleteRoutes(req, res, { userId: s.a, url: '/kb/complete' });
  } finally { _setPinnedFetchForTests(null); }
  assert.equal(res.statusCode, 200, res._b);
  const reply = JSON.parse(res._b);
  assert.equal(reply.reply, 'notes from deepseek');
  assert.equal(sentBody.model, 'deepseek-chat');
  assert.ok(!sentBody.tools, 'no tools on a completion');
  assert.equal(reply.usage?.inputTokens, 9);
});

test('a tier route naming a catalog connection is usable, and routeOpts hands it to runClaude', async () => {
  const s = setup();
  const { syncTierRouting } = await import('../server/tier-routing.mjs');
  const { routeOpts } = await import('../providers/tier-routing.mjs');
  syncTierRouting({ tiers: { cheap: { provider: s.provider, model: 'deepseek-chat' } }, features: { internal: 'cheap' } }, s.a, s.db);
  const opts = routeOpts(s.a, 'internal', { model: 'claude-x' }, s.db);
  assert.equal(opts.provider, s.provider);
  assert.equal(opts.model, 'deepseek-chat');
  assert.deepEqual(opts.routeFallback, { model: 'claude-x' }, 'the caller\'s own default stays the fallback');
  // a user without that connection gets today's default
  const other = routeOpts(s.b, 'internal', { model: 'claude-x' }, s.db);
  assert.deepEqual(other, { model: 'claude-x' });
});
