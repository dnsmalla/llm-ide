// Wall-clock deadline test for runAgentLoop.
// Uses a tiny deadlineMs (50ms) and a slow mock runClaude so the
// deadline fires after 1-2 iterations.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../llm_agent/runtime/loop.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runAgentLoop: deadline terminates a runaway loop with notice', async () => {
  // Mock runClaude that always emits an ask-internal-like read fence
  // so the loop keeps wanting another iteration, but each call takes
  // 40ms — combined with the 50ms deadline we should bail after the
  // first or second iteration.
  let calls = 0;
  // Emit a fence to an UNKNOWN tool so the loop sets toolError and
  // continues to the next iteration (forever, until cap or deadline).
  const runClaude = async () => {
    calls += 1;
    await sleep(40);
    return '<<<TOOL_CALL>>>\n{"name":"never-defined","arguments":{}}\n<<<END_TOOL_CALL>>>';
  };

  const skills = new Map();
  const out = await runAgentLoop({
    skills,
    userMessage: 'do something',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: {},
    maxIterations: 99,        // we want the deadline to bound us, not the iteration cap
    deadlineMs: 50,
  });
  assert.match(out.reply, /deadline/);
  assert.equal(out.pendingTool, null);
  // The loop calls runClaude once per iteration. With 40ms calls
  // against a 50ms deadline, we should see 1–2 calls before bailing.
  assert.ok(calls >= 1 && calls <= 3, `expected 1-3 calls, got ${calls}`);
});

test('runAgentLoop: deadline default of 120s does NOT fire for a fast loop', async () => {
  const runClaude = async () => 'plain reply'; // no fence → exits after 1 call
  const skills = new Map();
  const out = await runAgentLoop({
    skills,
    userMessage: 'hi',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: {},
    // no deadlineMs override — uses 120s default
  });
  assert.equal(out.reply, 'plain reply');
  assert.doesNotMatch(out.reply, /deadline/);
});
