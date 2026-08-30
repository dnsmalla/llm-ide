// Tests for the v2 engine's HTTP surface (routes/agent-v2.mjs): the SSE
// turn stream, the approval-decision endpoint, and session delete.
//
// Hermetic: scratch DB (applyMigrations runs on first getDb), req/res
// doubles copied from tests/agent-sdk-spike.test.mjs, and a fake turn
// runner injected through the `deps` seam — no SDK subprocess, no network,
// no server boot. The engine itself is covered by agent-v2-engine.test.mjs;
// these tests pin the ROUTE contract: pre-SSE validation, SSE framing with
// mode_set injected after init, session mapping on success,
// SESSION_UNRESUMABLE surfaced as a terminal error event, decision
// tenancy, transcript cleanup on delete, and the client-close abort path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// runAgentV2Turn now existence-checks workspaceRoot (a stale root must fail
// clearly, not as an SDK spawn misdiagnosis) — materialize a fixture root.
// Kept under the tests dir, NOT /tmp: /tmp is unwritable under sandboxed
// runs, and a module-load mkdir failure would wipe out this whole file.
const WS = path.join(__dirname, '_agent-v2-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { tasks: sessionTasks } = await import('../llm_agent/runtime/handlers/session-tasks.mjs');
const { getDb } = await import('../kb/db.mjs');
const {
  getOrCreateAgentSession,
  markAgentSessionUsed,
  deleteAgentSession,
} = await import('../kb/agent-sessions.mjs');
const { registerDecision, abortDecisionsForSession } = await import('../llm_agent/sdk/decisions.mjs');
const { agentSdkHomeFor } = await import('../llm_agent/sdk/engine.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');

// --- req/res doubles (from agent-sdk-spike.test.mjs; makeReq additionally
// records close handlers so the abort test can drop the "connection"). -----

function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const closeCbs = [];
  const req = {
    method,
    url,
    user: user ?? { id: null },
    headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      else if (event === 'close') closeCbs.push(cb);
      return req;
    },
  };
  req.fireClose = () => closeCbs.forEach((cb) => cb());
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
    sseEvents() {
      return this._body.split('\n\n')
        .filter((b) => b.startsWith('data: '))
        .map((b) => JSON.parse(b.slice(6)));
    },
  };
}

const newUser = (email) =>
  registerUser(getDb(), { email, password: 'CorrectHorseBattery', displayName: 't' });

// --- POST /agent/v2/stream ---------------------------------------------------

