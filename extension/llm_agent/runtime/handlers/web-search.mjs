import {
  searchWebViaAnthropic,
  searchWebViaCli,
  searchWeb,
} from '../../../agents/web-client.mjs';
import { providerApiKey } from '../../../agents/providers.mjs';
import { getSecret } from '../../../server/vault.mjs';
import { getDb } from '../../../kb/db.mjs';

// Optional SerpAPI key (last-resort fallback): user vault first, then env.
function serpApiKey(userId) {
  if (userId) {
    try { return getSecret(getDb(), userId, 'serpapi.apiKey') || process.env.LLMIDE_SERPAPI_KEY || null; }
    catch { /* no key stored */ }
  }
  return process.env.LLMIDE_SERPAPI_KEY || null;
}

/**
 * Handler for the web-search read-skill. Web search "like Claude does":
 *   1. Anthropic API key present → native `web_search` tool (no SerpAPI).
 *   2. Otherwise → the `claude` CLI's built-in WebSearch (subscription login).
 *   3. Otherwise, if a SerpAPI key is configured → SerpAPI (fallback).
 * Returns { answer, sources: [{title, url}], count } on success.
 */
export async function handleWebSearch(args, { userId } = {}) {
  if (!args?.query) {
    return { error: 'Missing query argument' };
  }

  const errors = [];

  // 1. Native Anthropic API (reuses the existing Anthropic credential).
  const apiKey = providerApiKey(userId, 'anthropic');
  if (apiKey) {
    try {
      const { answer, sources } = await searchWebViaAnthropic(args.query, { apiKey });
      if (answer) return { answer, sources, count: sources.length };
    } catch (err) { errors.push(`api: ${err.message}`); }
  }

  // 2. claude CLI WebSearch (subscription login, no key).
  try {
    const { answer, sources } = await searchWebViaCli(args.query);
    if (answer) return { answer, sources, count: sources.length };
  } catch (err) { errors.push(`cli: ${err.message}`); }

  // 3. SerpAPI fallback — normalized into the same { answer, sources } shape.
  const serp = serpApiKey(userId);
  if (serp) {
    try {
      const { results } = await searchWeb(args.query, { apiKey: serp });
      const sources = results.map(r => ({ title: r.title, url: r.link }));
      const answer = results.map(r => `- ${r.title}: ${r.snippet} (${r.link})`).join('\n');
      return { answer, sources, count: sources.length };
    } catch (err) { errors.push(`serpapi: ${err.message}`); }
  }

  return {
    error: 'Web search unavailable. Configure an Anthropic API key, log in to the `claude` CLI, '
      + 'or set a SerpAPI key in Settings → Providers.'
      + (errors.length ? ` (${errors.join('; ')})` : ''),
  };
}

// ──── Tests (run via: node llm_agent/runtime/handlers/web-search.mjs)

export async function runTests() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const tests = [];

  tests.push({
    name: 'handleWebSearch: returns error on missing query',
    fn: async () => {
      const result = await handleWebSearch({}, { userId: null });
      assert(result.error, 'expected error');
      assert(result.error.includes('query'), 'wrong error message');
    },
  });

  tests.push({
    name: 'handleWebSearch: uses native Anthropic web_search when an API key is present',
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
              { type: 'text', text: 'Node uses an event loop.' },
              { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Node docs', url: 'https://nodejs.org' }] },
            ],
          }),
        };
      };
      try {
        const result = await handleWebSearch({ query: 'node event loop' }, { userId: null });
        assert(!result.error, `unexpected error: ${result.error}`);
        assert(result.answer.includes('event loop'), 'answer should carry the synthesized text');
        assert(result.sources[0]?.url === 'https://nodejs.org', 'source url should be parsed');
        assert(result.count === 1, 'count should match sources');
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
