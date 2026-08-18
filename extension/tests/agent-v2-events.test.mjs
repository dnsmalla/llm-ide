// Tests for the v2 engine event mapper (llm_agent/sdk/events.mjs).
//
// mapSdkMessage is pure — no SDK objects, no DB, no network — so this suite
// is fully hermetic: it drives fabricated SDK messages and pins the wire
// event shapes the Mac UI depends on. The spike suite
// (agent-sdk-spike.test.mjs) keeps exercising the same mapper through its
// re-export from spike-engine.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapSdkMessage } from '../llm_agent/sdk/events.mjs';

// --- init --------------------------------------------------------------------

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

// --- stream events -------------------------------------------------------------

test('mapSdkMessage: stream deltas map to delta / tool_use_start / tool_args_delta', () => {
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }),
    [{ type: 'delta', text: 'Hi' }],
  );
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu_1', name: 'mcp__llmide__kb_search' } } }),
    [{ type: 'tool_use_start', id: 'tu_1', name: 'mcp__llmide__kb_search' }],
  );
  // No explicit index (single-tool turn) defaults to block index 0.
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

// --- tool results --------------------------------------------------------------

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

// --- usage + result + passthrough ----------------------------------------------

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

test('tool_args_delta carries the block index for multi-tool turns', () => {
  assert.deepEqual(
    mapSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q"' } } }),
    [{ type: 'tool_args_delta', index: 2, partialJson: '{"q"' }],
  );
});

test('assistant message maps to a usage event from message.message.usage', () => {
  const [ev] = mapSdkMessage({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 40 } },
  });
  assert.equal(ev.type, 'usage');
  assert.equal(ev.inputTokens, 100);
  assert.equal(ev.outputTokens, 5);
  assert.equal(ev.cacheReadTokens, 40);
});

// --- usage edge cases ----------------------------------------------------------

test('assistant message without usage is dropped, not passed through', () => {
  // The streamed deltas already carried the text; a complete assistant
  // message without a usage block adds nothing to the wire.
  assert.deepEqual(
    mapSdkMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    [],
  );
});