test('stream: tool_result emits tasks_progress as the list changes, deduped', async () => {
  const user = newUser('v2route-taskprogress@example.com');
  // Seed the session's task list, then mutate it BETWEEN tool_result events
  // the way a real turn does — the route re-reads the store on each one.
  const sid = 'chat-taskprog';
  const t1 = sessionTasks.createTask(user.id, sid, 'Add the shared scheme');
  const t2 = sessionTasks.createTask(user.id, sid, 'Wire the test target');
  const fakeTurn = async ({ onEvent }) => {
    onEvent({ type: 'init', sessionId: 'sdk-tp', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    onEvent({ type: 'tool_result', toolUseId: 'a', content: 'ok' });   // first look: both pending
    onEvent({ type: 'tool_result', toolUseId: 'b', content: 'ok' });   // unchanged → no second event
    sessionTasks.updateTask(user.id, sid, t1.id, { status: 'completed' });
    onEvent({ type: 'tool_result', toolUseId: 'c', content: 'ok' });   // changed → emits
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-tp', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: {} };
  };
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    // NOT a plan-like mode: restrictsTools zeroes the task list, so a plan
    // turn legitimately reports nothing here.
    body: { message: 'go', mode: 'execute', agentContext: { chatSessionId: sid, workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn });

  const progress = res.sseEvents().filter((e) => e.type === 'tasks_progress');
  assert.equal(progress.length, 2, 'an unchanged list between tool results must not re-emit');
  assert.deepEqual(progress[0].tasks.map((t) => t.status), ['pending', 'pending']);
  assert.deepEqual(progress[1].tasks.map((t) => t.status), ['completed', 'pending']);
  // The mid-turn event carries the list ONLY — continueNeeded on it would
  // read as "start another turn" to a client that auto-chains on it.
  assert.equal(progress[1].continueNeeded, undefined);
  assert.equal(progress[1].tasks[1].title, t2.title);
  // The terminal event is unchanged: still last, still carries continueNeeded.
  const evs = res.sseEvents();
  assert.equal(evs.at(-1).type, 'tasks');
  assert.equal(evs.at(-1).continueNeeded, true);
});

test('stream: happy path emits init → mode_set → … → result, maps session, records usage', async () => {
  const db = getDb();
  const user = newUser('v2route-happy@example.com');
  const fakeTurn = async ({ onEvent }) => {
    onEvent({ type: 'init', sessionId: 'sdk-1', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    onEvent({ type: 'delta', text: 'hi' });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0.01, numTurns: 1, durationMs: 5, sessionId: 'sdk-1', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 10, outputTokens: 2 } };
  };
  const res = makeRes();
  const handled = await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: {
      message: 'hello',
      mode: 'plan',
      model: 'claude-sonnet-5',
      agentContext: { chatSessionId: 'chat-1', workspaceRoot: WS },
    },
    user,
  }), res, { runTurn: fakeTurn });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.equal(res.ended, true);
  const evs = res.sseEvents();
  assert.equal(evs[0].type, 'init');
  assert.equal(evs[1].type, 'mode_set');
  assert.equal(evs[1].mode, 'plan');
  assert.equal(evs.at(-1).type, 'tasks');
  assert.equal(evs.at(-1).continueNeeded, false);
  assert.deepEqual(evs.at(-1).tasks, []);
  assert.equal(evs.at(-2).type, 'result');
  // The session the stream reported (sdk-1) is bound to the chat mapping.
  assert.equal(getOrCreateAgentSession(db, user.id, 'chat-1', 'explorer').sdk_session_id, 'sdk-1');
  // The turn is metered into the usage ledger (per-model caps keep working).
  const rows = db.prepare('SELECT provider, model, endpoint, input_tokens, output_tokens FROM usage_ledger').all();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    endpoint: '/agent/v2/stream',
    input_tokens: 10,
    output_tokens: 2,
  });
});

// A turn whose client sent no `model` must still be metered: the engine's
// init event carries the actually-resolved model, and recordUsage skips rows
// without one — losing them would blind the per-model usage caps.
test('stream: model-less turn meters under the engine-resolved model from init', async () => {
  const db = getDb();
  const user = newUser('v2route-nomodel@example.com');
  let gotModel;
  const fakeTurn = async ({ onEvent, model }) => {
    gotModel = model;
    onEvent({ type: 'init', sessionId: 'sdk-nm', claudeCodeVersion: '2.1.234', model: 'claude-sonnet-5', tools: [], capabilities: [] });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-nm', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 7, outputTokens: 3 } };
  };
  const res = makeRes();
  const handled = await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-nm', workspaceRoot: WS } }, // no `model`
    user,
  }), res, { runTurn: fakeTurn });
  assert.equal(handled, true);
  assert.equal(res.ended, true);
  assert.equal(gotModel, null); // the engine got no requested model…
  // …but the ledger row exists under the model init reported.
  const rows = db.prepare('SELECT model, endpoint, input_tokens, output_tokens FROM usage_ledger WHERE user_id=?').all(user.id);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    model: 'claude-sonnet-5',
    endpoint: '/agent/v2/stream',
    input_tokens: 7,
    output_tokens: 3,
  });
  // The mapping row records the resolved model too.
  const mapping = getOrCreateAgentSession(db, user.id, 'chat-nm', 'explorer');
  assert.equal(mapping.sdk_session_id, 'sdk-nm');
  assert.equal(mapping.model, 'claude-sonnet-5');
});

// The auth ladder's last rung must be reachable through the route (spec §7,
// same ladder as runClaude): a user with no vault key and no
// ANTHROPIC_API_KEY still gets a turn via the operator's ambient claude
// login. The engine keeps the rung opt-in so hermetic tests can pin the
// no-key error; the ROUTE is what turns it on. agent-v2-live.test.mjs
// proves the rung end-to-end against the real SDK (opt-in env).
test('stream: route enables the operator-ambient auth rung for the engine', async () => {
  const user = newUser('v2route-ambient@example.com');
  let sawAmbient;
  const fakeTurn = async ({ allowAmbientAuth }) => {
    sawAmbient = allowAmbientAuth;
    return { result: null, usageTotals: {} };
  };
  const res = makeRes();
  const handled = await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-amb', workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn });
  assert.equal(handled, true);
  assert.equal(sawAmbient, true);
});

