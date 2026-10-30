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

const { answerDecision } = await import('../llm_agent/sdk/decisions.mjs');
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

test('a prompt-tier command covered by a project rule runs immediately with no approval event', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const { addRule } = await import('../kb/tool-permissions.mjs');
  const entry = get('run-bash');
  const user = registerUser(getDb(), { email: 'code-assist-decision-4@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  addRule(user.id, process.cwd(), 'run-bash', 'echo');
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

// --- Regression: the REAL dispatch path (this is the integration point the
// first round's bug lived in, and the one the direct entry.execute() tests
// above cannot catch) --------------------------------------------------
//
// route.mjs builds `handlers` via buildDispatch(baseCtx) once per request,
// then the removed classic loop's runReadHandler/runNativeAgentLoop called
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
// A buffered (non-SSE) caller — the Mac's Loop stage repair — disconnects on
// Stop/quit too; its parked approvals must unpark the same way.
test('a saved one-word rule never skips the prompt for a sensitive-path command (legacy)', async () => {
  const { get } = await import('../llm_agent/tools/registry.mjs');
  const { addRule } = await import('../kb/tool-permissions.mjs');
  const entry = get('run-bash');
  const user = registerUser(getDb(), { email: 'code-assist-decision-sens@example.com', password: 'CorrectHorseBattery', displayName: 't' });
  addRule(user.id, process.cwd(), 'run-bash', 'cat');
  const events = [];
  const runPromise = entry.execute({ command: 'cat ~/.ssh/id_rsa' }, {
    userId: user.id,
    agentContext: { sessionId: 'legacy-sens', workspaceRoot: process.cwd() },
    loopCtx: { emit: (e) => events.push(e) },
  });
  await new Promise((r) => setImmediate(r));
  const req = events.find((e) => e.phase === 'approval_request');
  assert.ok(req, 'the rule must not auto-allow a sensitive path');
  assert.equal(req.suggestion, undefined, 'no always-allow offer for a sensitive command');
  answerDecision({ requestId: req.requestId, sdkSessionId: 'legacy-sens', userId: user.id, action: 'deny' });
  assert.ok((await runPromise).error);
});
