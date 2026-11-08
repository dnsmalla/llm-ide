// The process-wide in-flight turn cap (routes/agent-v2.mjs): with LLMIDE_MAX_TURNS=1 a second turn on
// another chat waits, is refused 429 BUSY, and writes nothing to the usage ledger — the first keeps
// running and completes. Hermetic: the engine is the injected `runTurn` fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
// Read once, at module load: the cap this file pins.
process.env.LLMIDE_MAX_TURNS = '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_agent-v2-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-turn-limit-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { grant } = await import('./helpers/grant.mjs');
const { handleAgentV2Routes, activeTurnCount } = await import('../routes/agent-v2.mjs');

function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method, url, user, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      else if (event === 'close') cb();
      return this;
    },
  };
}
function makeRes() {
  return {
    on() { return this; },
    statusCode: 200,
    headers: {},
    _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
    sseEvents() {
      return this._body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
    },
  };
}

const waitFor = async (fn, ms = 2000) => {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error('timed out waiting for the turn to start');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const newUser = (email) => {
  const u = registerUser(getDb(), { email, password: 'CorrectHorseBattery', displayName: 't' });
  grant(getDb(), u.id, { teamRole: 'owner', maxMode: 'execute', usdCapMonth: 0 });
  return u;
};

test('LLMIDE_MAX_TURNS=1: a second concurrent turn is BUSY and writes no ledger row; the first completes', async () => {
  const db = getDb();
  const user = newUser('v2-turn-limit@example.com');
  const ledgerRows = () => db.prepare('SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id = ?').get(user.id).n;

  let release;
  const gate = new Promise((r) => { release = r; });
  let engineTurns = 0;
  const fakeTurn = async ({ onEvent }) => {
    engineTurns += 1;
    onEvent({ type: 'init', sessionId: 'sdk-busy', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    await gate;
    onEvent({ type: 'delta', text: 'done' });
    onEvent({ type: 'result', subtype: 'success', costUsd: 0.01, numTurns: 1, durationMs: 1, sessionId: 'sdk-busy', stopReason: 'end_turn' });
    return { result: { subtype: 'success' }, usageTotals: { inputTokens: 10, outputTokens: 2 } };
  };
  const send = (chatSessionId) => makeReq({
    method: 'POST',
    url: '/agent/v2/stream',
    body: { message: 'go', mode: 'execute', model: 'claude-sonnet-5', agentContext: { chatSessionId, workspaceRoot: WS } },
    user,
  });

  const firstRes = makeRes();
  const first = handleAgentV2Routes(send('chat-first'), firstRes, { runTurn: fakeTurn });
  await waitFor(() => engineTurns === 1 && activeTurnCount() === 1);
  const before = ledgerRows();

  const secondRes = makeRes();
  await handleAgentV2Routes(send('chat-second'), secondRes, { runTurn: fakeTurn, turnQueueMs: 20 });
  assert.equal(secondRes.statusCode, 429);
  assert.deepEqual(secondRes.json(), {
    error: { code: 'BUSY', message: 'The computer is busy with other turns — try again in a moment.' },
  });
  assert.equal(engineTurns, 1, 'the refused turn never reached the engine');
  assert.equal(ledgerRows(), before, 'the refused turn writes nothing to the ledger');

  release();
  await first;
  assert.equal(firstRes.statusCode, 200);
  const events = firstRes.sseEvents();
  assert.ok(events.some((e) => e.type === 'result'), 'the first turn still completes');
  assert.ok(events.some((e) => e.type === 'delta' && e.text === 'done'));
  assert.ok(ledgerRows() > before, 'the completed turn is metered');
  assert.equal(activeTurnCount(), 0, 'the slot and the chat lock are released');
});