test('stream: second turn resumes the recorded sdk session; fresh:true starts over', async () => {
  const user = newUser('v2route-resume@example.com');
  const seen = [];
  const fakeTurn = async ({ onEvent, resumeSdkSessionId }) => {
    seen.push(resumeSdkSessionId);
    onEvent({ type: 'init', sessionId: 'sdk-r1', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-r1', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 1, outputTokens: 1 } };
  };
  const req = (body) => makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-r', workspaceRoot: WS }, ...body },
    user,
  });
  await handleAgentV2Routes(req({}), makeRes(), { runTurn: fakeTurn });
  await handleAgentV2Routes(req({}), makeRes(), { runTurn: fakeTurn });
  await handleAgentV2Routes(req({ fresh: true }), makeRes(), { runTurn: fakeTurn });
  assert.deepEqual(seen, [undefined, 'sdk-r1', undefined]);
});

test('stream: SESSION_UNRESUMABLE surfaces as an error event, not a crash', async () => {
  const db = getDb();
  const user = newUser('v2route-unresumable@example.com');
  markAgentSessionUsed(db, user.id, 'chat-2', { sdkSessionId: 'sdk-old', model: 'claude-sonnet-5', mode: 'execute' });
  let gotResume;
  const fakeTurn = async ({ resumeSdkSessionId }) => {
    gotResume = resumeSdkSessionId;
    throw Object.assign(new Error('no conversation to resume'), { code: 'SESSION_UNRESUMABLE' });
  };
  const res = makeRes();
  const handled = await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-2', workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn });
  assert.equal(handled, true);
  assert.equal(gotResume, 'sdk-old'); // the poisoned mapping was actually resumed
  assert.equal(res.ended, true);      // stream still ends cleanly
  const evs = res.sseEvents();
  assert.equal(evs.at(-1).type, 'error');
  assert.equal(evs.at(-1).code, 'SESSION_UNRESUMABLE');
});

