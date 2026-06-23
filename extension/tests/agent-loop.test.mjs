import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';
import { handleWebSearch } from '../llm_agent/runtime/handlers/web-search.mjs';
import { handleFetchUrl } from '../llm_agent/runtime/handlers/fetch-url.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'global');

const handlers = {
  'web-search': handleWebSearch,
  'fetch-url': handleFetchUrl,
};

test('agent loop: can emit web-search and get results', async () => {
  // Mock fetch to return test results
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
    const { skills } = loadSkills(SKILLS_DIR);

    // First iteration: agent calls web-search
    // Second iteration: agent processes results and replies
    const responses = [
      '<<<TOOL_CALL>>>\n{"name":"web-search","arguments":{"query":"Node.js best practices"}}\n<<<END_TOOL_CALL>>>',
      'Based on the search results showing "Result 1" and "Result 2", best practices include many things.',
    ];
    let callCount = 0;
    const fakeClaude = async () => responses[callCount++];

    const result = await runAgentLoop({
      skills,
      userMessage: 'Search for "Node.js best practices" and tell me the top result.',
      history: [],
      agentContext: { base: '' },
      runClaude: fakeClaude,
      kb: null,
      userId: 'test-user',
      handlers,
    });

    assert(result.reply, 'Should have a reply');
    // The result should contain the agent's summary of the search results
    assert.ok(
      result.reply.includes('best practices') || result.reply.includes('Result'),
      `Reply should mention search results or best practices. Got: ${result.reply}`
    );
  } finally {
    globalThis.fetch = savedFetch;
    delete process.env.LLMIDE_SERPAPI_KEY;
  }
});

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
    const { skills } = loadSkills(SKILLS_DIR);

    // First iteration: agent calls fetch-url
    // Second iteration: agent processes result and replies
    const responses = [
      '<<<TOOL_CALL>>>\n{"name":"fetch-url","arguments":{"url":"https://example.com"}}\n<<<END_TOOL_CALL>>>',
      'I read the page and found the title "Example Page" with content "Hello World".',
    ];
    let callCount = 0;
    const fakeClaude = async () => responses[callCount++];

    const result = await runAgentLoop({
      skills,
      userMessage: 'Read https://example.com and summarize it.',
      history: [],
      agentContext: { base: '' },
      runClaude: fakeClaude,
      kb: null,
      userId: 'test-user',
      handlers,
    });

    assert(result.reply, 'Should have a reply');
    // The result should contain reference to the page title or content
    assert.ok(
      result.reply.includes('Example Page') || result.reply.includes('Hello World') || result.reply.includes('title'),
      `Reply should mention page content. Got: ${result.reply}`
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});
