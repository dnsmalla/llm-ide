import { test } from 'node:test';
import assert from 'node:assert/strict';

// A streamed Anthropic reply carries its usage in `message_start` (input +
// cache) and `message_delta` (cumulative output). It used to be dropped, so a
// classic turn's token total left out its final — usually largest — reply.
const { runClaudeStream } = await import('../providers/runtime.mjs');
const { newTurnTokenTotals, countTurnTokens } = await import('../kb/usage.mjs');

function sseBody(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
}

test('runClaudeStream meters the streamed reply from message_start / message_delta', async () => {
  const original = globalThis.fetch;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map(),
    body: sseBody([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4 } } },
      { type: 'content_block_delta', delta: { text: 'Hel' } },
      { type: 'content_block_delta', delta: { text: 'lo' } },
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]),
  });
  try {
    const chunks = [];
    const totals = newTurnTokenTotals();
    const text = await countTurnTokens(totals, () =>
      runClaudeStream('hi', { model: 'claude-sonnet-5', onChunk: (t) => chunks.push(t) }));
    assert.equal(text, 'Hello');
    assert.deepEqual(chunks, ['Hel', 'lo']);
    assert.deepEqual(
      { input: totals.inputTokens, output: totals.outputTokens, cacheRead: totals.cacheReadTokens, calls: totals.calls },
      { input: 10, output: 7, cacheRead: 4, calls: 1 });
  } finally {
    globalThis.fetch = original;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