test('stream: client close aborts the turn and unparks decisions for the live sdk session', async () => {
  const db = getDb();
  const user = newUser('v2route-close@example.com');
  const { promise } = registerDecision({ sdkSessionId: 'sdk-ab', userId: user.id, questions: [] });
  const fakeTurn = async ({ onEvent, signal }) => {
    onEvent({ type: 'init', sessionId: 'sdk-ab', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  const req = makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-ab', workspaceRoot: WS } },
    user,
  });
  const res = makeRes();
  const handledP = handleAgentV2Routes(req, res, { runTurn: fakeTurn });
  await new Promise((r) => setImmediate(r)); // let the route reach its runTurn await
  req.fireClose();
  assert.equal(await handledP, true);
  // The parked approval settled as aborted NOW, not at its 300 s timeout.
  assert.deepEqual(await promise, { action: 'aborted' });
  const evs = res.sseEvents();
  assert.equal(evs[0].type, 'init');
  assert.ok(!evs.some((e) => e.type === 'error'), 'a client-side abort is not an error event');
  assert.equal(res.ended, true);
  // An aborted turn never binds the session it reported.
  assert.equal(getOrCreateAgentSession(db, user.id, 'chat-ab', 'explorer').sdk_session_id, null);
});

test('stream: a second turn for the same chat session while one is in flight gets 409, not a race', async () => {
  const db = getDb();
  const user = newUser('v2route-concurrent@example.com');
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  let firstStarted = false;
  const fakeTurn = async ({ onEvent }) => {
    firstStarted = true;
    onEvent({ type: 'init', sessionId: 'sdk-conc', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    await firstGate;
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-conc', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 1, outputTokens: 1 } };
  };
  const req = (body) => makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-conc', workspaceRoot: WS }, ...body },
    user,
  });

  const firstP = handleAgentV2Routes(req({}), makeRes(), { runTurn: fakeTurn });
  while (!firstStarted) await new Promise((r) => setImmediate(r)); // let the first turn actually start

  // A second stream for the SAME (user, chatSessionId) while the first is
  // still parked must be rejected fast, before touching agent_sessions —
  // never queued or raced against the in-flight resume.
  const secondRes = makeRes();
  const secondHandled = await handleAgentV2Routes(req({}), secondRes, {
    runTurn: async () => { throw new Error('must not run while a turn is in flight'); },
  });
  assert.equal(secondHandled, true);
  assert.equal(secondRes.statusCode, 409);
  assert.equal(secondRes.json().error.code, 'TURN_IN_PROGRESS');

  releaseFirst();
  assert.equal(await firstP, true);

  // Lock released after the first turn completes — a third request proceeds normally.
  const thirdRes = makeRes();
  const thirdHandled = await handleAgentV2Routes(req({}), thirdRes, {
    runTurn: async ({ onEvent }) => {
      onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-conc', stopReason: 'end_turn' });
      return { result: { subtype: 'success' }, usageTotals: {} };
    },
  });
  assert.equal(thirdHandled, true);
  assert.equal(thirdRes.statusCode, 200);
  assert.equal(getOrCreateAgentSession(db, user.id, 'chat-conc', 'explorer').sdk_session_id, 'sdk-conc');
});

test('stream: validation — missing message/chatSessionId/workspaceRoot → 400 pre-SSE; no user → 401', async () => {
  const user = newUser('v2route-validation@example.com');
  const run = async (body, u) => {
    const r = makeRes();
    await handleAgentV2Routes(makeReq({
      method: 'POST', url: '/agent/v2/stream', body, user: u,
    }), r, { runTurn: async () => ({ result: null, usageTotals: {} }) });
    return r;
  };

  let res = await run({ message: 'hi', agentContext: { chatSessionId: 'c', workspaceRoot: WS } }, null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');

  res = await run({ agentContext: { chatSessionId: 'c', workspaceRoot: WS } }, user);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');

  res = await run({ message: 'hi', agentContext: { workspaceRoot: WS } }, user);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /chatSessionId/);

  res = await run({ message: 'hi', agentContext: { chatSessionId: 'c' } }, user);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /workspaceRoot/);

  // All rejections answered with plain JSON before any SSE headers were sent.
  assert.equal(res.headers['Content-Type'], 'application/json');
});

// --- mode resolution + slash-command expansion (parity with the legacy loop) --
//
// The legacy /code-assist loop resolves mode BEFORE the turn: "auto"
// classifies the message, an explicit mode must be a known MODES member,
// anything else runs execute (llm_agent/runtime/route.mjs). The v2 route
// originally passed body.mode through verbatim — "auto" (the Mac client's
// default) ran as a mode personaForMode doesn't know, so assist_plan/plan/
// review/document never activated on v2. Same story for leading-slash
// plugin commands: legacy expands them server-side (expandSlashCommand).

test('stream: mode "auto" is classified; the engine and mode_set see the resolved mode', async () => {
  const user = newUser('v2route-auto@example.com');
  const classifyCalls = [];
  let sawMode;
  const fakeTurn = async ({ mode, onEvent }) => {
    sawMode = mode;
    onEvent({ type: 'init', sessionId: 'sdk-auto', tools: [], capabilities: [] });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-auto', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 1, outputTokens: 1 } };
  };
  const classifyMode = async (message, { userId }) => {
    classifyCalls.push({ message, userId });
    return { mode: 'assist_plan' };
  };
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: {
      message: 'plan this with me over several turns',
      mode: 'auto',
      agentContext: { chatSessionId: 'chat-auto', workspaceRoot: WS },
    },
    user,
  }), res, { runTurn: fakeTurn, classifyMode });
  assert.equal(classifyCalls.length, 1);
  assert.equal(classifyCalls[0].userId, user.id);
  assert.equal(classifyCalls[0].message, 'plan this with me over several turns');
  assert.equal(sawMode, 'assist_plan');
  assert.equal(res.sseEvents().find((e) => e.type === 'mode_set').mode, 'assist_plan');
});

