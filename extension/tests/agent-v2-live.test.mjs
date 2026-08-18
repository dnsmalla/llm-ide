// LIVE smoke for the v2 chat engine's full loop (opt-in; the canary the
// design spec §9 calls for). Skipped unless RUN_AGENT_SDK_SPIKE=1 — it
// drives the REAL Claude Agent SDK through handleAgentV2Routes with the
// production deps (no runTurn injection), so it spends a few cents of the
// operator's ambient claude quota and needs no vault/env key.
//
// The loop under proof: POST /agent/v2/stream (SSE) → the model calls
// AskUserQuestion → canUseTool parks it in the decision registry and
// streams `approval_request` → the test answers through the REAL decision
// endpoint (POST /agent/v2/decision, same req/res doubles + same user) →
// the engine allows the tool with the answer → the model continues and
// reports the choice → `result` → the chat→SDK-session mapping is recorded.
//
// Hermetic-by-default: without the env var the single test skips, so the
// regular `npm test` run never spawns an SDK subprocess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-live-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { getOrCreateAgentSession } = await import('../kb/agent-sessions.mjs');
const { abortDecisionsForSession } = await import('../llm_agent/sdk/decisions.mjs');
// No deps argument anywhere in this file: production wiring (the real
// runAgentV2Turn) is the thing under test.
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');

// --- req/res doubles (from agent-v2-routes.test.mjs) ----------------------------
//
// sseEvents is more tolerant than the routes-test double: this test polls
// the stream WHILE it is live, so the accumulated body can end mid-event —
// blocks that don't parse yet are skipped and picked up on a later poll.

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
      const out = [];
      for (const block of this._body.split('\n\n')) {
        if (!block.startsWith('data: ')) continue;
        try { out.push(JSON.parse(block.slice(6))); } catch { /* partial write — next poll sees it */ }
      }
      return out;
    },
  };
}

// Poll `read()` until it returns truthy, stepping every 150 ms up to
// timeoutMs. An `error` SSE event fails fast with its message — waiting out
// the full deadline after the engine already gave up would only waste time.
async function waitFor(read, { timeoutMs, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = read();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Generous on purpose: the first turn pays the SDK subprocess boot plus a
// full model turn before AskUserQuestion can surface. These bound the live
// run, not the hermetic suite (which never loads this test body).
const APPROVAL_TIMEOUT_MS = 120_000;
const FINISH_TIMEOUT_MS = 240_000;

test('live: AskUserQuestion round-trip through the real SDK engine', { skip: !process.env.RUN_AGENT_SDK_SPIKE }, async () => {
  const db = getDb();
  const user = registerUser(db, { email: 'v2live@example.com', password: 'CorrectHorseBattery', displayName: 'live' });
  const chatSessionId = 'live-1';
  const workspaceRoot = path.resolve(__dirname, '..'); // the extension dir — a real readable workspace

  const res = makeRes();
  const startedAt = Date.now();
  // NOT awaited yet: the stream must be live while the decision is posted.
  const routePromise = handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: {
      message: 'Ask me which color I prefer using AskUserQuestion with options red and blue, then tell me which color I picked.',
      mode: 'execute',
      agentContext: { chatSessionId, workspaceRoot },
    },
    user,
  }), res);

  let sdkSessionId;
  try {
    // 1. Wait for the parked approval (fail fast on an engine error event).
    const approval = await waitFor(() => {
      const evs = res.sseEvents();
      const err = evs.find((e) => e.type === 'error');
      if (err) throw new Error(`engine error before approval_request: ${err.code}: ${err.message}`);
      return evs.find((e) => e.type === 'approval_request');
    }, { timeoutMs: APPROVAL_TIMEOUT_MS, label: 'approval_request' });

    // 2. The init event carries the SDK session the decision must target.
    const init = res.sseEvents().find((e) => e.type === 'init');
    assert.ok(init, 'expected an init event before the approval');
    sdkSessionId = init.sessionId;
    assert.ok(sdkSessionId, 'init carries the SDK session id');

    // 3. Answer 'red' through the REAL decision endpoint, keyed by the exact
    //    question text the model asked, label taken verbatim from the options.
    assert.equal(approval.kind, 'AskUserQuestion');
    const [q] = approval.questions;
    assert.ok(q?.question, 'approval_request carries the question text');
    const chosen = q.options.find((o) => /red/i.test(o.label))?.label ?? 'red';
    const decisionRes = makeRes();
    const decisionHandled = await handleAgentV2Routes(makeReq({
      method: 'POST',
      url: '/agent/v2/decision',
      body: { requestId: approval.requestId, sdkSessionId, answers: { [q.question]: chosen } },
      user,
    }), decisionRes);
    assert.equal(decisionHandled, true);
    assert.equal(decisionRes.statusCode, 200);
    assert.deepEqual(decisionRes.json(), { ok: true });

    // 4. The turn finishes with the answer in play. The race timer MUST be
    //    cleared on the happy path — an armed 240 s setTimeout keeps the
    //    test process alive long after the stream ended.
    let finishTimer;
    try {
      assert.equal(await Promise.race([
        routePromise,
        new Promise((_, rej) => {
          finishTimer = setTimeout(() => rej(new Error('stream did not finish in time')), FINISH_TIMEOUT_MS);
        }),
      ]), true);
    } finally {
      clearTimeout(finishTimer);
    }
  } finally {
    // A failed assertion must not leave a parked 300 s decision timer (or a
    // hung SDK stream) holding the test process open.
    if (sdkSessionId) abortDecisionsForSession(sdkSessionId);
  }

  // --- Binding assertions on the captured stream ------------------------------
  const evs = res.sseEvents();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.ended, true);
  assert.equal(evs[0].type, 'init');
  assert.equal(evs[1].type, 'mode_set');
  assert.equal(evs[1].mode, 'execute');

  const resolved = evs.find((e) => e.type === 'approval_resolved');
  assert.ok(resolved, 'expected an approval_resolved event');
  assert.equal(resolved.outcome, 'answer');

  const assistantText = evs.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.match(assistantText, /red/i, 'final assistant text reports the chosen color');

  const result = evs.find((e) => e.type === 'result');
  assert.ok(result, 'expected a result event');
  assert.equal(result.subtype, 'success');

  // The chat→SDK-session mapping recorded the session the stream reported.
  assert.equal(
    getOrCreateAgentSession(db, user.id, chatSessionId, 'explorer').sdk_session_id,
    sdkSessionId,
  );
  // The turn was metered (task 7's model-resolution fix keeps caps working).
  const ledger = db.prepare('SELECT endpoint FROM usage_ledger WHERE user_id = ?').all(user.id);
  assert.ok(ledger.some((r) => r.endpoint === '/agent/v2/stream'), 'usage ledger row for the live turn');

  // Diagnostics for the run report (visible in the runner output).
  console.log(JSON.stringify({
    live: 'agent-v2',
    events: evs.map((e) => e.type),
    question: evs.find((e) => e.type === 'approval_request')?.questions?.[0]?.question,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    durationMs: Date.now() - startedAt,
    sdkDurationMs: result.durationMs,
    model: evs.find((e) => e.type === 'init')?.model ?? null,
  }));
});
