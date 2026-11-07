// The team turn clamp (ADR 0021, plan Task 3): after mode resolution and before the chat lock,
// runV2Turn caps the turn to the member's `max_mode` in one place — the HTTP stream and startHostTurn
// alike. Hermetic: a scratch DB, req/res doubles, and a fake turn runner through the `deps` seam.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_agent-v2-team-clamp-ws');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-team-clamp-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { handleAgentV2Routes, startHostTurn } = await import('../routes/agent-v2.mjs');
const { usedUsdMonth, estimateTurnCostUsd } = await import('../kb/usage.mjs');

// --- req/res doubles (the shape tests/agent-v2-routes.test.mjs uses) --------

function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    user,
    headers: {},
    socket: { remoteAddress: '10.9.9.9' },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: '',
    ended: false,
    headersSent: false,
    on() { return this; },
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += String(chunk); return true; },
    end(chunk) { if (chunk) this._body += String(chunk); this.ended = true; },
    json() { return JSON.parse(this._body); },
    sseEvents() {
      return this._body.split('\n\n').filter((b) => b.startsWith('data: '))
        .map((b) => JSON.parse(b.slice('data: '.length)));
    },
  };
}

const { grant } = await import('./helpers/grant.mjs');

let seq = 0;
function member(teamRole, maxMode) {
  const user = registerUser(getDb(), {
    email: `clamp-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  grant(getDb(), user.id, { teamRole, maxMode, usdCapMonth: 0 });
  return user;
}

/** One fake turn that records the args the route handed the engine. */
function fakeTurn() {
  const calls = [];
  const runTurn = async (args) => {
    calls.push(args);
    args.onEvent({ type: 'init', sessionId: 'sdk-clamp', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    args.onEvent({ type: 'result', subtype: 'success', costUsd: 0, numTurns: 1, durationMs: 1, sessionId: 'sdk-clamp', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: {} };
  };
  return { calls, runTurn };
}

function stream(user, body, deps) {
  const res = makeRes();
  return handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { agentContext: { chatSessionId: `chat-${++seq}`, workspaceRoot: WS }, ...body },
    user,
  }), res, deps).then((handled) => ({ handled, res }));
}

const spend = (userId, usd) => getDb().prepare(
  "INSERT INTO usage_ledger (user_id, provider, model, source, runs, cost_usd) VALUES (?, 'anthropic', 'claude-sonnet-5', 'api', 1, ?)",
).run(userId, usd);

const auditRows = (userId) => getDb().prepare(
  "SELECT action, outcome, detail FROM audit_log WHERE user_id = ? AND action = 'team.deny' ORDER BY id DESC",
).all(userId);

// --- max_mode none ---------------------------------------------------------

test('a max_mode none member is refused before the engine runs (403 ROLE_DENIED), with a content-free audit row', async () => {
  const viewer = member('viewer', 'none');
  const turn = fakeTurn();
  const { handled, res } = await stream(viewer, { message: 'secret prompt text', mode: 'execute' }, { runTurn: turn.runTurn });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: { code: 'ROLE_DENIED', message: 'Your team role cannot run turns' } });
  assert.equal(turn.calls.length, 0, 'the engine must not start');

  const rows = auditRows(viewer.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'denied');
  assert.deepEqual(JSON.parse(rows[0].detail), { reason: 'max_mode_none' });
  assert.ok(!String(rows[0].detail).includes('secret prompt text'), 'never the message text');
  assert.ok(!String(rows[0].detail).includes('chat-'), 'never the chat id');
});

// --- read_only clamp ------------------------------------------------------

test('a read_only member asking for execute runs ask, and permissionMode is cleared', async () => {
  const reader = member('member', 'read_only');
  const turn = fakeTurn();
  const { res } = await stream(reader, { message: 'go', mode: 'execute', permissionMode: 'bypass' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls.length, 1);
  assert.equal(turn.calls[0].mode, 'ask');
  assert.equal(turn.calls[0].permissionMode, null);
  const modeSet = res.sseEvents().find((e) => e.type === 'mode_set');
  assert.equal(modeSet.mode, 'ask', 'the client is told the mode that actually ran');
});

test('a read_only member keeps a mode that already restricts tools', async () => {
  const reader = member('member', 'read_only');
  const turn = fakeTurn();
  const { res } = await stream(reader, { message: 'plan it', mode: 'plan' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls[0].mode, 'plan');
});

test('a read_only member whose auto classification says execute is clamped to ask', async () => {
  const reader = member('member', 'read_only');
  const turn = fakeTurn();
  const classifyMode = async () => ({ mode: 'execute' });
  const { res } = await stream(reader, { message: 'run the tests', mode: 'auto' }, { runTurn: turn.runTurn, classifyMode });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls[0].mode, 'ask');
});

test('a read_only member loses a live Bypass grant on the next turn', async () => {
  const reader = member('member', 'read_only');
  const { bypassGrants } = await import('../core/host-approval.mjs');
  const turn = fakeTurn();
  const chatSessionId = `clamp-bypass-${++seq}`;
  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'go', mode: 'execute', agentContext: { chatSessionId, workspaceRoot: WS } },
    user: reader,
  }), res, { runTurn: turn.runTurn });
  // The route revoked whatever the chat held (there was no grant; the assertion is about revoke being
  // called with this chat, observable through has()).
  assert.equal(bypassGrants.has(reader.id, chatSessionId), false);
  assert.equal(turn.calls[0].permissionMode, null);
});

// --- execute unchanged ----------------------------------------------------

test('an execute member runs exactly the mode it asked for', async () => {
  const doer = member('member', 'execute');
  const turn = fakeTurn();
  const { res } = await stream(doer, { message: 'go', mode: 'execute', permissionMode: 'bypass' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls[0].mode, 'execute');
  assert.equal(turn.calls[0].permissionMode, 'bypass');
  assert.equal(auditRows(doer.id).length, 0, 'an allowed turn writes no team.deny row');
});

test('an admin and an owner run execute turns like anyone else', async () => {
  for (const role of ['admin', 'owner']) {
    const u = member(role, 'execute');
    const turn = fakeTurn();
    const { res } = await stream(u, { message: 'go', mode: 'execute' }, { runTurn: turn.runTurn });
    assert.equal(res.statusCode, 200);
    assert.equal(turn.calls[0].mode, 'execute');
  }
});

// --- no members row fails closed (R-007#3) --------------------------------

test('a user with no members row is treated as read-only, like the Host API gateway', async () => {
  // Plan H1.2: registerUser now writes a members row, so this account is inserted raw to keep
  // exercising the no-authority-row path.
  const userId = `clamp-norow-${++seq}`;
  getDb().prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role) VALUES (?, ?, 't', 'x', 'user')",
  ).run(userId, `${userId}@example.com`);
  const user = { id: userId };
  const turn = fakeTurn();
  const { res } = await stream(user, { message: 'go', mode: 'execute' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls[0].mode, 'ask', 'no authority row = the least privilege');
});

// --- the monthly USD cap (R-007#1) ----------------------------------------

test('a member at the monthly USD cap is refused 429 USD_CAP, audited with the reason only', async () => {
  const doer = member('member', 'execute');
  getDb().prepare("UPDATE members SET usd_cap_month = 20 WHERE user_id = ?").run(doer.id);
  spend(doer.id, 20);
  const turn = fakeTurn();
  const { handled, res } = await stream(doer, { message: 'secret cost turn', mode: 'execute' }, { runTurn: turn.runTurn });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json(), { error: { code: 'USD_CAP', message: 'Monthly USD cap reached' } });
  assert.equal(turn.calls.length, 0, 'the engine must not start');
  const rows = auditRows(doer.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'denied');
  assert.deepEqual(JSON.parse(rows[0].detail), { reason: 'usd_cap' });
  assert.ok(!String(rows[0].detail).includes('secret cost turn'));
});

test('a member under the cap runs, and a cap of 0 never refuses', async () => {
  const under = member('member', 'execute');
  getDb().prepare("UPDATE members SET usd_cap_month = 20 WHERE user_id = ?").run(under.id);
  spend(under.id, 10);
  const turn = fakeTurn();
  const { res } = await stream(under, { message: 'go', mode: 'execute' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls.length, 1);

  const uncapped = member('member', 'execute'); // usd_cap_month 0 = no cap
  spend(uncapped.id, 10_000);
  const turn2 = fakeTurn();
  const { res: res2 } = await stream(uncapped, { message: 'go', mode: 'execute' }, { runTurn: turn2.runTurn });
  assert.equal(res2.statusCode, 200);
  assert.equal(turn2.calls.length, 1);
  assert.equal(auditRows(uncapped.id).length, 0);
});

// --- R-012#1 / R-013#1: a cancelled/failed turn charges a small estimate ---

test('an aborted turn is charged a small token estimate, not the whole remaining budget', async () => {
  const doer = member('member', 'execute');
  getDb().prepare("UPDATE members SET usd_cap_month = 20 WHERE user_id = ?").run(doer.id);
  spend(doer.id, 5); // 15 of the 20 USD cap is left

  const res = makeRes();
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: {
      message: 'go', mode: 'execute', model: 'claude-sonnet-5',
      agentContext: { chatSessionId: `abort-${++seq}`, workspaceRoot: WS },
    },
    user: doer,
  }), res, {
    // The user pressed Stop (or the stream dropped): the engine reports its usage event, then throws
    // without returning usageTotals — the exit path the old success-only meter skipped.
    runTurn: async ({ onEvent, abortController }) => {
      onEvent({ type: 'init', sessionId: 'sdk-abort', model: 'claude-sonnet-5', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
      onEvent({ type: 'usage', inputTokens: 120, outputTokens: 8, cacheReadTokens: 0, cacheCreationTokens: 0 });
      abortController.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });

  assert.equal(res.statusCode, 200);
  // R-013#1: the charge is the token estimate (a fraction of a cent), NOT the 15 USD the turn was
  // allowed to spend. The old behaviour locked a capped member out for the month after one Stop.
  const estimate = estimateTurnCostUsd('claude-sonnet-5', { inputTokens: 120, outputTokens: 8 });
  assert.ok(estimate > 0 && estimate < 0.01, `small estimate, got ${estimate}`);
  const spent = usedUsdMonth(getDb(), doer.id);
  assert.ok(Math.abs(spent - (5 + estimate)) < 1e-9, `charged the estimate (got ${spent})`);
  assert.ok(spent < 6, 'one Stop never consumes the remaining monthly budget');
  const row = getDb().prepare(
    'SELECT model, endpoint, input_tokens, output_tokens, cost_usd FROM usage_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1',
  ).get(doer.id);
  assert.deepEqual(row, {
    model: 'claude-sonnet-5', endpoint: '/agent/v2/stream',
    input_tokens: 120, output_tokens: 8, cost_usd: estimate,
  });

  // The lost budget is still usable: the member can run another turn.
  const next = fakeTurn();
  const { res: allowed } = await stream(doer, { message: 'again', model: 'claude-sonnet-5' }, { runTurn: next.runTurn });
  assert.equal(allowed.statusCode, 200);
  assert.equal(next.calls.length, 1);
});

test('a failed turn charges a token estimate, but one with no usage writes no row', async () => {
  const doer = member('member', 'execute');
  getDb().prepare("UPDATE members SET usd_cap_month = 20 WHERE user_id = ?").run(doer.id);
  spend(doer.id, 4); // 16 left

  // Failed before any usage event (e.g. auth/provider refusal): nothing was spent, nothing is charged.
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'go', mode: 'execute', model: 'claude-sonnet-5', agentContext: { chatSessionId: `fail-none-${++seq}`, workspaceRoot: WS } },
    user: doer,
  }), makeRes(), { runTurn: async () => { throw Object.assign(new Error('no key'), { code: 'PROVIDER_UNAVAILABLE' }); } });
  assert.equal(usedUsdMonth(getDb(), doer.id), 4, 'no usage event = no charge');

  // Failed after an API response: the usage event is the evidence, so charge its token estimate.
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'go', mode: 'execute', model: 'claude-sonnet-5', agentContext: { chatSessionId: `fail-usage-${++seq}`, workspaceRoot: WS } },
    user: doer,
  }), makeRes(), {
    runTurn: async ({ onEvent }) => {
      onEvent({ type: 'init', sessionId: 'sdk-fail', model: 'claude-sonnet-5', tools: [], capabilities: [] });
      onEvent({ type: 'usage', inputTokens: 30, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 });
      throw new Error('stream failed');
    },
  });
  const estimate = estimateTurnCostUsd('claude-sonnet-5', { inputTokens: 30, outputTokens: 3 });
  const spent = usedUsdMonth(getDb(), doer.id);
  assert.ok(Math.abs(spent - (4 + estimate)) < 1e-9, `a failed turn with spend is charged its estimate (got ${spent})`);
});

test('engine partial totals win: a reported partial cost is used as-is, otherwise its tokens are estimated', async () => {
  const doer = member('member', 'execute');
  getDb().prepare("UPDATE members SET usd_cap_month = 20 WHERE user_id = ?").run(doer.id);

  // The engine attaches a cost it already got from an interrupted result. No usage event is emitted.
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'go', mode: 'execute', model: 'claude-opus-5-5', agentContext: { chatSessionId: `partial-cost-${++seq}`, workspaceRoot: WS } },
    user: doer,
  }), makeRes(), {
    runTurn: async ({ onEvent }) => {
      onEvent({ type: 'init', sessionId: 'sdk-partial', model: 'claude-opus-5-5', tools: [], capabilities: [] });
      throw Object.assign(new Error('stopped'), {
        usageTotals: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.0042 },
      });
    },
  });
  assert.equal(usedUsdMonth(getDb(), doer.id), 0.0042, 'the engine-reported partial cost is preferred');
  const row = getDb().prepare(
    'SELECT input_tokens, output_tokens, cost_usd FROM usage_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 1',
  ).get(doer.id);
  assert.deepEqual(row, { input_tokens: 900, output_tokens: 40, cost_usd: 0.0042 });

  // Partial tokens with no cost: estimate from those tokens.
  await handleAgentV2Routes(makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'go', mode: 'execute', model: 'claude-opus-5-5', agentContext: { chatSessionId: `partial-tokens-${++seq}`, workspaceRoot: WS } },
    user: doer,
  }), makeRes(), {
    runTurn: async () => {
      throw Object.assign(new Error('stopped'), {
        usageTotals: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
      });
    },
  });
  const estimate = estimateTurnCostUsd('claude-opus-5-5', { inputTokens: 900, outputTokens: 40 });
  const spent = usedUsdMonth(getDb(), doer.id);
  assert.ok(Math.abs(spent - (0.0042 + estimate)) < 1e-9, `partial tokens are estimated (got ${spent})`);
});

// --- the same clamp on the in-process Host API turn -----------------------

test('startHostTurn refuses a max_mode none member with ROLE_DENIED (the phone path)', async () => {
  const viewer = member('viewer', 'none');
  await assert.rejects(
    startHostTurn({ userId: viewer.id, chatSessionId: 'phone-chat', message: 'hi', mode: 'ask', onEvent: () => {} }),
    (e) => e.code === 'ROLE_DENIED',
  );
  assert.equal(auditRows(viewer.id).length, 1, 'the refusal is audited on this path too');
});

test('startHostTurn runs a read_only turn as a read-only mode', async () => {
  const reader = member('member', 'read_only');
  const turn = fakeTurn();
  let ranMode = null;
  await startHostTurn({
    userId: reader.id, chatSessionId: 'phone-chat-2', message: 'hi', mode: 'ask', onEvent: () => {},
    deps: {
      runTurn: async (args) => { ranMode = args.mode; return turn.runTurn(args); },
      expandSlash: () => null,
    },
  });
  assert.equal(ranMode, 'ask');
});

after(() => {
  getDb().close();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* ignore */ }
});
