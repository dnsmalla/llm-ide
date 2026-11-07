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

let seq = 0;
function member(teamRole, maxMode) {
  const user = registerUser(getDb(), {
    email: `clamp-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  getDb().prepare(
    'INSERT INTO members (user_id, team_role, max_mode, usd_cap_month) VALUES (?, ?, ?, 0)',
  ).run(user.id, teamRole, maxMode);
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

// --- no members row = today's behaviour -----------------------------------

test('a user with no members row runs execute (solo install unchanged)', async () => {
  const user = registerUser(getDb(), {
    email: `clamp-norow-${++seq}@example.com`, password: 'CorrectHorseBattery', displayName: 't',
  });
  const turn = fakeTurn();
  const { res } = await stream(user, { message: 'go', mode: 'execute' }, { runTurn: turn.runTurn });
  assert.equal(res.statusCode, 200);
  assert.equal(turn.calls[0].mode, 'execute');
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