test('stream: missing mode runs execute (back-compat) and never calls the classifier', async () => {
  const user = newUser('v2route-nomode@example.com');
  let sawMode;
  const fakeTurn = async ({ mode, onEvent }) => {
    sawMode = mode;
    onEvent({ type: 'init', sessionId: 'sdk-nm2', tools: [], capabilities: [] });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-nm2', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 1, outputTokens: 1 } };
  };
  const classifyMode = async () => { throw new Error('classifier must not run for a mode-less turn'); };
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-nomode', workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn, classifyMode });
  assert.equal(sawMode, 'execute');
  assert.equal(res.sseEvents().find((e) => e.type === 'mode_set').mode, 'execute');
});

test('stream: a mode string outside MODES falls back to execute (no unrestricted pass-through)', async () => {
  const user = newUser('v2route-typo@example.com');
  let sawMode;
  const fakeTurn = async ({ mode, onEvent }) => {
    sawMode = mode;
    onEvent({ type: 'init', sessionId: 'sdk-typo', tools: [], capabilities: [] });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-typo', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 1, outputTokens: 1 } };
  };
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    // "assist-plan" — the hyphen typo mode-classify.mjs's header warns about
    body: { message: 'hi', mode: 'assist-plan', agentContext: { chatSessionId: 'chat-typo', workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn });
  assert.equal(sawMode, 'execute');
});

test('stream: classifier failure falls back to execute; the turn still runs', async () => {
  const user = newUser('v2route-classifyfail@example.com');
  let sawMode;
  const fakeTurn = async ({ mode, onEvent }) => {
    sawMode = mode;
    onEvent({ type: 'init', sessionId: 'sdk-cf', tools: [], capabilities: [] });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-cf', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 1, outputTokens: 1 } };
  };
  const classifyMode = async () => { throw new Error('classifier exploded'); };
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'hi', mode: 'auto', agentContext: { chatSessionId: 'chat-cf', workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn, classifyMode });
  assert.equal(sawMode, 'execute');
  assert.equal(res.sseEvents().at(-1).type, 'tasks');
});

test('stream: a leading-slash message is expanded via the user command set before the turn', async () => {
  const user = newUser('v2route-slash@example.com');
  const expandCalls = [];
  let sawMessage;
  const fakeTurn = async ({ message, onEvent }) => {
    sawMessage = message;
    onEvent({ type: 'init', sessionId: 'sdk-slash', tools: [], capabilities: [] });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-slash', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 1, outputTokens: 1 } };
  };
  const expandSlash = (message, userId) => {
    expandCalls.push({ message, userId });
    return { prompt: 'EXPANDED PROMPT TEXT', trigger: '/deploy' };
  };
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: '/deploy prod', agentContext: { chatSessionId: 'chat-slash', workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn, expandSlash });
  assert.equal(expandCalls.length, 1);
  assert.equal(expandCalls[0].userId, user.id);
  assert.equal(sawMessage, 'EXPANDED PROMPT TEXT');
});

test('stream: slash expansion error answers 400 JSON before the SSE headers', async () => {
  const user = newUser('v2route-slasherr@example.com');
  let turnRan = false;
  const fakeTurn = async () => { turnRan = true; return { result: null, usageTotals: {} }; };
  const expandSlash = () => ({ error: 'Unknown command /nope' });
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: '/nope', agentContext: { chatSessionId: 'chat-slasherr', workspaceRoot: WS } },
    user,
  }), res, { runTurn: fakeTurn, expandSlash });
  assert.equal(turnRan, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['Content-Type'], 'application/json'); // JSON, not SSE framing
  assert.equal(res.sseEvents().length, 0);
  assert.equal(res.json().error.code, 'SLASH_COMMAND_FAILED');
  assert.match(res.json().error.message, /Unknown command/);
});

// --- POST /agent/v2/decision -------------------------------------------------

