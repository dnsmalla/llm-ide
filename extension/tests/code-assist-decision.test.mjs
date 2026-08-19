// Exercises the legacy run-bash approval round-trip end to end: a
// 'prompt'-tier command surfaces an approval_request progress event
// instead of running, and POST /code-assist/decision resolves it.
//
// Hermetic, mirroring tests/agent-v2-engine.test.mjs's Task 7 act-tool
// gating setup: isolated DB so hasAlwaysAllow/setAlwaysAllow (kb/tool-
// approvals.mjs) never touch the real dev database. The brief's Step-1
// sketch used a bare 'u1' + an 'echo hello' auto-safe example; per the
// actual llm_agent/tools/gates.mjs AUTO_SAFE_PATTERNS (confirmed against
// tests/tools-gates.test.mjs and the sibling Task 7 test), `echo` is NOT
// in the auto-safe list — only `git status|diff|log`, `ls`, `cat`,
// `grep`/`rg`, and test runners are. Swapped in `git status` (the same
// command Task 7's analogous test uses) so the auto-tier assertion
// actually holds instead of hanging on an unresolved approval.
//
// FIX-ROUND NOTE: the first four tests below call `entry.execute` directly
// with a hand-built ctx — that's a unit test of run-bash's own gating
// logic, not of the real dispatch wiring, and it is exactly why a real bug
// slipped through the first round: `buildDispatch` (tools/registry.mjs)
// nests the per-call ctx under `loopCtx` rather than spreading it —
// `entry.execute(args, { ...ctx, loopCtx })` — the same convention
// ask-internal/ask-subagent already rely on for `ctx.loopCtx?.depth`. So in
// production `emit` arrives at `ctx.loopCtx.emit`, never bare `ctx.emit`.
// run-bash's execute was fixed to read `ctx.loopCtx?.emit?.(...)`
// accordingly, and the four direct-execute tests below now build their ctx
// with `loopCtx: { emit }` to match that real contract. The LAST test in
// this file is the one that actually proves the wiring end to end: it goes
// through `buildDispatch` + the resulting `handlers['run-bash']` — the
// exact integration point that broke — instead of calling `entry.execute`
// directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_code-assist-decision-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerDecision, answerDecision } = await import('../llm_agent/sdk/decisions.mjs');
const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');

