# Web Search & Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add web search (via SerpAPI) and URL fetch capabilities to the llm-ide Code Assistant agent, enabling it to search the web and read URLs like Claude Code does.

**Architecture:** Two new read-skills (`web-search`, `fetch-url`) following the existing pattern in `llm_agent/global/`. Handlers in `llm_agent/runtime/handlers/` call SerpAPI and fetch URLs respectively. SSRF safety via `assertSafeBaseUrlResolved`. API key stored per-user in vault, env fallback.

**Tech Stack:** Node.js, SerpAPI, jsdom (HTML→markdown extraction), existing skill/handler framework.

---

## Task 1: Add web client utilities

**Files:**
- Create: `extension/agents/web-client.mjs`

- [ ] **Step 1: Write the module skeleton with SerpAPI call**

Create `extension/agents/web-client.mjs`:

```javascript
// Web utilities for agent: SerpAPI search and URL fetch.

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Call SerpAPI to search the web.
 * Returns { results: [{title, link, snippet}, ...], searchParameters: {...} }
 */
export async function searchWeb(query, { apiKey, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) {
    throw new Error('SerpAPI key required. Set in vault or LLMIDE_SERPAPI_KEY env var.');
  }
  if (!query || typeof query !== 'string') {
    throw new Error('Query must be a non-empty string');
  }

  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SerpAPI ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return {
      results: (data.organic_results || []).slice(0, 10).map(r => ({
        title: r.title,
        link: r.link,
        snippet: r.snippet || ''
      })),
      searchParameters: data.search_parameters
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Fetch a URL and extract text content.
 * Returns { text: "extracted markdown", title: "page title" }
 */
export async function fetchUrl(urlString, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL must be a non-empty string');
  }

  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${urlString}`);
    }
    const html = await res.text();
    const title = extractTitle(html);
    const text = extractTextContent(html);
    return { text, title };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Extract <title> from HTML.
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

// Extract readable text from HTML, stripping tags and normalizing whitespace.
function extractTextContent(html) {
  // Remove script, style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode entities
  text = text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // Normalize whitespace
  text = text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  return text.slice(0, 8000); // Cap at 8KB
}
```

- [ ] **Step 2: Write tests for web-client**

Create `extension/tests/web-client.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, fetchUrl } from '../agents/web-client.mjs';

test('searchWeb: throws on missing API key', async () => {
  await assert.rejects(
    () => searchWeb('test'),
    /SerpAPI key required/
  );
});

test('searchWeb: throws on empty query', async () => {
  await assert.rejects(
    () => searchWeb('', { apiKey: 'test' }),
    /non-empty string/
  );
});

test('fetchUrl: throws on invalid URL', async () => {
  await assert.rejects(
    () => fetchUrl('not a url'),
    /Invalid URL/
  );
});

test('fetchUrl: throws on empty URL', async () => {
  await assert.rejects(
    () => fetchUrl(''),
    /non-empty string/
  );
});
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd /Users/dinsmallade/llm-ide/extension
npm test -- tests/web-client.test.mjs
```

Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add extension/agents/web-client.mjs extension/tests/web-client.test.mjs
git commit -m "feat(agent): add web client utilities (SerpAPI, fetch, extract text)"
```

---

## Task 2: Create web-search read-skill

**Files:**
- Create: `llm_agent/global/web-search.md`

- [ ] **Step 1: Write the skill markdown**

Create `llm_agent/global/web-search.md`:

```markdown
---
name: web-search
kind: read
schema:
  query:
    type: string
    required: true
    minLength: 1
    maxLength: 256
    description: Web search query (e.g., "how to implement OAuth in Node.js")
---

# web-search

Search the web and get ranked results with snippets.

## When to use

The user asks a question that requires current information not in the local codebase or LLM IDE app state (e.g., "what's the latest Node.js release", "find examples of X on GitHub"). Do not use for questions about the local code or the app itself — use `search-kb` or `ask-internal` instead.

## Call shape

\`\`\`
<<<TOOL_CALL>>>
{"name": "web-search", "arguments": {"query": "..."}}
<<<END_TOOL_CALL>>>
\`\`\`

## Result shape

\`\`\`json
{
  "results": [
    {
      "title": "Page Title",
      "link": "https://example.com/page",
      "snippet": "A brief snippet from the page..."
    }
  ],
  "count": 5
}
\`\`\`

Each result is ranked by relevance. Use the snippets to decide whether to fetch the full page via `fetch-url`.
```

- [ ] **Step 2: Commit**

```bash
git add llm_agent/global/web-search.md
git commit -m "docs(skill): add web-search read-skill"
```

---

## Task 3: Create fetch-url read-skill

**Files:**
- Create: `llm_agent/global/fetch-url.md`

- [ ] **Step 1: Write the skill markdown**

Create `llm_agent/global/fetch-url.md`:

```markdown
---
name: fetch-url
kind: read
schema:
  url:
    type: string
    required: true
    description: Full URL to fetch (https://...). Only public URLs allowed.
---

# fetch-url

Fetch and read the contents of a URL.

## When to use

You have a specific URL (from the user, from search results, or from a GitHub link) and need to read its full contents. Use `web-search` first to find relevant pages, then `fetch-url` to read the ones that look promising.

## Call shape

\`\`\`
<<<TOOL_CALL>>>
{"name": "fetch-url", "arguments": {"url": "https://github.com/user/repo"}}
<<<END_TOOL_CALL>>>
\`\`\`

## Result shape

\`\`\`json
{
  "title": "Page Title",
  "text": "Extracted text content (up to 8KB)..."
}
\`\`\`

The text is the readable content of the page with HTML stripped and whitespace normalized.

## Security

Private/localhost URLs are rejected. Only public HTTPS URLs are allowed.
```

- [ ] **Step 2: Commit**

```bash
git add llm_agent/global/fetch-url.md
git commit -m "docs(skill): add fetch-url read-skill"
```

---

## Task 4: Create web-search handler

**Files:**
- Create: `llm_agent/runtime/handlers/web-search.mjs`
- Modify: `llm_agent/runtime/handlers/web-search.mjs` (inline tests in same file)

- [ ] **Step 1: Write the handler with inline tests**

Create `llm_agent/runtime/handlers/web-search.mjs`:

```javascript
import { searchWeb } from '../../agents/web-client.mjs';
import { getSecret } from '../../server/vault.mjs';
import { getDb } from '../../kb/db.mjs';

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
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/dinsmallade/llm-ide/extension
node llm_agent/runtime/handlers/web-search.mjs
```

Expected: PASS (2 tests)

- [ ] **Step 3: Commit**

```bash
git add llm_agent/runtime/handlers/web-search.mjs
git commit -m "feat(handler): implement web-search handler via SerpAPI"
```

---

## Task 5: Create fetch-url handler

**Files:**
- Create: `llm_agent/runtime/handlers/fetch-url.mjs`

- [ ] **Step 1: Write the handler with SSRF safety**

Create `llm_agent/runtime/handlers/fetch-url.mjs`:

```javascript
import { fetchUrl } from '../../agents/web-client.mjs';
import { assertSafeBaseUrlResolved } from '../../agents/providers.mjs';

/**
 * Handler for the fetch-url read-skill.
 * Fetches a URL and extracts text content.
 * Uses assertSafeBaseUrlResolved to prevent SSRF attacks.
 */
export async function handleFetchUrl(args, { userId }) {
  if (!args?.url) {
    return { error: 'Missing url argument' };
  }

  // Validate URL and check SSRF (block private IPs, localhost, etc.)
  try {
    await assertSafeBaseUrlResolved(args.url);
  } catch (err) {
    return { error: `URL blocked for security: ${err.message}` };
  }

  try {
    const { text, title } = await fetchUrl(args.url);
    return { title, text };
  } catch (err) {
    return { error: `Failed to fetch URL: ${err.message}` };
  }
}

// ──── Tests

export async function runTests() {
  const tests = [];

  tests.push({
    name: 'handleFetchUrl: returns error on missing url',
    fn: async () => {
      const result = await handleFetchUrl({}, { userId: null });
      if (!result.error) throw new Error('expected error');
      if (!result.error.includes('url')) throw new Error('wrong error message');
    }
  });

  tests.push({
    name: 'handleFetchUrl: blocks localhost (SSRF)',
    fn: async () => {
      const result = await handleFetchUrl({ url: 'http://localhost:3000' }, { userId: null });
      if (!result.error) throw new Error('expected error');
      if (!result.error.includes('blocked')) throw new Error('wrong error message');
    }
  });

  tests.push({
    name: 'handleFetchUrl: blocks 127.0.0.1 (SSRF)',
    fn: async () => {
      const result = await handleFetchUrl({ url: 'http://127.0.0.1:3456' }, { userId: null });
      if (!result.error) throw new Error('expected error');
      if (!result.error.includes('blocked')) throw new Error('wrong error message');
    }
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
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/dinsmallade/llm-ide/extension
node llm_agent/runtime/handlers/fetch-url.mjs
```

Expected: PASS (3 tests)

- [ ] **Step 3: Commit**

```bash
git add llm_agent/runtime/handlers/fetch-url.mjs
git commit -m "feat(handler): implement fetch-url handler with SSRF safety"
```

---

## Task 6: Register handlers in route.mjs

**Files:**
- Modify: `llm_agent/runtime/route.mjs` (import + handlers object)

- [ ] **Step 1: Add imports at the top**

Edit `llm_agent/runtime/route.mjs`, after the existing imports (around line 11-12):

```javascript
// Add these two imports:
import { handleWebSearch } from './handlers/web-search.mjs';
import { handleFetchUrl } from './handlers/fetch-url.mjs';
```

- [ ] **Step 2: Register handlers in the `handlers` object**

In `route.mjs`, find the `const handlers = { ... }` block (around line 115-132) and add:

```javascript
const handlers = {
  'ask-internal': (args, loopCtx) => askInternal(args, { ...loopCtx }),
  'ask-subagent': (args, loopCtx) => askSubagent(args, { ...loopCtx }),
  // ADD THESE TWO:
  'web-search': (args, loopCtx) => handleWebSearch(args, loopCtx),
  'fetch-url': (args, loopCtx) => handleFetchUrl(args, loopCtx),
};
```

