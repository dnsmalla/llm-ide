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

test('runAgentLoop: aborts an in-flight runClaude when the deadline passes mid-call', async () => {
  // The between-iteration check can't catch a SINGLE slow call overrunning
  // the deadline. The loop must pass an AbortSignal derived from the
  // remaining budget so an in-flight call is cancelled at the deadline.
  let sawSignal = false;
  let wasAborted = false;
  const runClaude = async (_prompt, { signal } = {}) => {
    if (signal) sawSignal = true;
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve('plain reply (call finished)'), 1000);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        wasAborted = true;
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      }, { once: true });
    });
  };

  const start = Date.now();
  const out = await runAgentLoop({
    skills: new Map(),
    userMessage: 'x',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: {},
    maxIterations: 99,
    deadlineMs: 80,
  });
  const elapsed = Date.now() - start;

  assert.ok(sawSignal, 'loop should pass an AbortSignal to runClaude');
  assert.ok(wasAborted, 'the in-flight call should be aborted at the deadline');
  assert.match(out.reply, /deadline/);
  assert.ok(elapsed < 800, `should bail near the 80ms deadline, not wait ~1000ms (took ${elapsed}ms)`);
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
