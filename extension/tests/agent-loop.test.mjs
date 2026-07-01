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
  // Mock the Anthropic Messages API (native web_search backend).
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      return {
        ok: true,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'Best practices: Result 1 and Result 2 cover error handling and async patterns.' },
            { type: 'web_search_tool_result', content: [
              { type: 'web_search_result', title: 'Result 1', url: 'https://example.com/1' },
              { type: 'web_search_result', title: 'Result 2', url: 'https://example.com/2' },
            ] },
          ],
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
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
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('agent loop: can emit fetch-url and get content', async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      return {
        ok: true,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [
            { type: 'text', text: 'The page titled "Example Page" says Hello World.' },
            { type: 'web_fetch_tool_result', content: [
              { type: 'web_fetch_result', title: 'Example Page', url: 'https://example.com' },
            ] },
          ],
        }),
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
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});