test('run-bash registry entry parks a ToolApproval decision for a prompt-tier command', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const entry = get('run-bash');
  const user = registerUser(getDb(), { email: 'code-assist-decision-1@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const events = [];
  const ctx = {
    userId: user.id,
    agentContext: { sessionId: 'legacy-s1', workspaceRoot: process.cwd() },
    loopCtx: { emit: (e) => events.push(e) },
  };
  const runPromise = entry.execute({ command: 'npm install left-pad' }, ctx);
  // Give the execute() microtask queue a tick to reach the parked await.
  await new Promise((r) => setImmediate(r));
  const req = events.find((e) => e.phase === 'approval_request');
  assert.ok(req, 'expected an approval_request progress event');
  assert.equal(req.toolName, 'run-bash');

  const out = answerDecision({ requestId: req.requestId, sdkSessionId: 'legacy-s1', userId: user.id, action: 'deny' });
  assert.equal(out.ok, true);
  const result = await runPromise;
  assert.ok(result.error, 'a denied command must not run');
});

test('an auto-safe command runs immediately with no approval event', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const entry = get('run-bash');
  const user = registerUser(getDb(), { email: 'code-assist-decision-2@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const events = [];
  const result = await entry.execute({ command: 'git status' }, {
    userId: user.id,
    agentContext: { sessionId: 'legacy-s2', workspaceRoot: process.cwd() },
    loopCtx: { emit: (e) => events.push(e) },
  });
  assert.equal(events.length, 0);
  assert.ok(!result.error, `unexpected error: ${result.error}`);
});

test('a blocked command is denied even with always-allow set (gate runs before hasAlwaysAllow)', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const { setAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const entry = get('run-bash');
  const user = registerUser(getDb(), { email: 'code-assist-decision-3@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAlwaysAllow(user.id, 'run-bash'); // must NOT override a blocked classification
  const events = [];
  const result = await entry.execute({ command: 'sudo rm -rf /' }, {
    userId: user.id,
    agentContext: { sessionId: 'legacy-s3', workspaceRoot: process.cwd() },
    loopCtx: { emit: (e) => events.push(e) },
  });
  assert.equal(events.length, 0, 'a blocked command never parks an approval');
  assert.ok(result.error, 'a blocked command must not run');
});

test('an always-allowed prompt-tier command runs immediately with no approval event', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const { setAlwaysAllow } = await import('../kb/tool-approvals.mjs');
  const entry = get('run-bash');
  const user = registerUser(getDb(), { email: 'code-assist-decision-4@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  setAlwaysAllow(user.id, 'run-bash');
  const events = [];
  // 'echo' is a prompt-tier command (not in AUTO_SAFE_PATTERNS) that is
  // harmless to actually execute — unlike e.g. `npm install`, which would
  // really hit the network/npm cache and make this test slow/flaky.
  const result = await entry.execute({ command: 'echo hello' }, {
    userId: user.id,
    agentContext: { sessionId: 'legacy-s4', workspaceRoot: process.cwd() },
    loopCtx: { emit: (e) => events.push(e) },
  });
  assert.equal(events.length, 0, 'always-allow skips the approval round-trip');
  assert.ok(!result.error, `unexpected error: ${result.error}`);
  assert.equal(result.stdout.trim(), 'hello');
});

test('POST /code-assist/decision resolves a parked decision the same way /agent/v2/decision does', async () => {
  const { handleAIRoutes } = await import('../server/ai-routes.mjs');
  const user = registerUser(getDb(), { email: 'code-assist-decision-5@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const { requestId } = registerDecision({ sdkSessionId: 'legacy-s5', userId: user.id, kind: 'ToolApproval' });

  function fakeReq(body, userId) {
    return {
      method: 'POST',
      url: '/code-assist/decision',
      user: { id: userId },
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
      },
    };
  }
  function fakeRes() {
    const res = {
      statusCode: null,
      body: null,
      writeHead(code) { res.statusCode = code; },
      end(chunk) { res.body = chunk ? JSON.parse(chunk) : null; },
    };
    return res;
  }

  // Wrong user is refused (tenancy), matching /agent/v2/decision's contract.
  const badRes = fakeRes();
  const badHandled = await handleAIRoutes(fakeReq({ requestId, sdkSessionId: 'legacy-s5', action: 'deny' }, 'someone-else'), badRes);
  assert.equal(badHandled, true);
  assert.equal(badRes.statusCode, 403);
  assert.equal(badRes.body.error.code, 'DECISION_FORBIDDEN');

  // Correct user resolves it.
  const res = fakeRes();
  const handled = await handleAIRoutes(fakeReq({ requestId, sdkSessionId: 'legacy-s5', action: 'allow' }, user.id), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });

  // A second answer for the same requestId is now unknown (already settled).
  const res2 = fakeRes();
  const handled2 = await handleAIRoutes(fakeReq({ requestId, sdkSessionId: 'legacy-s5', action: 'allow' }, user.id), res2);
  assert.equal(handled2, true);
  assert.equal(res2.statusCode, 404);
  assert.equal(res2.body.error.code, 'DECISION_UNKNOWN');
});

// --- Regression: the REAL dispatch path (this is the integration point the
// first round's bug lived in, and the one the direct entry.execute() tests
// above cannot catch) --------------------------------------------------
//
// route.mjs builds `handlers` via buildDispatch(baseCtx) once per request,
// then runReadHandler/runNativeAgentLoop (llm_agent/runtime/loop.mjs) call
// `handlers[name](args, loopCtx)` — buildDispatch's dispatch function is
// `(args, loopCtx) => entry.execute(args, { ...baseCtx, loopCtx })`, so
// `emit` (which loop.mjs threads into its own per-call ctx) only ever
// reaches run-bash's execute as `ctx.loopCtx.emit`. This test builds a real
// dispatch table and calls it exactly the way loop.mjs does, so it fails if
// that wiring ever regresses again.
test('buildDispatch wiring: handlers[\'run-bash\'] surfaces approval_request through the real ctx.loopCtx.emit path', async () => {
  const { buildDispatch } = await import('../llm_agent/tools/registry.mjs');
  const user = registerUser(getDb(), { email: 'code-assist-decision-6@example.com', password: 'CorrectHorseBattery', displayName: 't' });

  const handlers = buildDispatch({
    agentContext: { sessionId: 'legacy-s6', workspaceRoot: process.cwd() },
    userId: user.id,
  });

  const events = [];
  const runPromise = handlers['run-bash']({ command: 'npm install left-pad' }, { userId: user.id, emit: (e) => events.push(e) });
  // Give the execute() microtask queue a tick to reach the parked await.
  await new Promise((r) => setImmediate(r));
  const req = events.find((e) => e.phase === 'approval_request');
  assert.ok(req, 'expected an approval_request progress event to surface through the real dispatch path');
  assert.equal(req.toolName, 'run-bash');

  const out = answerDecision({ requestId: req.requestId, sdkSessionId: 'legacy-s6', userId: user.id, action: 'deny' });
  assert.equal(out.ok, true);
  const result = await runPromise;
  assert.ok(result.error, 'a denied command must not run');
});

// --- I5.2: the BUFFERED (non-SSE) /code-assist path has no emit channel ----
//
// server/ai-routes.mjs's buffered branch passes no onProgress/onChunk at all,
// so loop.mjs's per-call ctx carries no `emit`. Parking there produced an
// approval nobody could ever see or answer: a guaranteed 300 s hang followed
// by a denial, on every prompt-tier command. Deny immediately and say why.
test('legacy dispatch with no emit channel denies immediately instead of parking an unanswerable approval', async () => {
  const { buildDispatch } = await import('../llm_agent/tools/registry.mjs');
  const user = registerUser(getDb(), { email: 'code-assist-decision-7@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const handlers = buildDispatch({
    agentContext: { sessionId: 'legacy-s7', workspaceRoot: process.cwd() },
    userId: user.id,
  });

  const started = Date.now();
  // loopCtx present (legacy), but no `emit` — exactly the buffered path.
  const result = await handlers['run-bash']({ command: 'echo should-not-run' }, { userId: user.id });
  assert.ok(Date.now() - started < 5_000, 'must fail fast, not wait on the 300 s registry timeout');
  assert.match(result.error, /interactive approval/i);
  assert.equal(result.stdout, undefined, 'the command must not have run');
});

test('an auto-safe command still runs on the buffered path (the no-emit guard only affects the prompt tier)', async () => {
  const { buildDispatch } = await import('../llm_agent/tools/registry.mjs');
  const user = registerUser(getDb(), { email: 'code-assist-decision-8@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  const handlers = buildDispatch({
    agentContext: { sessionId: 'legacy-s8', workspaceRoot: process.cwd() },
    userId: user.id,
  });
  const result = await handlers['run-bash']({ command: 'git status --porcelain=v1' }, { userId: user.id });
  assert.ok(!result.error, `unexpected error: ${result.error}`);
});

// --- I5.1: a dropped SSE panel must unpark, not leave a 300 s zombie -------
test('the SSE /code-assist close handler aborts the session\'s parked decisions', async () => {
  const { handleAIRoutes } = await import('../server/ai-routes.mjs');
  const user = registerUser(getDb(), { email: 'code-assist-decision-9@example.com', password: 'CorrectHorseBattery', displayName: 't' });

  const closeHandlers = [];
  const req = {
    method: 'POST',
    url: '/code-assist',
    headers: { accept: 'text/event-stream' },
    user: { id: user.id },
    on(event, cb) {
      if (event === 'close') closeHandlers.push(cb);
      if (event === 'data') cb(Buffer.from(JSON.stringify({
        message: 'hi',
        // `provider` without `model` is route.mjs's fail-fast guard: the turn
        // errors out before any model call, so this test exercises the REAL
        // SSE branch (which registers the close handler before running the
        // turn) without spawning a CLI or hitting the network.
        provider: 'deepseek',
        agentContext: { sessionId: 'legacy-s9', workspaceRoot: process.cwd(), recentIssues: [], indexedRepos: [] },
      })));
      if (event === 'end') cb();
    },
  };
  const events = [];
  const res = {
    writableEnded: false,
    writeHead() {},
    write(chunk) { events.push(chunk); },
    end() { res.writableEnded = true; },
  };
  await handleAIRoutes(req, res);
  assert.ok(closeHandlers.length > 0, 'the SSE branch must register a close handler');

  // Park a decision under the same session key run-bash's execute uses
  // (agentContext.sessionId), then drop the client.
  const { promise } = registerDecision({ sdkSessionId: 'legacy-s9', userId: user.id, kind: 'ToolApproval' });
  for (const cb of closeHandlers) cb();
  const outcome = await promise;
  assert.equal(outcome.action, 'aborted', 'a dropped panel must unpark its approvals immediately');
});
