import {
  fetchUrlViaAnthropic,
  fetchUrlViaCli,
  fetchUrl,
} from '../../../agents/web-client.mjs';
import { assertSafeBaseUrlResolved, providerApiKey } from '../../../agents/providers.mjs';

/**
 * Handler for the fetch-url read-skill. Reads a URL "like Claude does":
 *   1. Anthropic API key present → native `web_fetch` tool.
 *   2. Otherwise → the `claude` CLI's built-in WebFetch (subscription login).
 *   3. Otherwise → a direct HTTP fetch + HTML strip (fallback).
 * `assertSafeBaseUrlResolved` runs first as an SSRF guard — it blocks
 * localhost/private targets and, for the direct-fetch fallback, is the only
 * thing standing between the URL and our own network.
 * Returns { title, text } on success.
 */
export async function handleFetchUrl(args, { userId } = {}) {
  if (!args?.url) {
    return { error: 'Missing url argument' };
  }

  // Validate URL and check SSRF (block private IPs, localhost, etc.).
  try {
    await assertSafeBaseUrlResolved(args.url);
  } catch (err) {
    return { error: `URL blocked for security: ${err.message}` };
  }

  const errors = [];

  // 1. Native Anthropic API (reuses the existing Anthropic credential).
  const apiKey = providerApiKey(userId, 'anthropic');
  if (apiKey) {
    try {
      const { title, text } = await fetchUrlViaAnthropic(args.url, { apiKey });
      if (text) return { title, text };
    } catch (err) { errors.push(`api: ${err.message}`); }
  }

  // 2. claude CLI WebFetch (subscription login, no key).
  try {
    const { title, text } = await fetchUrlViaCli(args.url);
    if (text) return { title, text };
  } catch (err) { errors.push(`cli: ${err.message}`); }

  // 3. Direct HTTP fetch + HTML strip (SSRF already checked above).
  try {
    const { title, text } = await fetchUrl(args.url);
    return { title, text };
  } catch (err) {
    errors.push(`direct: ${err.message}`);
    return { error: `Failed to fetch URL: ${errors.join('; ')}` };
  }
}

// ──── Tests (run via: node llm_agent/runtime/handlers/fetch-url.mjs)

export async function runTests() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const tests = [];

  tests.push({
    name: 'handleFetchUrl: returns error on missing url',
    fn: async () => {
      const result = await handleFetchUrl({}, { userId: null });
      assert(result.error, 'expected error');
      assert(result.error.includes('url'), 'wrong error message');
    },
  });

  tests.push({
    name: 'handleFetchUrl: blocks localhost (SSRF) before any backend',
    fn: async () => {
      const result = await handleFetchUrl({ url: 'http://localhost:3000' }, { userId: null });
      assert(result.error, 'expected error');
      assert(result.error.includes('blocked'), 'wrong error message');
    },
  });

  tests.push({
    name: 'handleFetchUrl: blocks 127.0.0.1 (SSRF) before any backend',
    fn: async () => {
      const result = await handleFetchUrl({ url: 'http://127.0.0.1:3456' }, { userId: null });
      assert(result.error, 'expected error');
      assert(result.error.includes('blocked'), 'wrong error message');
    },
  });

  tests.push({
    name: 'handleFetchUrl: uses native Anthropic web_fetch when an API key is present',
    fn: async () => {
      const savedFetch = globalThis.fetch;
      const savedKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      globalThis.fetch = async (url) => {
        assert(String(url).includes('api.anthropic.com'), `unexpected url ${url}`);
        return {
          ok: true,
          json: async () => ({
            stop_reason: 'end_turn',
            content: [
              { type: 'text', text: 'The page describes an example domain.' },
              { type: 'web_fetch_tool_result', content: [{ type: 'web_fetch_result', title: 'Example Domain', url: 'https://example.com' }] },
            ],
          }),
        };
      };
      try {
        const result = await handleFetchUrl({ url: 'https://example.com' }, { userId: null });
        assert(!result.error, `unexpected error: ${result.error}`);
        assert(result.text.includes('example domain'), 'text should carry the synthesis');
        assert(result.title === 'Example Domain', 'title should be parsed from the tool result');
      } finally {
        globalThis.fetch = savedFetch;
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
      }
    },
  });

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
    } catch (e) {
      console.log(`✗ ${t.name}: ${e.message}`);
      throw e;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runTests();
}