test('decision: owner answers (200), foreign user 403, unknown/expired 404', async () => {
  const u1 = newUser('v2route-d1@example.com');
  const u2 = newUser('v2route-d2@example.com');
  const { requestId, promise } = registerDecision({ sdkSessionId: 'sdk-dec', userId: u1.id, questions: [] });
  try {
    const post = async (body, user) => {
      const r = makeRes();
      const handled = await handleAgentV2Routes(makeReq({
        method: 'POST', url: '/agent/v2/decision', body, user,
      }), r);
      assert.equal(handled, true);
      return r;
    };

    let res = await post({ requestId, sdkSessionId: 'sdk-dec', answers: { Q: 'A' } }, u2);
    assert.equal(res.statusCode, 403);

    res = await post({ requestId: 'no-such-id', sdkSessionId: 'sdk-dec', answers: {} }, u1);
    assert.equal(res.statusCode, 404);

    res = await post({ requestId, sdkSessionId: 'sdk-dec', answers: { Q: 'A' } }, u1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.deepEqual(await promise, { action: 'answer', answers: { Q: 'A' } });
  } finally {
    abortDecisionsForSession('sdk-dec'); // settle anything still parked (its 300 s timer would outlive the test)
  }
});

test('decision: passes through action for a ToolApproval decision (allow/deny/always-allow)', async () => {
  const user = newUser('v2route-toolapproval@example.com');
  const post = async (body) => {
    const r = makeRes();
    const handled = await handleAgentV2Routes(makeReq({
      method: 'POST', url: '/agent/v2/decision', body, user,
    }), r);
    assert.equal(handled, true);
    return r;
  };

  const d1 = registerDecision({ sdkSessionId: 'sdk-ta', userId: user.id, kind: 'ToolApproval' });
  let res = await post({ requestId: d1.requestId, sdkSessionId: 'sdk-ta', action: 'allow' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await d1.promise, { action: 'allow' });

  const d2 = registerDecision({ sdkSessionId: 'sdk-ta', userId: user.id, kind: 'ToolApproval' });
  res = await post({ requestId: d2.requestId, sdkSessionId: 'sdk-ta', action: 'deny' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await d2.promise, { action: 'deny' });

  const d3 = registerDecision({ sdkSessionId: 'sdk-ta', userId: user.id, kind: 'ToolApproval' });
  res = await post({ requestId: d3.requestId, sdkSessionId: 'sdk-ta', action: 'always-allow' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await d3.promise, { action: 'always-allow' });
});

// --- DELETE /agent/v2/session --------------------------------------------------

test('session delete: drops the mapping, best-effort deletes SDK transcripts', async () => {
  const db = getDb();
  const user = newUser('v2route-del@example.com');
  markAgentSessionUsed(db, user.id, 'chat-del', { sdkSessionId: '11111111-2222-4333-8444-555555555555', model: 'claude-sonnet-5', mode: 'execute' });

  // KEYED turns write under the per-user engine home the engine composes
  // (agentSdkHomeFor — derived from the data dir), so this test scripts
  // transcripts exactly where a live keyed turn would have written them.
  // The ambient location is pinned by the dedicated test below.
  const home = agentSdkHomeFor(user.id);
  assert.ok(home, 'registered user id resolves an engine home');
  const ws = path.join(home, 'projects', '-tmp-w');
  fs.mkdirSync(ws, { recursive: true });
  try {
    fs.writeFileSync(path.join(ws, '11111111-2222-4333-8444-555555555555.jsonl'), '{}\n');
    fs.writeFileSync(path.join(ws, 'unrelated.jsonl'), '{}\n');

    const res = makeRes();
    const handled = await handleAgentV2Routes(makeReq({
      method: 'DELETE',
      url: '/agent/v2/session',
      body: { chatSessionId: 'chat-del' },
      user,
    }), res);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, sdkSessionId: '11111111-2222-4333-8444-555555555555' });
    // Transcript matching the sdk id is gone; other sessions' files stay.
    assert.equal(fs.existsSync(path.join(ws, '11111111-2222-4333-8444-555555555555.jsonl')), false);
    assert.equal(fs.existsSync(path.join(ws, 'unrelated.jsonl')), true);
    assert.equal(deleteAgentSession(db, user.id, 'chat-del'), null); // mapping row gone
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  // A chat with no sdk session bound (or never mapped) deletes cleanly too.
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'DELETE', url: '/agent/v2/session', body: { chatSessionId: 'chat-never' }, user,
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, sdkSessionId: null });

  // Missing chatSessionId → 400; no user → 401.
  let rej = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'DELETE', url: '/agent/v2/session', body: {}, user,
  }), rej);
  assert.equal(rej.statusCode, 400);

  rej = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'DELETE', url: '/agent/v2/session', body: { chatSessionId: 'x' },
  }), rej);
  assert.equal(rej.statusCode, 401);
});