- [ ] **Step 3: Commit**

```bash
git add llm_agent/runtime/route.mjs
git commit -m "feat(route): register web-search and fetch-url handlers"
```

---

## Task 7: Add SerpAPI provider to vault UI (Mac app)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Settings/ProvidersSettingsSection.swift` (add web-search provider)

- [ ] **Step 1: Add web-search provider definition**

Edit `ProvidersSettingsSection.swift`, in the `Provider` initializations (around line 27-30), add:

```swift
Provider(id: "web-search", label: "Web Search (SerpAPI)", vaultKey: "serpapi.apiKey",
         modelIds: [], // Not a model provider, no models
         placeholder: "Your SerpAPI key from https://serpapi.com")
```

- [ ] **Step 2: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/Settings/ProvidersSettingsSection.swift
git commit -m "feat(settings): add Web Search provider for SerpAPI key"
```

---

## Task 8: End-to-end test in the agent

**Files:**
- Modify: `extension/tests/agent-loop.test.mjs` (add test cases)

- [ ] **Step 1: Add a test for web-search in the agent loop**

In `extension/tests/agent-loop.test.mjs`, add (or verify if similar tests exist):

```javascript
test('agent loop: can emit web-search and get results', async () => {
  // Mock SerpAPI to return test results
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('serpapi.com')) {
      return {
        ok: true,
        json: async () => ({
          organic_results: [
            { title: 'Result 1', link: 'https://example.com/1', snippet: 'Test snippet 1' },
            { title: 'Result 2', link: 'https://example.com/2', snippet: 'Test snippet 2' }
          ]
        })
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    process.env.LLMIDE_SERPAPI_KEY = 'test-key';
    const result = await runAgentLoop({
      systemPrompt: 'You can use web-search to answer questions.',
      userMessage: 'Search for "Node.js best practices" and tell me the top result.',
      skills: allSkills, // includes web-search
      handlers: { 'web-search': handleWebSearch }
    });
    assert(result.reply.includes('example.com'), 'Reply should mention search result');
  } finally {
    globalThis.fetch = savedFetch;
    delete process.env.LLMIDE_SERPAPI_KEY;
  }
});
```

- [ ] **Step 2: Add a test for fetch-url in the agent loop**

```javascript
test('agent loop: can emit fetch-url and get content', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('example.com')) {
      return {
        ok: true,
        text: async () => '<html><title>Example Page</title><body>Hello World</body></html>'
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await runAgentLoop({
      systemPrompt: 'You can use fetch-url to read web pages.',
      userMessage: 'Read https://example.com and summarize it.',
      skills: allSkills, // includes fetch-url
      handlers: { 'fetch-url': handleFetchUrl }
    });
    assert(result.reply.includes('Hello World'), 'Reply should mention page content');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
```

- [ ] **Step 3: Run full test suite**

```bash
cd /Users/dinsmallade/llm-ide/extension
npm test
```

Expected: All tests PASS, including the new web-search and fetch-url tests

- [ ] **Step 4: Commit**

```bash
git add extension/tests/agent-loop.test.mjs
git commit -m "test(agent): add end-to-end tests for web-search and fetch-url"
```

---

## Task 9: Manual testing in the Mac app

**Files:**
- No code changes; testing only

- [ ] **Step 1: Rebuild the Mac app**

```bash
cd /Users/dinsmallade/llm-ide/mac
./Scripts/build.sh
```

Expected: Build completes successfully (~75 seconds)

- [ ] **Step 2: Open the Mac app and navigate to Settings → Providers**

- [ ] **Step 3: Add a SerpAPI key**

Visit https://serpapi.com, sign up (free tier gives ~100 searches), copy your API key, and paste it into **Settings → Web Search (SerpAPI)**.

- [ ] **Step 4: Open the Code Assistant and test**

Type a message like: "Search for 'Claude API documentation' and tell me what you find."

Expected: The agent should emit a `web-search` fence, get results, and synthesize an answer.

- [ ] **Step 5: Test fetch-url**

Type: "Read https://github.com/anthropics/anthropic-sdk-python and summarize the README."

Expected: The agent emits `fetch-url`, reads the page, and summarizes.

- [ ] **Step 6: Commit any test notes (optional)**

```bash
# No code changes; just record that manual testing passed
git commit --allow-empty -m "test(manual): verified web-search and fetch-url in Mac app"
```

---

## Summary

After all tasks:

- ✅ Two new read-skills (`web-search`, `fetch-url`) in `llm_agent/global/`
- ✅ Two handlers in `llm_agent/runtime/handlers/` with full test coverage
- ✅ Handlers registered in `route.mjs`
- ✅ SSRF safety via `assertSafeBaseUrlResolved`
- ✅ API key management (per-user vault + env fallback)
- ✅ Mac app Settings UI for SerpAPI key
- ✅ End-to-end tests in agent loop
- ✅ Manual testing in the running Mac app

The agent can now search the web and fetch URLs just like Claude Code.
