// Regression tests for the fence loop's intra-turn memory.
//
// Observed failure (2026-08-18, Plan mode): the iteration prompt carried only
// the model's LAST output and the LAST tool result, so every earlier result
// vanished from the model's view each iteration. A real turn ping-ponged
// list-files ↔ read-file five times (9 of 13 tool calls were verbatim
// repeats, ~5 minutes of wasted model round-trips) because each fetch evicted
// the other's data. The loop must replay the whole turn so far — every output
// and every tool result, oldest first, under a char budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';
import { loadSkills } from '../llm_agent/skills/loader.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'llm_agent', 'global');

function makeHarness(handlers, responses) {
  const prompts = [];
  let callCount = 0;
  const fakeClaude = async (prompt) => {
    prompts.push(prompt);
    return responses[callCount++];
  };
  return { prompts, fakeClaude, calls: () => callCount, handlers };
}

test('turn memory: every earlier tool result stays visible in later iterations', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  const h = makeHarness(
    {
      'list-files': async () => ({ files: ['MARKER_LIST_ALPHA.md', 'b.md'] }),
      'read-file': async () => ({ content: 'MARKER_READ_BRAVO gitignore body' }),
    },
    [
      '<<<TOOL_CALL>>>\n{"name":"list-files","arguments":{}}\n<<<END_TOOL_CALL>>>',
      '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":".gitignore"}}\n<<<END_TOOL_CALL>>>',
      'Both results considered. Done.',
    ],
  );

  const result = await runAgentLoop({
    skills,
    userMessage: 'Plan how to remove unnecessary files.',
    history: [],
    agentContext: { base: '' },
    runClaude: h.fakeClaude,
    kb: null,
    userId: 'test-user',
    handlers: h.handlers,
  });

  assert.equal(h.calls(), 3);
  assert.match(result.reply, /Done/);
  // Iteration 3's prompt must still contain iteration 1's list-files result —
  // this is the assertion that fails on the single-slot prevOutput/toolResult
  // design and drives the ping-pong refetch loop.
  assert.ok(h.prompts[2].includes('MARKER_LIST_ALPHA'),
    'earlier tool result must stay visible in later iterations');
  assert.ok(h.prompts[2].includes('MARKER_READ_BRAVO'),
    'latest tool result must be visible too');
  // And the model's own earlier outputs replay in order (fence calls visible).
  assert.ok(h.prompts[2].indexOf('"list-files"') < h.prompts[2].indexOf('MARKER_READ_BRAVO'),
    'turn log replays chronologically');
});

test('turn memory: an oversized tool result is clipped, not replayed in full forever', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  const huge = `HEAD_MARKER ${'x'.repeat(50_000)} TAIL_MARKER`;
  const h = makeHarness(
    {
      'read-file': async () => ({ content: huge }),
      'list-files': async () => ({ files: ['after.md'] }),
    },
    [
      '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"big.md"}}\n<<<END_TOOL_CALL>>>',
      '<<<TOOL_CALL>>>\n{"name":"list-files","arguments":{}}\n<<<END_TOOL_CALL>>>',
      'Done.',
    ],
  );

  await runAgentLoop({
    skills,
    userMessage: 'Read the big file then list.',
    history: [],
    agentContext: { base: '' },
    runClaude: h.fakeClaude,
    kb: null,
    userId: 'test-user',
    handlers: h.handlers,
  });

  // In iteration 3 the huge result is a REPLAYED entry — it must be clipped
  // to the per-entry cap (head kept, marker note appended), while the fresh
  // result of iteration 2 stays intact.
  const replay = h.prompts[2];
  assert.ok(replay.includes('HEAD_MARKER'), 'clipped result keeps its head');
  assert.ok(!replay.includes('TAIL_MARKER'), 'clipped result drops its tail');
  assert.match(replay, /result clipped/);
  assert.ok(replay.includes('after.md'));
});

test('turn memory: the freshest result is never clipped away by the budget', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  // Two big results that together exceed the whole turn-log budget: the older
  // one gets dropped, the newest must survive.
  const big = (marker) => `${marker} ${'y'.repeat(45_000)}`;
  let readCallIndex = 0;
  const h = makeHarness(
    {
      'read-file': async () => ({ content: big(`RESULT_${readCallIndex++}`) }),
    },
    [
      '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"a.md"}}\n<<<END_TOOL_CALL>>>',
      '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"b.md"}}\n<<<END_TOOL_CALL>>>',
      '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"c.md"}}\n<<<END_TOOL_CALL>>>',
      'Done.',
    ],
  );

  await runAgentLoop({
    skills,
    userMessage: 'Read three files.',
    history: [],
    agentContext: { base: '' },
    runClaude: h.fakeClaude,
    kb: null,
    userId: 'test-user',
    handlers: h.handlers,
  });

  const last = h.prompts[3];
  assert.ok(last.includes('RESULT_2'), 'newest result must survive the budget');
  assert.match(last, /omitted to fit the prompt|result clipped/,
    'the budget must announce what it dropped rather than dropping silently');
});

test('turn memory: a huge user message shrinks the log instead of stacking on top of it', async () => {
  const { skills } = loadSkills(SKILLS_DIR);
  // Nearly the whole prompt-wide budget is consumed by the user message
  // (attachments ride in it), so the turn log's own 80k cap is NOT the
  // binding constraint — real headroom is. Without the clamp this composed
  // prompt could cross runClaude's hard 500k throw mid-turn.
  const hugeMessage = `Plan this. ${'m'.repeat(440_000)}`;
  let readCallIndex = 0;
  const h = makeHarness(
    {
      'read-file': async () => ({ content: `RESULT_${readCallIndex++} ${'z'.repeat(20_000)}` }),
    },
    [
      '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"a.md"}}\n<<<END_TOOL_CALL>>>',
      '<<<TOOL_CALL>>>\n{"name":"read-file","arguments":{"path":"b.md"}}\n<<<END_TOOL_CALL>>>',
      'Done.',
    ],
  );

  await runAgentLoop({
    skills,
    userMessage: hugeMessage,
    history: [],
    agentContext: { base: '' },
    runClaude: h.fakeClaude,
    kb: null,
    userId: 'test-user',
    handlers: h.handlers,
  });

  const last = h.prompts[2];
  // The latest result must survive; older log entries must yield to the
  // message — announced, never silent.
  assert.ok(last.includes('RESULT_1'), 'latest result must survive even with a huge message');
  assert.ok(!last.includes('RESULT_0'), 'older entries must be dropped when headroom is gone');
  assert.match(last, /omitted to fit the prompt/);
});
