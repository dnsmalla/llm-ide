// Tests for runClaude's exponential backoff on Anthropic 529/503.
// Mocks global fetch so we don't hit the real API.

import test from 'node:test';
import assert from 'node:assert/strict';

const ORIG_FETCH = globalThis.fetch;

function mockFetchSequence(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body || {}),
    };
  };
}

const okResponse = {
  status: 200,
  body: { content: [{ text: 'final answer' }] },
};
const overloaded = { status: 529, body: { error: { type: 'overloaded' } } };
const unavailable = { status: 503, body: { error: { type: 'unavailable' } } };
const unauthorized = { status: 401, body: { error: { type: 'auth' } } };

test('runClaude: 529 then 200 → returns content (one retry)', async () => {
  globalThis.fetch = mockFetchSequence([overloaded, okResponse]);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const { runClaude } = await import(`../agents/runtime.mjs?cb=${Date.now()}`);
  const out = await runClaude('hello');
  assert.equal(out, 'final answer');
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = ORIG_FETCH;
});

test('runClaude: 503 then 200 → returns content', async () => {
  globalThis.fetch = mockFetchSequence([unavailable, okResponse]);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const { runClaude } = await import(`../agents/runtime.mjs?cb=${Date.now() + 1}`);
  const out = await runClaude('hello');
  assert.equal(out, 'final answer');
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = ORIG_FETCH;
});

test('runClaude: 200 first call → no retries needed', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true, status: 200,
      json: async () => okResponse.body,
      text: async () => JSON.stringify(okResponse.body),
    };
  };
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const { runClaude } = await import(`../agents/runtime.mjs?cb=${Date.now() + 2}`);
  const out = await runClaude('hello');
  assert.equal(out, 'final answer');
  assert.equal(calls, 1);
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = ORIG_FETCH;
});
