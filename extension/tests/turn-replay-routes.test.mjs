// GET /agent/v2/turns + GET /agent/v2/turns/stream (routes/turn-replay.mjs, routes/agent-v2.mjs):
// listing running turns, re-attaching with replay, tenancy, bounds, and the opt-in `detach` stream flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_turn-replay-ws-fixture');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_turn-replay-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb } = await import('../kb/db.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const replay = await import('../routes/turn-replay.mjs');

function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: user ?? { id: null }, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      else if (event === 'close') cb();
      return req;
    },
  };
  return req;
}
function makeRes() {
  const closeCbs = [];
  return {
    on(event, cb) { if (event === 'close') closeCbs.push(cb); return this; },
    fireClose() { closeCbs.forEach((cb) => cb()); },
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
    frames() {
      return this._body.split('\n\n').filter(Boolean).map((b) => {
        const id = /^id: (\d+)$/m.exec(b);
        const data = /^data: (.*)$/m.exec(b);
        return { id: id ? Number(id[1]) : null, ev: JSON.parse(data[1]) };
      });
    },
  };
}
const newUser = (email) => registerUser(getDb(), { email, password: 'CorrectHorseBattery', displayName: 't' });
const tick = () => new Promise((r) => setImmediate(r));

function parkedTurn(state) {
  return async ({ onEvent, signal }) => {
    state.started = true;
    onEvent({ type: 'init', sessionId: 'sdk-x', claudeCodeVersion: '2.1.234', tools: [], capabilities: [] });
    onEvent({ type: 'delta', text: 'hello' });
    await new Promise((resolve) => {
      state.release = resolve;
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => { state.aborted = true; resolve(); }, { once: true });
    });
    onEvent({ type: 'delta', text: ' world' });
    return { result: null, usageTotals: {} };
  };
}
const streamReq = (user, sid, extra = {}) => makeReq({
  method: 'POST', url: '/agent/v2/stream', user,
  body: { message: 'hi', mode: 'ask', agentContext: { chatSessionId: sid, workspaceRoot: WS }, ...extra },
});

test('detach turn survives its stream dropping; list and attach replay it; tenancy holds', async () => {
  replay.__resetTurnReplayForTest();
  const user = newUser('replay-a@example.com');
  const other = newUser('replay-b@example.com');
  const st = {};
  const primary = makeRes();
  const p = handleAgentV2Routes(streamReq(user, 'chat-r1', { detach: true }), primary, { runTurn: parkedTurn(st) });
  while (!st.started) await tick();

  primary.fireClose();                 // the webview reloaded
  await tick();
  assert.equal(st.aborted, undefined, 'a detached turn is not aborted by its stream dropping');

  const list = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: '/agent/v2/turns', user }), list);
  assert.equal(list.statusCode, 200);
  const turns = list.json().turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, 'chat-r1');
  assert.equal(turns[0].mode, 'ask');
  assert.ok(!Number.isNaN(Date.parse(turns[0].startedAt)));

  const otherList = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: '/agent/v2/turns', user: other }), otherList);
  assert.deepEqual(otherList.json().turns, []);
  const foreign = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: '/agent/v2/turns/stream?sessionId=chat-r1', user: other }), foreign);
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().error.code, 'NO_TURN');

  const att = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: '/agent/v2/turns/stream?sessionId=chat-r1&after=0', user }), att);
  assert.equal(att.statusCode, 200);
  assert.equal(att.headers['Content-Type'], 'text/event-stream');
  const first = att.frames();
  assert.ok(first.length >= 3, 'init, mode_set and the first delta replay');
  assert.deepEqual(first.map((f) => f.id), first.map((_, i) => i + 1));
  assert.equal(first.at(-1).ev.text, 'hello');

  // after=N skips what the client already has
  const att2 = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: `/agent/v2/turns/stream?sessionId=chat-r1&after=${first.length}`, user }), att2);
  assert.equal(att2.frames().length, 0);

  st.release();                        // the turn finishes: live event, then the attached stream ends
  await p;
  assert.equal(att.ended, true);
  assert.ok(att.frames().some((f) => f.ev.text === ' world'));
  assert.ok(att2.frames().some((f) => f.ev.text === ' world'));

  // ended: not listed any more, still attachable inside the TTL (replay then close)
  const list2 = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: '/agent/v2/turns', user }), list2);
  assert.deepEqual(list2.json().turns, []);
  const late = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: '/agent/v2/turns/stream?sessionId=chat-r1', user }), late);
  assert.equal(late.ended, true);
  assert.ok(late.frames().some((f) => f.ev.text === ' world'));
});

