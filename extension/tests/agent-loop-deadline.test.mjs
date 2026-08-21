// Wall-clock deadline test for runAgentLoop.
// Uses a tiny deadlineMs (50ms) and a slow mock runClaude so the
// deadline fires after 1-2 iterations.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, runNativeAgentLoop } from '../llm_agent/runtime/loop.mjs';

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


// The native (OpenAI-compatible) loop bounds its call the same way, and had
// two latent problems the fence loop's coverage never reached.
//
// 1. It used AbortSignal.timeout(), whose timer is UNREF'd — it only runs
//    while something else keeps the event loop alive. With nothing else
//    pending the loop drains, the timer never fires, and a call awaiting the
//    signal hangs instead of being bounded. Under the server an open socket
//    happened to hold it open, which is luck, not a guarantee.
// 2. Its catch matches `AbortError` / `ABORT_ERR`, but AbortSignal.timeout
//    makes fetch reject with a **TimeoutError** — so a deadline that DID fire
//    was rethrown as a hard failure instead of returning the graceful
//    "_(agent timed out)_" reply. An explicit controller aborts with
//    AbortError, which is what that guard was written for.
//
// This test would hang (not fail) against the old signal, so it is also the
// regression guard for #1.
test('runNativeAgentLoop: a deadline aborts an in-flight complete() and returns the timeout reply', async () => {
  let sawSignal = false;
  const hangingComplete = async ({ signal }) => {
    sawSignal = signal !== undefined;
    // Nothing else is pending — exactly the case an unref'd timer never
    // escapes. Resolve only when the deadline actually aborts us.
    await new Promise((res) => signal.addEventListener('abort', res, { once: true }));
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  const out = await runNativeAgentLoop({
    systemPrompt: 's',
    userMessage: 'm',
    history: [],
    skills: new Map(),
    tools: [],
    complete: hangingComplete,
    userId: 'u',
    handlers: {},
    kb: {},
    deadlineMs: 60,
  });
  assert.ok(sawSignal, 'an opted-in deadline must reach complete() as a signal');
  assert.match(out.reply, /timed out/, 'a fired deadline returns the graceful reply, not a thrown error');
  assert.equal(out.pendingTool, null);
});

test('runNativeAgentLoop: no deadlineMs passes no signal, so a slow call runs to completion', async () => {
  let signalSeen = 'unset';
  const out = await runNativeAgentLoop({
    systemPrompt: 's',
    userMessage: 'm',
    history: [],
    skills: new Map(),
    tools: [],
    complete: async ({ signal }) => {
      signalSeen = signal;
      return { text: 'done', toolCalls: [] };
    },
    userId: 'u',
    handlers: {},
    kb: {},
  });
  assert.equal(signalSeen, undefined, 'no deadline → no signal, so nothing can interrupt the call');
  assert.equal(out.reply, 'done');
});
