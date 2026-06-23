import { searchWeb } from '../../../agents/web-client.mjs';
import { getSecret } from '../../../server/vault.mjs';
import { getDb } from '../../../kb/db.mjs';

/**
 * Handler for the web-search read-skill.
 * Calls SerpAPI to search the web.
 */
export async function handleWebSearch(args, { userId }) {
  if (!args?.query) {
    return { error: 'Missing query argument' };
  }

  // Get SerpAPI key from vault or env
  let apiKey = null;
  if (userId) {
    try {
      apiKey = getSecret(getDb(), userId, 'serpapi.apiKey');
    } catch {
      // User may not have a key stored
    }
  }
  apiKey = apiKey || process.env.LLMIDE_SERPAPI_KEY;

  if (!apiKey) {
    return { error: 'SerpAPI key not configured. Add one in Settings → Providers → Web Search.' };
  }

  try {
    const { results } = await searchWeb(args.query, { apiKey });
    return {
      results: results.map((r, i) => ({ ...r, rank: i + 1 })),
      count: results.length
    };
  } catch (err) {
    return { error: `Web search failed: ${err.message}` };
  }
}

// ──── Tests (run via: cd extension && npm test -- tests/web-search.test.mjs)

export async function runTests() {
  const tests = [];

  tests.push({
    name: 'handleWebSearch: returns error on missing query',
    fn: async () => {
      const result = await handleWebSearch({}, { userId: null });
      if (!result.error) throw new Error('expected error');
      if (!result.error.includes('query')) throw new Error('wrong error message');
    }
  });

  tests.push({
    name: 'handleWebSearch: returns error on missing API key',
    fn: async () => {
      // Ensure env var is not set
      const saved = process.env.LLMIDE_SERPAPI_KEY;
      delete process.env.LLMIDE_SERPAPI_KEY;
      try {
        const result = await handleWebSearch({ query: 'test' }, { userId: null });
        if (!result.error) throw new Error('expected error');
        if (!result.error.includes('not configured')) throw new Error('wrong error message');
      } finally {
        if (saved) process.env.LLMIDE_SERPAPI_KEY = saved;
      }
    }
  });

  // Run all
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

// Run tests if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await runTests();
}
