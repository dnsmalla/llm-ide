// runAgentLoop emits live progress events (thinking → tool → writing) so the
// client can show a status line instead of a frozen spinner. Mirrors the
// web-search loop test, adding an onProgress spy.

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

const handlers = { 'web-search': handleWebSearch, 'fetch-url': handleFetchUrl };

test('agent loop: onProgress emits thinking → tool → writing', async () => {
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
            { type: 'text', text: 'Result 1 and Result 2.' },
            { type: 'web_search_tool_result', content: [
              { type: 'web_search_result', title: 'Result 1', url: 'https://example.com/1' },
            ] },
          ],
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const { skills } = loadSkills(SKILLS_DIR);
    const responses = [
      '<<<TOOL_CALL>>>\n{"name":"web-search","arguments":{"query":"x"}}\n<<<END_TOOL_CALL>>>',
      'Final answer based on the results.',
    ];
    let i = 0;
    const fakeClaude = async () => responses[i++];

    const events = [];
    const result = await runAgentLoop({
      skills,
      userMessage: 'Search and answer.',
      history: [],
      agentContext: { base: '' },
      runClaude: fakeClaude,
      kb: null,
      userId: 'u1',
      handlers,
      onProgress: (ev) => events.push(ev),
    });

    assert.ok(result.reply.includes('Final answer'), 'returns the final reply');
    const phases = events.map((e) => e.phase);
    assert.equal(phases[0], 'thinking', 'first event is thinking');
    assert.ok(events.some((e) => e.phase === 'tool' && e.tool === 'web-search'),
      'emits a tool event for web-search');
    assert.ok(phases.includes('writing'), 'emits writing on the post-tool iteration');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('agent loop: onProgress is optional and a throwing callback never breaks the loop', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  const fakeClaude = async () => 'Just a direct answer, no tools.';
  const result = await runAgentLoop({
    skills,
    userMessage: 'hi',
    history: [],
    agentContext: { base: '' },
    runClaude: fakeClaude,
    kb: null,
    userId: 'u1',
    handlers,
    onProgress: () => { throw new Error('boom'); },
  });
  assert.ok(result.reply.includes('direct answer'), 'loop completes despite a throwing onProgress');
});
