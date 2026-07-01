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

// ── SSRF via redirect (the High finding) ──────────────────────────────
// The handler validates only the FIRST url; fetchUrl must re-check every
// redirect hop or a 302 → private/metadata IP gets fetched unchecked.

const res302 = (location) => ({ status: 302, ok: false, headers: new Headers({ location }) });
const res200 = (html) => ({ status: 200, ok: true, headers: new Headers(), text: async () => html });

test('fetchUrl: blocks a redirect to a private/loopback IP (SSRF)', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(opts.redirect, 'manual', 'must not let fetch auto-follow redirects');
    if (String(url) === 'https://example.com/') return res302('https://127.0.0.1/secret');
    throw new Error(`SSRF: the private target must never be fetched (got ${url})`);
  });
  try {
    await assert.rejects(() => fetchUrl('https://example.com/'), /private|loopback|SSRF/);
  } finally { restore(); }
});

test('fetchUrl: blocks a redirect to a non-https target (cloud metadata SSRF)', async () => {
  const restore = mockFetch(async (url) => {
    if (String(url) === 'https://example.com/') return res302('http://169.254.169.254/latest/meta-data/');
    throw new Error(`SSRF: the metadata target must never be fetched (got ${url})`);
  });
  try {
    await assert.rejects(() => fetchUrl('https://example.com/'), /https|SSRF/);
  } finally { restore(); }
});

test('fetchUrl: follows a safe https redirect and returns parsed content', async () => {
  // 93.184.216.34 is a public literal IP — dns.lookup returns it without a
  // network query, so the test stays hermetic while exercising the allow path.
  const restore = mockFetch(async (url) => {
    if (String(url) === 'https://example.com/') return res302('https://93.184.216.34/page');
    if (String(url) === 'https://93.184.216.34/page') return res200('<title>Hi</title><p>Body text</p>');
    throw new Error(`unexpected url ${url}`);
  });
  try {
    const { title, text } = await fetchUrl('https://example.com/');
    assert.equal(title, 'Hi');
    assert.match(text, /Body text/);
  } finally { restore(); }
});

test('fetchUrl: rejects after exceeding the redirect cap', async () => {
  const restore = mockFetch(async () => res302('https://93.184.216.34/loop'));
  try {
    await assert.rejects(() => fetchUrl('https://example.com/', { maxRedirects: 3 }), /Too many redirects/);
  } finally { restore(); }
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
