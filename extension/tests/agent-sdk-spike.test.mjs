// Tests for the P0 Claude Agent SDK spike (llm_agent/sdk/spike-engine.mjs
// + the POST /agent-sdk/spike SSE route in server/ai-routes.mjs).
//
// Hermetic by default: mapSdkMessage is pure, and the endpoint test drives
// the no-API-key error path (no network, no SDK subprocess, no spawn).
// The live smoke — a real streaming query that must call the kb_search
// in-process tool — is skipped unless RUN_AGENT_SDK_SPIKE=1 (and a vault
// claude.apiKey or ANTHROPIC_API_KEY is present). That live test is the
// seed of the P1.5 canary suite: it pins the event shapes the Mac UI will
// depend on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-sdk-spike-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { mapSdkMessage, resolveAnthropicKey } = await import('../llm_agent/sdk/spike-engine.mjs');
const { handleAIRoutes } = await import('../server/ai-routes.mjs');

// --- mapSdkMessage: the P0 event model --------------------------------------

test('mapSdkMessage: system/init maps to init with capabilities + mcp servers', () => {
  const events = mapSdkMessage({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    claude_code_version: '2.1.234',
    model: 'claude-sonnet-5',
    tools: ['Read', 'mcp__llmide__kb_search'],
    capabilities: ['interrupt_receipt_v1', 'some_future_cap'],
    mcp_servers: [{ name: 'llmide', status: 'connected' }],
  });
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'init');
  assert.equal(ev.sessionId, 'sess-1');
  assert.equal(ev.claudeCodeVersion, '2.1.234');
  assert.deepEqual(ev.capabilities, ['interrupt_receipt_v1', 'some_future_cap']);
  assert.deepEqual(ev.mcpServers, [{ name: 'llmide', status: 'connected' }]);
});

test('mapSdkMessage: stream deltas map to delta / tool_use_start / tool_args_delta', () => {
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }),
    [{ type: 'delta', text: 'Hi' }],
  );
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__llmide__kb_search' } } }),
    [{ type: 'tool_use_start', id: 'tu_1', name: 'mcp__llmide__kb_search' }],
  );
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"query":"a' } } }),
    [{ type: 'tool_args_delta', index: 0, partialJson: '{"query":"a' }],
  );
  // Non-content stream events (message_start, message_delta, …) stay quiet —
  // the Mac shouldn't render them.
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'message_start' } }),
    [],
  );
});

test('mapSdkMessage: user tool_result maps with truncation flag', () => {
  const big = 'x'.repeat(25_000);
  const events = mapSdkMessage({
    type: 'user',
    message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: [{ type: 'text', text: big }] },
    ] },
  });
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'tool_result');
  assert.equal(ev.toolUseId, 'tu_1');
  assert.equal(ev.isError, false);
  assert.equal(ev.text.length, 20_000);
  assert.equal(ev.truncated, true);
});

test('mapSdkMessage: result maps cost/turns/session; unknown types pass through raw', () => {
  const [res] = mapSdkMessage({
    type: 'result', subtype: 'success', total_cost_usd: 0.42, num_turns: 3,
    duration_ms: 9000, session_id: 'sess-1', stop_reason: 'end_turn',
  });
  assert.equal(res.type, 'result');
  assert.equal(res.costUsd, 0.42);
  assert.equal(res.numTurns, 3);
  assert.equal(res.sessionId, 'sess-1');

  const [passthrough] = mapSdkMessage({ type: 'system', subtype: 'compact_boundary', foo: 'bar' });
  assert.equal(passthrough.type, 'sdk');
  assert.equal(passthrough.subtype, 'compact_boundary');
  assert.equal(passthrough.raw.foo, 'bar');

  assert.deepEqual(mapSdkMessage(null), []);
  assert.deepEqual(mapSdkMessage('nope'), []);
});

// --- Endpoint wiring ---------------------------------------------------------

function makeReq({ method, url, body }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    user: { id: null },
    _chunks: chunks,
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      else if (event === 'close') { /* no-op */ }
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
    sseEvents() {
      return this._body.split('\n\n')
        .filter((b) => b.startsWith('data: '))
        .map((b) => JSON.parse(b.slice(6)));
    },
  };
}

test('POST /agent-sdk/spike without prompt → 400 VALIDATION_FAILED', async () => {
  const res = makeRes();
  const handled = await handleAIRoutes(makeReq({ method: 'POST', url: '/agent-sdk/spike', body: {} }), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');
});

test('POST /agent-sdk/spike with no API key → SSE spike_start + error events (no spawn)', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY; // userId null → vault skipped → no key anywhere
  try {
    const res = makeRes();
    const handled = await handleAIRoutes(
      makeReq({ method: 'POST', url: '/agent-sdk/spike', body: { prompt: 'search the KB for anything' } }),
      res,
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    const events = res.sseEvents();
    assert.equal(events[0].type, 'spike_start');
    const err = events.find((e) => e.type === 'error');
    assert.ok(err, 'expected an error event');
    assert.match(err.error, /No Anthropic API key/i);
    assert.equal(res.ended, true);
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('resolveAnthropicKey: prefers env when no vault user', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    assert.deepEqual(resolveAnthropicKey(null), { key: 'sk-ant-test', source: 'env' });
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

// --- Live smoke (opt-in; the future canary) ----------------------------------
// RUN_AGENT_SDK_SPIKE=1 with a vault key or ANTHROPIC_API_KEY. Spends a few
// cents; asserts the full round trip: init → tool_use_start(kb_search) →
// tool_result → result.
test('live: streaming query calls kb_search end-to-end', { skip: !process.env.RUN_AGENT_SDK_SPIKE }, async () => {
  const { runSpikeQuery } = await import('../llm_agent/sdk/spike-engine.mjs');
  const events = [];
  const out = await runSpikeQuery({
    prompt: 'Use the kb_search tool with query "meeting" (limit 3), then briefly say what you found.',
    userId: null,
    onEvent: (ev) => events.push(ev),
    allowAmbientAuth: true, // no vault/env key in CI-ish contexts — use the operator's claude login
  });
  assert.ok(out.sessionId, 'expected a session id from init');
  const init = events.find((e) => e.type === 'init');
  assert.ok(init, 'expected an init event');
  assert.ok(init.claudeCodeVersion, 'init carries claude_code_version');
  const toolStart = events.find((e) => e.type === 'tool_use_start' && /kb_search/.test(e.name || ''));
  assert.ok(toolStart, 'expected the model to call mcp__llmide__kb_search');
  assert.ok(events.some((e) => e.type === 'tool_result'), 'expected a tool_result');
  const result = events.find((e) => e.type === 'result');
  assert.ok(result, 'expected a result event');
  assert.equal(result.subtype, 'success');
  assert.ok(typeof result.costUsd === 'number');
});