test('without detach a dropped stream still stops the turn (unchanged behaviour)', async () => {
  replay.__resetTurnReplayForTest();
  const user = newUser('replay-c@example.com');
  const st = {};
  const primary = makeRes();
  const p = handleAgentV2Routes(streamReq(user, 'chat-r2'), primary, { runTurn: parkedTurn(st) });
  while (!st.started) await tick();
  primary.fireClose();
  await p;
  assert.equal(st.aborted, true);
});

test('attach validates its query', async () => {
  const user = newUser('replay-d@example.com');
  for (const q of ['', '?sessionId=', '?sessionId=a&after=-1', '?sessionId=a&after=x', '?sessionId=a&after=1.5', `?sessionId=${'x'.repeat(201)}`]) {
    const r = makeRes();
    await handleAgentV2Routes(makeReq({ method: 'GET', url: `/agent/v2/turns/stream${q}`, user }), r);
    assert.equal(r.statusCode, 400, q);
    assert.equal(r.json().error.code, 'VALIDATION_FAILED');
  }
  const none = makeRes();
  await handleAgentV2Routes(makeReq({ method: 'GET', url: '/agent/v2/turns/stream?sessionId=nope', user }), none);
  assert.equal(none.statusCode, 404);
});

test('the ring is bounded by events and bytes, keeps sequence numbers, and reports a gap', () => {
  replay.__resetTurnReplayForTest();
  const rec = replay.openTurnReplay({ userId: 'u', chatSessionId: 's' });
  for (let i = 0; i < replay.MAX_EVENTS + 50; i += 1) rec.push({ type: 'delta', text: String(i) });
  const got = []; let info = null;
  const h = replay.attachTurnReplay('u', 's', 0, (seq, line) => { if (seq !== null) got.push([seq, line]); }, (i) => { info = i; });
  assert.equal(got.length, replay.MAX_EVENTS);
  assert.equal(got[0][0], 51);
  assert.equal(info.gap, 50);
  assert.equal(info.dropped, 50);
  h.detach();
  // an oversized event is replaced by a marker; total bytes stay capped
  rec.push({ type: 'delta', text: 'x'.repeat(300 * 1024) });
  const big = []; replay.attachTurnReplay('u', 's', replay.MAX_EVENTS + 50, (seq, line) => { if (seq !== null) big.push(line); });
  assert.match(big[0], /replay_truncated/);
  for (let i = 0; i < 40; i += 1) rec.push({ type: 'delta', text: 'y'.repeat(200 * 1024) });
  let bytes = 0; replay.attachTurnReplay('u', 's', 0, (seq, line) => { if (seq !== null) bytes += line.length; });
  assert.ok(bytes <= replay.MAX_BYTES);
});

test('readers per turn are capped', () => {
  replay.__resetTurnReplayForTest();
  replay.openTurnReplay({ userId: 'u', chatSessionId: 's' });
  for (let i = 0; i < replay.MAX_SUBSCRIBERS; i += 1) assert.ok(replay.attachTurnReplay('u', 's', 0, () => {}).detach);
  assert.equal(replay.attachTurnReplay('u', 's', 0, () => {}).full, true);
});
