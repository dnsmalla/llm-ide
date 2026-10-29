// Session router on the v2 stream (K1 Phase 6b T6b.3/T6b.5): the fail-closed pre-turn check, the cap,
// counters on every exit path, pending switches, the adapter dispatch, tenancy and the routes.
// Fake turn runners only: no model call, no SDK, no network.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_agent-v2-router-ws');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-router-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const { handleAgentV2Routes } = await import('../routes/agent-v2.mjs');
const { getOrCreateAgentSession, markAgentSessionUsed } = await import('../kb/agent-sessions.mjs');
const route = await import('../kb/chat-route.mjs');
const db = getDb();

after(() => { closeDb(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });

function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user, headers: {}, refunded: 0,
    rateLimitRefund() { req.refunded += 1; },
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end' || event === 'close') cb(); return req; },
  };
  return req;
}
function makeRes() {
  return {
    on() { return this; }, statusCode: 200, headers: {}, _body: '',
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); },
    write(c) { this._body += c; }, end(c) { if (c) this._body += c; this.ended = true; },
    json() { return JSON.parse(this._body); },
    sseEvents() { return this._body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6))); },
  };
}
const mk = (n) => registerUser(db, { email: `${n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: n });
const A = mk('rt-a');
const B = mk('rt-b');

let n = 0;
const chatId = () => `rt-chat-${++n}`;
const ON = () => { process.env.LLMIDE_ROUTER = 'on'; process.env.LLMIDE_ROUTER_CAP = 'on'; };
beforeEach(() => { delete process.env.LLMIDE_ROUTER; delete process.env.LLMIDE_ROUTER_CAP; });

async function call(method, url, body, user = A, deps) {
  const req = makeReq({ method, url, body, user }); const res = makeRes();
  await handleAgentV2Routes(req, res, deps ?? { runTurn: async () => ({ usageTotals: {} }) });
  return { req, res };
}
async function turn(chat, deps, body = {}, user = A) {
  return call('POST', '/agent/v2/stream', { message: 'go', mode: 'execute', agentContext: { chatSessionId: chat, workspaceRoot: WS }, ...body }, user, deps);
}
const usageEv = (i, o, cw = 0, cr = 0) => ({ type: 'usage', inputTokens: i, outputTokens: o, cacheCreationTokens: cw, cacheReadTokens: cr });
const okTurn = (usage, seen) => async (args) => {
  seen?.push(args);
  args.onEvent({ type: 'init', sessionId: 'sdk-1', tools: [], capabilities: [] });
  args.onEvent(usage);
  args.onEvent({ type: 'result', subtype: 'success' });
  return { result: {}, usageTotals: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens } };
};
const used = (chat, user = A) => route.getRoute(db, user.id, chat)?.used?.billable ?? null;

test('router OFF (default): no row is created, the client pick runs, the routes say disabled', async () => {
  const chat = chatId();
  const seen = [];
  const { res } = await turn(chat, { runTurn: okTurn(usageEv(10, 5), seen) }, { model: 'm-client' });
  assert.equal(res.statusCode, 200);
  assert.equal(seen[0].model, 'm-client');
  assert.equal(seen[0].maxBillableTokens, undefined);
  assert.equal(route.getRoute(db, A.id, chat), null, 'with the flag off nothing is written');
  const g = await call('GET', `/agent/v2/session/route?chatSessionId=${chat}`);
  assert.deepEqual([g.res.statusCode, g.res.json().enabled], [200, false]);
  const p = await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 5 });
  assert.equal(p.res.statusCode, 409);
  assert.equal(p.res.json().error.code, 'ROUTER_DISABLED');
});

test('router ON: a pinned route overrides the request, counters commit from the usage event, notices ride the stream', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, provider: 'anthropic', model: 'pinned-model', tokenLimit: 1000 });
  const seen = [];
  const { res } = await turn(chat, { runTurn: okTurn(usageEv(100, 50, 10, 9999), seen) }, { model: 'client-model' });
  assert.equal(seen[0].model, 'pinned-model');
  assert.equal(seen[0].maxBillableTokens, 1000);
  const r = route.getRoute(db, A.id, chat);
  assert.equal(r.used.billable, 160);
  assert.equal(r.used.cacheRead, 9999);
  assert.ok(r.warm['anthropic|pinned-model']);
  assert.ok(res.sseEvents().some((e) => e.type === 'mode_set'));
});

test('cap: a chat at its limit is refused 409 BEFORE any model call and the rate-limit token is refunded; raising the cap works', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 100, tokensUsed: 100 });
  let called = 0;
  const { req, res } = await turn(chat, { runTurn: async () => { called += 1; return { usageTotals: {} }; } });
  assert.equal(res.statusCode, 409);
  const err = res.json().error;
  assert.deepEqual([err.code, err.details.used, err.details.limit], ['SESSION_TOKEN_LIMIT', 100, 100]);
  assert.equal(called, 0);
  assert.equal(req.refunded >= 1, true);
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 400 });
  const ok = await turn(chat, { runTurn: okTurn(usageEv(10, 10)) });
  assert.equal(ok.res.statusCode, 200);
});

test('cap trip mid-turn: the engine gets the remaining ceiling, the notice says reached, the NEXT turn is refused, counters equal the usage', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 200 });
  const seen = [];
  const { res } = await turn(chat, { runTurn: okTurn(usageEv(150, 120), seen) });
  assert.equal(seen[0].maxBillableTokens, 200);
  const notice = res.sseEvents().find((e) => e.type === 'notice' && e.kind === 'session_budget');
  assert.equal(notice.data.level, 'reached');
  assert.equal(used(chat), 270, 'overshoot is recorded, never hidden');
  const next = await turn(chat, { runTurn: okTurn(usageEv(1, 1)) });
  assert.equal(next.res.statusCode, 409);
  assert.equal(used(chat), 270);
  const hist = (await call('GET', `/agent/v2/session/route/history?chatSessionId=${chat}`)).res.json();
  assert.ok(hist.events.some((e) => e.kind === 'cap_reached'));
});

test('warn80 fires once as the chat crosses 80 percent', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 1000 });
  const a = await turn(chat, { runTurn: okTurn(usageEv(400, 450)) });
  assert.equal(a.res.sseEvents().find((e) => e.kind === 'session_budget').data.level, 'warn80');
  const b = await turn(chat, { runTurn: okTurn(usageEv(1, 1)) });
  assert.equal(b.res.sseEvents().some((e) => e.kind === 'session_budget'), false);
});

test('cap flag off with the router on: the limit is stored and shown, never enforced, no ceiling passed', async () => {
  process.env.LLMIDE_ROUTER = 'on';
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 5, tokensUsed: 50 });
  const g = (await call('GET', `/agent/v2/session/route?chatSessionId=${chat}`)).res.json();
  assert.deepEqual([g.enabled, g.capEnforced, g.tokenLimit], [true, false, 5]);
  const seen = [];
  const { res } = await turn(chat, { runTurn: okTurn(usageEv(1, 1), seen) });
  assert.equal(res.statusCode, 200);
  assert.equal(seen[0].maxBillableTokens, undefined);
});

test('counters move on EVERY exit path and exactly once: error after usage, abort, no usage at all', async () => {
  ON();
  const errChat = chatId();
  await turn(errChat, { runTurn: async (args) => { args.onEvent(usageEv(10, 5)); throw new Error('engine died after streaming'); } });
  assert.equal(used(errChat), 15, 'a failed turn still spent tokens');

  const dupChat = chatId();
  await turn(dupChat, { runTurn: async (args) => {
    args.onEvent(usageEv(10, 5));
    return { usageTotals: { inputTokens: 10, outputTokens: 5 } };   // the final totals repeat the event: never counted twice
  } });
  assert.equal(used(dupChat), 15, 'never over-counts');

  const noUsage = chatId();
  await turn(noUsage, { runTurn: async () => { throw new Error('failed before any model call'); } });
  assert.equal(route.getRoute(db, A.id, noUsage), null, 'a turn that spent nothing leaves no row');

  const finalOnly = chatId();
  await turn(finalOnly, { runTurn: async () => ({ usageTotals: { inputTokens: 7, outputTokens: 3 } }) });
  assert.equal(used(finalOnly), 10, 'no usage event: the final totals are committed in the exit path');
});

test('crash model: a usage event committed before the terminal events survives a later failure; nothing is committed twice', async () => {
  ON();
  const chat = chatId();
  await turn(chat, { runTurn: async (args) => {
    args.onEvent(usageEv(100, 100));
    throw Object.assign(new Error('process dying'), { code: 'ENGINE_ERROR' });
  } });
  assert.equal(used(chat), 200);
  await turn(chat, { runTurn: okTurn(usageEv(1, 1)) });
  assert.equal(used(chat), 202, 'counters accumulate, one commit per turn');
});

test('a PUT during a turn is pending: the running turn keeps its model, the next turn switches and says so', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, provider: 'anthropic', model: 'model-a' });
  let putOut;
  const seen = [];
  await turn(chat, { runTurn: async (args) => {
    seen.push(args.model);
    args.onEvent({ type: 'init', sessionId: 's', tools: [], capabilities: [] });
    putOut = await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, provider: 'anthropic', model: 'model-b' });
    args.onEvent(usageEv(5, 5));
    return { usageTotals: { inputTokens: 5, outputTokens: 5 } };
  } });
  assert.equal(putOut.res.json().appliesAt, 'next_turn');
  assert.deepEqual(seen, ['model-a'], 'the stream\'s model did not change mid-turn');
  const second = [];
  const { res } = await turn(chat, { runTurn: okTurn(usageEv(1, 1), second) });
  assert.equal(second[0].model, 'model-b');
  const sw = res.sseEvents().find((e) => e.kind === 'route_switch');
  assert.equal(sw.data.to.model, 'model-b');
  assert.equal(sw.data.from.model, 'model-a');
  assert.equal(route.getRoute(db, A.id, chat).pending, null);
});

test('store unavailable: fail CLOSED with 503 ROUTE_UNAVAILABLE and no model call; recovers when the store does', async () => {
  ON();
  const chat = chatId();
  db.exec('ALTER TABLE chat_session_route RENAME TO chat_session_route_x');
  try {
    let called = 0;
    const { res } = await turn(chat, { runTurn: async () => { called += 1; return { usageTotals: {} }; } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'ROUTE_UNAVAILABLE');
    assert.equal(called, 0);
    const p = await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 5 });
    assert.equal(p.res.statusCode, 503);
  } finally {
    db.exec('ALTER TABLE chat_session_route_x RENAME TO chat_session_route');
  }
  assert.equal((await turn(chat, { runTurn: okTurn(usageEv(1, 1)) })).res.statusCode, 200);
});

test('two windows: a stale ifSeq loses with 409 ROUTE_CONFLICT and the current row', async () => {
  ON();
  const chat = chatId();
  const first = (await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 10 })).res.json();
  const w1 = await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 20, ifSeq: first.switchSeq });
  const w2 = await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 30, ifSeq: first.switchSeq });
  assert.equal(w1.res.statusCode, 200);
  assert.equal(w2.res.statusCode, 409);
  const body = w2.res.json().error;
  assert.equal(body.code, 'ROUTE_CONFLICT');
  assert.equal(body.details.current.tokenLimit, 20);
});

test('bad caps and providers are 400s: negative, huge, fractional, string, unknown provider', async () => {
  ON();
  const chat = chatId();
  for (const tokenLimit of [-1, 1e13, 2.5, '9']) {
    const { res } = await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit });
    assert.equal(res.statusCode, 400, String(tokenLimit));
  }
  assert.equal((await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, provider: 'openai', model: 'x' })).res.statusCode, 400);
  assert.equal((await call('PUT', '/agent/v2/session/route', { provider: 'anthropic', model: 'x' })).res.statusCode, 400);
  assert.equal((await call('GET', '/agent/v2/session/route')).res.statusCode, 400);
  assert.equal(route.getRoute(db, A.id, chat), null, 'nothing was written');
});

test('tenancy: another user\'s chat id reads empty, cannot hit or change the owner\'s cap, and a turn there is not capped by it', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 10, tokensUsed: 10 });
  const g = (await call('GET', `/agent/v2/session/route?chatSessionId=${chat}`, undefined, B)).res.json();
  assert.deepEqual([g.tokenLimit, g.used.billable], [null, 0]);
  const t = await turn(chat, { runTurn: okTurn(usageEv(1, 1)) }, {}, B);
  assert.equal(t.res.statusCode, 200, 'B is not blocked by A\'s cap');
  assert.equal(route.getRoute(db, A.id, chat).used.billable, 10, 'A\'s counter is untouched');
  assert.equal((await turn(chat, { runTurn: okTurn(usageEv(1, 1)) })).res.statusCode, 409, 'A is still capped');
  const h = (await call('GET', `/agent/v2/session/route/history?chatSessionId=${chat}`, undefined, B)).res.json();
  assert.deepEqual(h.events.filter((e) => e.kind === 'cap_reached'), []);
});

test('deleting the chat removes its route; a PUT after that starts a fresh row', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 10 });
  await call('DELETE', '/agent/v2/session', { chatSessionId: chat });
  assert.equal(route.getRoute(db, A.id, chat), null);
  const p = await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, tokenLimit: 7 });
  assert.equal(p.res.json().switchSeq, 1);
});

test('a catalog provider runs through the adapter: no SDK binding, no double ledger row, answered provider is the warm key', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, provider: 'custom:cat-groq', model: 'llama', tokenLimit: 500 });
  let engineCalls = 0;
  const adapterSeen = [];
  const before = db.prepare('SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id = ?').get(A.id).n;
  const { res } = await turn(chat, {
    runTurn: async () => { engineCalls += 1; return { usageTotals: {} }; },
    runAdapterTurn: async (args) => {
      adapterSeen.push(args);
      args.onEvent({ type: 'init', sessionId: 'adapter-key', tools: [], capabilities: ['provider-adapter'] });
      args.onEvent({ type: 'result', subtype: 'success' });
      return { usageTotals: { inputTokens: 30, outputTokens: 20 }, metered: true, answered: { provider: 'custom:cat-cerebras', model: 'llama-c' } };
    },
  }, { history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }] });
  assert.equal(res.statusCode, 200);
  assert.equal(engineCalls, 0);
  assert.equal(adapterSeen[0].provider, 'custom:cat-groq');
  assert.equal(adapterSeen[0].maxBillableTokens, 500);
  assert.equal(adapterSeen[0].history.length, 2, 'an adapter has no session: it gets the history');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_ledger WHERE user_id = ?').get(A.id).n, before, 'the adapter metered itself');
  const r = route.getRoute(db, A.id, chat);
  assert.equal(r.used.billable, 50);
  assert.ok(r.warm['custom:cat-cerebras|llama-c']);
  assert.equal(db.prepare('SELECT sdk_session_id FROM agent_sessions WHERE user_id = ? AND mac_chat_session_id = ?').get(A.id, chat)?.sdk_session_id ?? null, null, 'the adapter key is never bound as an SDK session');
});

test('switching back to Claude after another provider never resumes the old SDK session', async () => {
  ON();
  const chat = chatId();
  getOrCreateAgentSession(db, A.id, chat);
  markAgentSessionUsed(db, A.id, chat, { sdkSessionId: 'old-sdk', model: 'm', mode: 'execute' });
  route.putRoute(db, A.id, chat, { provider: 'anthropic', model: 'm' });
  route.commitTurnUsage(db, A.id, chat, { inputTokens: 1 }, { provider: 'custom:cat-groq', model: 'llama', now: new Date(), ttlMs: 60_000 });
  const seen = [];
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i} body` }));
  await turn(chat, { runTurn: okTurn(usageEv(1, 1), seen) }, { history: long, summary: 'Mac file summary', summaryUpTo: 'msg-9' });
  assert.equal(seen[0].resumeSdkSessionId, undefined, 'a cold transcript is never resumed');
  assert.match(seen[0].history[0].content, /Mac file summary/, 'the client\'s summary is the single copy of the note');
  assert.ok(seen[0].history.length <= 8, 'a note and the last turns, not 40 turns');
  const hist = route.listRouteEvents(A.id, chat).events;
  assert.ok(hist.some((e) => e.kind === 'handoff_built' && e.reason === 'client'));
  assert.equal(db.prepare('SELECT handoff_up_to, handoff_note FROM chat_session_route WHERE user_id = ? AND chat_session_id = ?').get(A.id, chat).handoff_note, null, 'the server stores no note text');
  assert.equal(route.getRoute(db, A.id, chat).handoffUpTo, 'msg-9');
});

test('the history route lists switches newest first and answers degraded rather than failing', async () => {
  ON();
  const chat = chatId();
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, provider: 'anthropic', model: 'one' });
  await call('PUT', '/agent/v2/session/route', { chatSessionId: chat, provider: 'anthropic', model: 'two' });
  const h = (await call('GET', `/agent/v2/session/route/history?chatSessionId=${chat}`)).res.json();
  assert.equal(h.degraded, false);
  assert.deepEqual(h.events.filter((e) => e.kind === 'switch').map((e) => e.toModel), ['two', 'one']);
});
