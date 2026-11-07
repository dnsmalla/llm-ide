// Ended-chat continuation on the v2 stream (plan 2026-11-07-ended-chat-continuation.md): the switch, the three
// "ended" rules, the seed and notice, the cache, the fallbacks and the Host API exclusion.
// Fake turn runner and fake summariser only: no model call, no SDK, no network.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(__dirname, '_agent-v2-continue-ws');
fs.mkdirSync(WS, { recursive: true });
const tmpDb = path.join(__dirname, '_agent-v2-continue-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { registerUser } = await import('../server/users.mjs');
const { getDb, closeDb } = await import('../kb/db.mjs');
const v2 = await import('../routes/agent-v2.mjs');
const { createChatSession, appendChatMessage } = await import('../kb/chat-sessions.mjs');
const { markAgentSessionUsed, deleteAgentSession } = await import('../kb/agent-sessions.mjs');
const { getContinuation, putContinuation } = await import('../kb/chat-continuations.mjs');
const { SUMMARY_ENDPOINT } = await import('../providers/continuation.mjs');
const { fastModelFor } = await import('../kb/usage.mjs');
const db = getDb();

after(() => {
  closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  fs.rmSync(WS, { recursive: true, force: true });
});

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
    sseEvents() { return this._body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6))); },
  };
}

