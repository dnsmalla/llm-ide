import { test } from 'node:test';
import assert from 'node:assert/strict';

// Secrets must exist before web-client (which imports providers → kb/db) loads.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { searchWeb, fetchUrl, searchWebViaAnthropic, fetchUrlViaAnthropic } =
  await import('../agents/web-client.mjs');

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

// ── SerpAPI fallback (unchanged) ──────────────────────────────────────

test('searchWeb: throws on missing API key', async () => {
  await assert.rejects(() => searchWeb('test'), /SerpAPI key required/);
});

test('searchWeb: throws on empty query', async () => {
  await assert.rejects(() => searchWeb('', { apiKey: 'test' }), /non-empty string/);
});

test('fetchUrl: throws on invalid URL', async () => {
  await assert.rejects(() => fetchUrl('not a url'), /Invalid URL/);
});

test('fetchUrl: throws on empty URL', async () => {
  await assert.rejects(() => fetchUrl(''), /non-empty string/);
});

// ── Anthropic-native backends ─────────────────────────────────────────

test('searchWebViaAnthropic: throws without an API key', async () => {
  await assert.rejects(() => searchWebViaAnthropic('test'), /API key required/);
});

test('searchWebViaAnthropic: posts to Anthropic and parses answer + sources', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.match(String(url), /api\.anthropic\.com\/v1\/messages/);
    const body = JSON.parse(opts.body);
    assert.equal(body.tools[0].name, 'web_search');
    return {
      ok: true,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: 'Summary text.' },
          { type: 'web_search_tool_result', content: [
            { type: 'web_search_result', title: 'Doc', url: 'https://example.com' },
          ] },
        ],
      }),
    };
  });
  try {
    const { answer, sources } = await searchWebViaAnthropic('q', { apiKey: 'k' });
    assert.equal(answer, 'Summary text.');
    assert.deepEqual(sources, [{ title: 'Doc', url: 'https://example.com' }]);
  } finally { restore(); }
});

test('searchWebViaAnthropic: walks a pause_turn before returning', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, json: async () => ({ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 't1' }] }) };
    }
    return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }) };
  });
  try {
    const { answer } = await searchWebViaAnthropic('q', { apiKey: 'k' });
    assert.equal(answer, 'Done.');
    assert.equal(calls, 2);
  } finally { restore(); }
});

test('fetchUrlViaAnthropic: parses title from the tool result and text from synthesis', async () => {
  const restore = mockFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.tools[0].name, 'web_fetch');
    return {
      ok: true,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: 'Page summary.' },
          { type: 'web_fetch_tool_result', content: [{ type: 'web_fetch_result', title: 'Example', url: 'https://example.com' }] },
        ],
      }),
    };
  });
  try {
    const { title, text } = await fetchUrlViaAnthropic('https://example.com', { apiKey: 'k' });
    assert.equal(title, 'Example');
    assert.equal(text, 'Page summary.');
  } finally { restore(); }
});

test('searchWebViaAnthropic: surfaces a non-OK status', async () => {
  const restore = mockFetch(async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
  try {
    await assert.rejects(() => searchWebViaAnthropic('q', { apiKey: 'k' }), /Anthropic web tool 401/);
  } finally { restore(); }
});
