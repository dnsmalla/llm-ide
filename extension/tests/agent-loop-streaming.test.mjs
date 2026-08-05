// runAgentLoop streams live text for a real final answer, but suppresses
// live forwarding for a <<<TOOL_CALL>>> fence directive (never user-facing
// text) — the prefix-sniffing heuristic from Task 5.
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

test('runAgentLoop streams a single-iteration final answer live via onChunk', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  // Simulates a streaming-capable runClaude: delivers the answer in pieces
  // via opts.onChunk, then resolves with the full text (matching
  // streamModelReply's real contract).
  const fullAnswer = 'This is the final answer with more than fifteen characters.';
  const fakeStreamingClaude = async (prompt, opts) => {
    const pieces = [fullAnswer.slice(0, 20), fullAnswer.slice(20, 40), fullAnswer.slice(40)];
    for (const p of pieces) { if (opts.onChunk) opts.onChunk(p); }
    return fullAnswer;
  };

  const chunks = [];
  const result = await runAgentLoop({
    skills,
    userMessage: 'Just answer directly.',
    history: [],
    agentContext: { base: '' },
    runClaude: fakeStreamingClaude,
    kb: null,
    userId: 'u1',
    handlers,
    onChunk: (text) => chunks.push(text),
  });

  assert.equal(result.reply, fullAnswer);
  assert.equal(chunks.join(''), fullAnswer, 'every streamed piece should have been forwarded live, reassembling to the full answer');
});

test('runAgentLoop suppresses live forwarding for a tool-call fence directive', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  const responses = [
    '<<<TOOL_CALL>>>\n{"name":"web-search","arguments":{"query":"x"}}\n<<<END_TOOL_CALL>>>',
    'Final answer after the tool call, well over fifteen characters long.',
  ];
  let i = 0;
  // Streams the FENCE response char-by-char too (opts.onChunk is called
  // regardless of iteration) — proves the sniffing filter, not the caller,
  // is what suppresses it.
  const fakeStreamingClaude = async (prompt, opts) => {
    const resp = responses[i++];
    if (opts.onChunk) {
      for (const ch of resp) opts.onChunk(ch);
    }
    return resp;
  };

  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Result 1' }, { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'R', url: 'https://example.com' }] }] }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

  try {
    const chunks = [];
    const result = await runAgentLoop({
      skills,
      userMessage: 'Search and answer.',
      history: [],
      agentContext: { base: '' },
      runClaude: fakeStreamingClaude,
      kb: null,
      userId: 'u1',
      handlers,
      onChunk: (text) => chunks.push(text),
    });

    assert.ok(result.reply.includes('Final answer after the tool call'));
    // The fence-directive characters must NEVER have been forwarded —
    // only pieces of the second (final-answer) iteration should appear.
    const joined = chunks.join('');
    assert.ok(!joined.includes('TOOL_CALL'), 'fence syntax must never reach the live chunk stream');
    assert.ok(joined.includes('Final answer after the tool call'), 'the real final answer must have streamed live');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test('runAgentLoop flushes a short (under 15 chars) final answer that never resolved live', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  const shortAnswer = 'Yes.'; // shorter than "<<<TOOL_CALL>>>" (15 chars) — never crosses the sniff threshold live
  const fakeStreamingClaude = async (prompt, opts) => {
    if (opts.onChunk) opts.onChunk(shortAnswer);
    return shortAnswer;
  };

  const chunks = [];
  const result = await runAgentLoop({
    skills,
    userMessage: 'One word answer.',
    history: [],
    agentContext: { base: '' },
    runClaude: fakeStreamingClaude,
    kb: null,
    userId: 'u1',
    handlers,
    onChunk: (text) => chunks.push(text),
  });

  assert.equal(result.reply, shortAnswer);
  assert.deepEqual(chunks, [shortAnswer], 'short answer must still be delivered via the flush safety net, exactly once');
});

test('runAgentLoop behaves exactly as before when no onChunk is provided (backward compat)', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  const fakeClaude = async () => 'A plain answer, no streaming requested.';
  const result = await runAgentLoop({
    skills,
    userMessage: 'Plain question.',
    history: [],
    agentContext: { base: '' },
    runClaude: fakeClaude,
    kb: null,
    userId: 'u1',
    handlers,
    // no onChunk
  });
  assert.equal(result.reply, 'A plain answer, no streaming requested.');
});