// Ambient turns run without a CLAUDE_CONFIG_DIR override, so their SDK
// transcripts land under the DEFAULT config dir (env CLAUDE_CONFIG_DIR, or
// ~/.claude). Session delete must clean that root too — otherwise every
// ambient chat's transcript survives its deletion as a privacy remnant.
test('session delete: ambient transcripts under the default config dir are cleaned too', async () => {
  const db = getDb();
  const user = newUser('v2route-del-ambient@example.com');
  markAgentSessionUsed(db, user.id, 'chat-del-amb', { sdkSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', model: 'claude-sonnet-5', mode: 'execute' });

  const prevEnv = process.env.CLAUDE_CONFIG_DIR;
  const ambientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-ambient-home-'));
  process.env.CLAUDE_CONFIG_DIR = ambientRoot;
  const ws = path.join(ambientRoot, 'projects', '-tmp-w');
  fs.mkdirSync(ws, { recursive: true });
  try {
    fs.writeFileSync(path.join(ws, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'), '{}\n');
    fs.writeFileSync(path.join(ws, 'unrelated.jsonl'), '{}\n');

    const res = makeRes();
    await handleAgentV2Routes(makeReq({
      method: 'DELETE',
      url: '/agent/v2/session',
      body: { chatSessionId: 'chat-del-amb' },
      user,
    }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, sdkSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    assert.equal(fs.existsSync(path.join(ws, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl')), false,
      'the ambient transcript must be removed from the default config dir');
    assert.equal(fs.existsSync(path.join(ws, 'unrelated.jsonl')), true,
      'other sessions’ transcripts must survive');
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevEnv;
    fs.rmSync(ambientRoot, { recursive: true, force: true });
  }
});

// The ambient root is the operator's REAL config dir, so cleanup there must
// be conservative: a degenerate (short/garbage) sdk session id must delete
// nothing — `includes()` matching with a short needle could otherwise wipe
// unrelated transcript files or whole encoded-workspace directories.
test('session delete: a degenerate sdk session id deletes nothing', async () => {
  const db = getDb();
  const user = newUser('v2route-del-shortid@example.com');
  markAgentSessionUsed(db, user.id, 'chat-del-short', { sdkSessionId: 'ab', model: 'claude-sonnet-5', mode: 'execute' });

  const prevEnv = process.env.CLAUDE_CONFIG_DIR;
  const ambientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-ambient-short-'));
  process.env.CLAUDE_CONFIG_DIR = ambientRoot;
  const ws = path.join(ambientRoot, 'projects', '-tmp-w');
  fs.mkdirSync(ws, { recursive: true });
  try {
    fs.writeFileSync(path.join(ws, 'ab.jsonl'), '{}\n');
    fs.writeFileSync(path.join(ws, 'collateral-abc.jsonl'), '{}\n');

    const res = makeRes();
    await handleAgentV2Routes(makeReq({
      method: 'DELETE', url: '/agent/v2/session', body: { chatSessionId: 'chat-del-short' }, user,
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(fs.existsSync(path.join(ws, 'ab.jsonl')), true,
      'a degenerate id must not trigger any deletion');
    assert.equal(fs.existsSync(path.join(ws, 'collateral-abc.jsonl')), true,
      'nor take out files that merely contain it');
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevEnv;
    fs.rmSync(ambientRoot, { recursive: true, force: true });
  }
});

// A fresh turn (or an unresumable-session recovery) REPLACES the chat's SDK
// session mapping — the old session's transcript then belongs to no mapping
// and session delete can never find it. The replacement itself must clean
// the old session's transcripts, or every fresh retry leaks one on disk.
test('stream: replacing the SDK session cleans the old session\'s transcripts', async () => {
  const db = getDb();
  const user = newUser('v2route-fresh-clean@example.com');
  const oldId = '99999999-8888-4777-a666-555555555555';
  const newId = '12121212-3434-4565-a787-909090909090';
  markAgentSessionUsed(db, user.id, 'chat-fresh-clean', { sdkSessionId: oldId, model: 'claude-sonnet-5', mode: 'execute' });

  const prevEnv = process.env.CLAUDE_CONFIG_DIR;
  const ambientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-fresh-clean-'));
  process.env.CLAUDE_CONFIG_DIR = ambientRoot;
  const ws = path.join(ambientRoot, 'projects', '-tmp-w');
  fs.mkdirSync(ws, { recursive: true });
  try {
    fs.writeFileSync(path.join(ws, `${oldId}.jsonl`), '{}\n');

    const fakeTurn = async ({ onEvent }) => {
      onEvent({ type: 'init', sessionId: newId, tools: [], capabilities: [] });
      onEvent({ type: 'result', subtype: 'success', sessionId: newId });
      return { result: { subtype: 'success' }, usageTotals: {} };
    };
    const res = makeRes();
    await handleAgentV2Routes(makeReq({
      method: 'POST',
      url: '/agent/v2/stream',
      body: { message: 'go', mode: 'execute', fresh: true,
              agentContext: { chatSessionId: 'chat-fresh-clean', workspaceRoot: WS } },
      user,
    }), res, { runTurn: fakeTurn });
    assert.equal(res.ended, true);
    assert.equal(getOrCreateAgentSession(db, user.id, 'chat-fresh-clean', 'explorer').sdk_session_id, newId);
    assert.equal(fs.existsSync(path.join(ws, `${oldId}.jsonl`)), false,
      'the replaced session\'s transcript must be cleaned up');

    // Resume-as-fork protection: on a RESUMED turn (no fresh flag) that
    // reports a different id, the old transcript is the conversation's
    // parent history and must be KEPT — only replacement without a resume
    // may clean it.
    const forkParent = '77777777-6666-4555-a444-333333333333';
    const forkChild = '20202020-3030-4040-a505-606060606060';
    markAgentSessionUsed(db, user.id, 'chat-fork-keep', { sdkSessionId: forkParent, model: 'claude-sonnet-5', mode: 'execute' });
    fs.writeFileSync(path.join(ws, `${forkParent}.jsonl`), '{}\n');
    const forkTurn = async ({ onEvent }) => {
      onEvent({ type: 'init', sessionId: forkChild, tools: [], capabilities: [] });
      onEvent({ type: 'result', subtype: 'success', sessionId: forkChild });
      return { result: { subtype: 'success' }, usageTotals: {} };
    };
    const res2 = makeRes();
    await handleAgentV2Routes(makeReq({
      method: 'POST',
      url: '/agent/v2/stream',
      body: { message: 'go', mode: 'execute',
              agentContext: { chatSessionId: 'chat-fork-keep', workspaceRoot: WS } }, // no fresh → resume attempted
      user,
    }), res2, { runTurn: forkTurn });
    assert.equal(res2.ended, true);
    assert.equal(fs.existsSync(path.join(ws, `${forkParent}.jsonl`)), true,
      'a resumed turn\'s parent transcript must never be deleted');
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevEnv;
    fs.rmSync(ambientRoot, { recursive: true, force: true });
  }
});

// Chat deletion must not leave the chat's DB-backed session-memory facts
// behind: the Mac's delete flow calls this route, and requiring a second
// endpoint call for the memory rows makes cleanup depend on every client
// remembering to make it.
test('session delete: also removes the chat\'s session-memory rows', async () => {
  const db = getDb();
  const { appendSessionMemory, listSessionMemory } = await import('../kb/session-memory.mjs');
  const user = newUser('v2route-del-memrows@example.com');
  markAgentSessionUsed(db, user.id, 'chat-del-mem', { sdkSessionId: 'abcdefab-1111-4222-a333-444444444444', model: 'claude-sonnet-5', mode: 'execute' });
  appendSessionMemory(user.id, 'chat-del-mem', ['[tooling|x] fact one']);
  assert.equal(listSessionMemory(user.id, 'chat-del-mem').length, 1);

  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'DELETE', url: '/agent/v2/session', body: { chatSessionId: 'chat-del-mem' }, user,
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(listSessionMemory(user.id, 'chat-del-mem').length, 0,
    'session-memory rows must be removed with the chat');
});

// --- dispatcher contract --------------------------------------------------------

test('non-/agent/v2 URLs fall through untouched (returns false)', async () => {
  const res = makeRes();
  assert.equal(
    await handleAgentV2Routes(makeReq({ method: 'POST', url: '/kb/agent/ask', body: {}, user: { id: 'u' } }), res),
    false,
  );
  assert.equal(res._body, '');
});
