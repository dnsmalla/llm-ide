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
const tmpDb = path.join(__dirname, '_agent-v2-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const {
  getOrCreateAgentSession,
  markAgentSessionUsed,
  deleteAgentSession,
} = await import('../kb/agent-sessions.mjs');
const { registerDecision, abortDecisionsForSession } = await import('../llm_agent/sdk/decisions.mjs');
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
      agentContext: { chatSessionId: 'chat-1', workspaceRoot: '/tmp/w' },
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
  assert.equal(evs.at(-1).type, 'result');
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
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-nm', workspaceRoot: '/tmp/w' } }, // no `model`
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
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-amb', workspaceRoot: '/tmp/w' } },
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
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-r', workspaceRoot: '/tmp/w' }, ...body },
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
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-2', workspaceRoot: '/tmp/w' } },
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
    body: { message: 'hi', agentContext: { chatSessionId: 'chat-ab', workspaceRoot: '/tmp/w' } },
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

test('stream: validation — missing message/chatSessionId/workspaceRoot → 400 pre-SSE; no user → 401', async () => {
  const user = newUser('v2route-validation@example.com');
  const run = async (body, u) => {
    const r = makeRes();
    await handleAgentV2Routes(makeReq({
      method: 'POST', url: '/agent/v2/stream', body, user: u,
    }), r, { runTurn: async () => ({ result: null, usageTotals: {} }) });
    return r;
  };

  let res = await run({ message: 'hi', agentContext: { chatSessionId: 'c', workspaceRoot: '/tmp/w' } }, null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');

  res = await run({ agentContext: { chatSessionId: 'c', workspaceRoot: '/tmp/w' } }, user);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');

  res = await run({ message: 'hi', agentContext: { workspaceRoot: '/tmp/w' } }, user);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /chatSessionId/);

  res = await run({ message: 'hi', agentContext: { chatSessionId: 'c' } }, user);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /workspaceRoot/);

  // All rejections answered with plain JSON before any SSE headers were sent.
  assert.equal(res.headers['Content-Type'], 'application/json');
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

// --- DELETE /agent/v2/session --------------------------------------------------

test('session delete: drops the mapping, best-effort deletes SDK transcripts', async () => {
  const db = getDb();
  const user = newUser('v2route-del@example.com');
  markAgentSessionUsed(db, user.id, 'chat-del', { sdkSessionId: 'sdk-del-1234', model: 'claude-sonnet-5', mode: 'execute' });

  const cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v2routes-cfg-'));
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgRoot;
  try {
    const ws = path.join(cfgRoot, 'projects', '-tmp-w');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'sdk-del-1234.jsonl'), '{}\n');
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
    assert.deepEqual(res.json(), { ok: true, sdkSessionId: 'sdk-del-1234' });
    // Transcript matching the sdk id is gone; other sessions' files stay.
    assert.equal(fs.existsSync(path.join(ws, 'sdk-del-1234.jsonl')), false);
    assert.equal(fs.existsSync(path.join(ws, 'unrelated.jsonl')), true);
    assert.equal(deleteAgentSession(db, user.id, 'chat-del'), null); // mapping row gone
  } finally {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    fs.rmSync(cfgRoot, { recursive: true, force: true });
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

// --- dispatcher contract --------------------------------------------------------

test('non-/agent/v2 URLs fall through untouched (returns false)', async () => {
  const res = makeRes();
  assert.equal(
    await handleAgentV2Routes(makeReq({ method: 'POST', url: '/kb/agent/ask', body: {}, user: { id: 'u' } }), res),
    false,
  );
  assert.equal(res._body, '');
});
