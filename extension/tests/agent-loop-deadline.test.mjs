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

test('runAgentLoop: no deadlineMs means NO wall-clock limit at all', async () => {
  // The default used to be a real deadline (180 s, then 360 s), and a legitimate
  // multi-step turn that outran it lost the whole reply to "reached the 360s
  // deadline — try again". There is no default clock any more: absent
  // deadlineMs, the loop must not create an abort signal and must not be able to
  // produce a deadline reply.
  let sawSignal = 'unset';
  const runClaude = async (_prompt, opts) => {
    sawSignal = opts.signal;
    return 'plain reply';                     // no fence → exits after 1 call
  };
  const out = await runAgentLoop({
    skills: new Map(),
    userMessage: 'hi',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: {},
    // no deadlineMs — unlimited
  });
  assert.equal(out.reply, 'plain reply');
  assert.doesNotMatch(out.reply, /deadline/);
  assert.equal(sawSignal, undefined,
    'with no deadline there must be no timeout signal — an AbortSignal here is a hidden clock');
});

test('runAgentLoop: an explicitly opted-in deadline is still honoured', async () => {
  // Removing the DEFAULT must not remove the capability: a specific call site or
  // test can still ask for a budget.
  // Honour the signal the way the real runClaude does — it funnels an abort
  // through as a rejection, which is what the loop turns into a deadline reply.
  const runClaude = (_prompt, opts) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('too late'), 400);
    opts.signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  const out = await runAgentLoop({
    skills: new Map(),
    userMessage: 'x',
    history: [],
    agentContext: { base: '' },
    runClaude,
    kb: null,
    userId: 'u1',
    handlers: {},
    deadlineMs: 60,
  });
  assert.match(out.reply, /deadline/, 'an explicit finite deadlineMs must still fire');
});

test('deadlineMs of 0 / null / Infinity all mean unlimited', async () => {
  const seen = [];
  const runClaude = async (_p, opts) => { seen.push(opts.signal); return 'ok'; };
  for (const deadlineMs of [0, null, undefined, Infinity]) {
    const out = await runAgentLoop({
      skills: new Map(),
      userMessage: 'x',
      history: [],
      agentContext: { base: '' },
      runClaude,
      kb: null,
      userId: 'u1',
      handlers: {},
      deadlineMs,
    });
    assert.equal(out.reply, 'ok');
  }
  assert.deepEqual(seen, [undefined, undefined, undefined, undefined],
    'none of these may install a timeout signal');
});