let n = 0;
const mkUser = () => registerUser(db, { email: `v2c-${++n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c' });
beforeEach(() => { delete process.env.LLMIDE_V2_CONTINUE_SUMMARY; });
const ON = () => { process.env.LLMIDE_V2_CONTINUE_SUMMARY = 'on'; };
const STALE = "UPDATE agent_sessions SET last_used_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ? AND mac_chat_session_id = ?";

/** A server chat with `pairs` user/assistant exchanges of about `chars` characters each. */
function seedChat(user, pairs = 7, chars = 100) {
  const chat = createChatSession(user.id, { title: 't', surface: 'any', mode: 'agent' });
  for (let i = 0; i < pairs; i += 1) {
    appendChatMessage(user.id, chat.id, { role: 'user', content: `question ${i} ${'q'.repeat(chars)}` });
    appendChatMessage(user.id, chat.id, { role: 'assistant', content: `answer ${i} ${'a'.repeat(chars)}` });
  }
  return chat.id;
}
const okTurn = (seen) => async (args) => {
  seen.push(args);
  args.onEvent({ type: 'init', sessionId: 'sdk-new', tools: [], capabilities: [] });
  args.onEvent({ type: 'result', subtype: 'success' });
  return { usageTotals: {} };
};
const fakeSummarize = (calls, text = 'SUMMARY: the user asked seven questions.') => async (prompt, opts) => { calls.push({ prompt, opts }); return text; };
async function turn(user, chat, deps, body = {}) {
  const req = makeReq({ method: 'POST', url: '/agent/v2/stream', user, body: { message: 'next question', mode: 'ask', agentContext: { chatSessionId: chat, workspaceRoot: WS, surface: 'desktop' }, ...body } });
  const res = makeRes();
  await v2.handleAgentV2Routes(req, res, { classifyMode: async () => ({ mode: 'ask' }), ...deps });
  return res;
}
const continued = (res) => res.sseEvents().find((e) => e.type === 'notice' && e.kind === 'chat_continued');

test('switch off: an ended server chat runs exactly as before (no summary call, no seed, no notice)', async () => {
  const u = mkUser(); const chat = seedChat(u);
  const seen = []; const calls = [];
  const res = await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 0);
  assert.deepEqual(seen[0].history, []);
  assert.equal(continued(res), undefined);
});

test('switch on, no SDK session: one summary on the fast model under the turn id, then summary + last turns, notice after mode_set', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const seen = []; const calls = [];
  const res = await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.endpoint, SUMMARY_ENDPOINT);
  assert.equal(calls[0].opts.provider, 'anthropic');
  assert.equal(calls[0].opts.model, fastModelFor('anthropic'));
  assert.equal(typeof calls[0].opts.requestId, 'string');
  assert.match(calls[0].prompt, /question 0/);
  assert.doesNotMatch(calls[0].prompt, /question 6/, 'the kept turns are not summarised');
  const h = seen[0].history;
  assert.match(h[0].content, /Handoff note/);
  assert.match(h[0].content, /SUMMARY: the user asked seven questions\./);
  assert.match(h.at(-1).content, /^answer 6/);
  assert.equal(seen[0].resumeSdkSessionId, undefined);
  const evs = res.sseEvents();
  const at = evs.findIndex((e) => e.type === 'mode_set');
  assert.equal(evs[at + 1].kind, 'chat_continued');
  assert.deepEqual(evs[at + 1].data, { reason: 'no_session', coveredTurns: 8, keptTurns: 6, cached: false });
  assert.equal(getContinuation(u.id, chat).source, 'server');
});

test('cached by content: the next ended turn with the same older turns makes no call; new older turns make one', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const calls = [];
  await turn(u, chat, { runTurn: okTurn([]), summarize: fakeSummarize(calls) });
  deleteAgentSession(db, u.id, chat);
  const res = await turn(u, chat, { runTurn: okTurn([]), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 1);
  assert.equal(continued(res).data.cached, true);
  appendChatMessage(u.id, chat, { role: 'user', content: 'question 7' });
  appendChatMessage(u.id, chat, { role: 'assistant', content: 'answer 7' });
  deleteAgentSession(db, u.id, chat);
  await turn(u, chat, { runTurn: okTurn([]), summarize: fakeSummarize(calls) });
  assert.equal(calls.length, 2);
});

test('idle past the TTL on a long chat starts fresh from the summary; warm, or short and idle, resumes as before', async () => {
  ON();
  const u = mkUser();
  const long = seedChat(u, 7, 2_000);
  markAgentSessionUsed(db, u.id, long, { sdkSessionId: 'sdk-old', model: null, mode: 'ask' });
  const calls = []; const warm = [];
  await turn(u, long, { runTurn: okTurn(warm), summarize: fakeSummarize(calls) });
  assert.equal(warm[0].resumeSdkSessionId, 'sdk-old');
  assert.equal(calls.length, 0);
  db.prepare(STALE).run(u.id, long);
  const cold = [];
  const res = await turn(u, long, { runTurn: okTurn(cold), summarize: fakeSummarize(calls) });
  assert.equal(cold[0].resumeSdkSessionId, undefined);
  assert.equal(calls.length, 1);
  assert.equal(continued(res).data.reason, 'idle');
  const short = seedChat(u, 2, 50);
  markAgentSessionUsed(db, u.id, short, { sdkSessionId: 'sdk-short', model: null, mode: 'ask' });
  db.prepare(STALE).run(u.id, short);
  const s = [];
  await turn(u, short, { runTurn: okTurn(s), summarize: fakeSummarize(calls) });
  assert.equal(s[0].resumeSdkSessionId, 'sdk-short');
  assert.equal(calls.length, 1);
});

test('the Host API (phone, web) keeps today behaviour: it has no way to show the notice', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const calls = []; const seen = [];
  await v2.startHostTurn({ userId: u.id, chatSessionId: chat, message: 'next', onEvent: () => {}, deps: { classifyMode: async () => ({ mode: 'ask' }), runTurn: okTurn(seen), summarize: fakeSummarize(calls) } });
  assert.equal(calls.length, 0);
  assert.deepEqual(seen[0].history, []);
});

test('a failed summary call falls back to today behaviour and the turn still runs', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const seen = [];
  const res = await turn(u, chat, { runTurn: okTurn(seen), summarize: async () => { throw Object.assign(new Error('boom'), { code: 'PROVIDER_UNAVAILABLE' }); } });
  assert.deepEqual(seen[0].history, []);
  assert.equal(continued(res), undefined);
  assert.ok(res.sseEvents().some((e) => e.type === 'result'));
  assert.equal(getContinuation(u.id, chat), null);
});

test('continueMode replay: no summary; the chat record seeds the turn by the fresh-turn rule', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const seen = []; const calls = [];
  await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize(calls) }, { continueMode: 'replay' });
  assert.equal(calls.length, 0);
  assert.equal(seen[0].history.length, 14);
  assert.match(seen[0].history[0].content, /^question 0/);
});

test('no server record: the history a client sent with fresh:true is summarised (the bench, older clients)', async () => {
  ON();
  const u = mkUser();
  const history = [];
  for (let i = 0; i < 7; i += 1) history.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
  const seen = []; const calls = [];
  await turn(u, 'no-server-row', { runTurn: okTurn(seen), summarize: fakeSummarize(calls) }, { fresh: true, history });
  assert.equal(calls.length, 1);
  assert.equal(getContinuation(u.id, 'no-server-row').source, 'client');
  assert.match(seen[0].history[0].content, /Handoff note/);
});

test('the message the desktop stored before sending is not history', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  appendChatMessage(u.id, chat, { role: 'user', content: 'next question' });
  const seen = [];
  await turn(u, chat, { runTurn: okTurn(seen), summarize: fakeSummarize([]) });
  assert.match(seen[0].history.at(-1).content, /^answer 6/);
  assert.ok(!seen[0].history.some((t) => t.content === 'next question'));
});

test('DELETE /agent/v2/session drops a client-made continuation', async () => {
  const u = mkUser();
  await putContinuation(u.id, 'client-chat', { summary: 's', contentHash: 'a'.repeat(64), coveredTurns: 2, source: 'client' });
  const req = makeReq({ method: 'DELETE', url: '/agent/v2/session', body: { chatSessionId: 'client-chat' }, user: u });
  const res = makeRes();
  await v2.handleAgentV2Routes(req, res, {});
  assert.equal(getContinuation(u.id, 'client-chat'), null);
});

test('an engine failure before init still sends the continuation notice', async () => {
  ON();
  const u = mkUser(); const chat = seedChat(u);
  const res = await turn(u, chat, { runTurn: async () => { throw Object.assign(new Error('boom'), { code: 'ENGINE_ERROR' }); }, summarize: fakeSummarize([]) });
  const evs = res.sseEvents();
  assert.ok(evs.some((e) => e.type === 'notice' && e.kind === 'chat_continued'));
  assert.ok(evs.some((e) => e.type === 'error'));
});
