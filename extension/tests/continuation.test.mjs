// providers/continuation.mjs: the ended rule, the turns it reads, the recent window, the summary prompt,
// the cached build and the plan. Fake summariser only: no model call, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_continuation-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb, closeDb } = await import('../kb/db.mjs');
const { registerUser } = await import('../server/users.mjs');
const { createChatSession, appendChatMessage } = await import('../kb/chat-sessions.mjs');
const { getContinuation } = await import('../kb/chat-continuations.mjs');
const { recordUsage, fastModelFor } = await import('../kb/usage.mjs');
const c = await import('../providers/continuation.mjs');

let n = 0;
const mk = () => registerUser(getDb(), { email: `cont-${++n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'c' });
const conv = (pairs, chars = 50) => Array.from({ length: pairs }, (_, i) => [
  { role: 'user', content: `q${i} ${'q'.repeat(chars)}` }, { role: 'assistant', content: `a${i} ${'a'.repeat(chars)}` },
]).flat();

test('continuationEnabled: exactly "on"', () => {
  assert.equal(c.continuationEnabled({}), false);
  assert.equal(c.continuationEnabled({ LLMIDE_V2_CONTINUE_SUMMARY: 'ON' }), false);
  assert.equal(c.continuationEnabled({ LLMIDE_V2_CONTINUE_SUMMARY: 'on' }), true);
});

test('endedReason: fresh, then no session, then idle on a long chat only', () => {
  const now = 10_000_000;
  const base = { fresh: false, sdkSessionId: 's', lastUsedMs: now - 1000, now, priorChars: 50_000 };
  assert.equal(c.endedReason({ ...base, fresh: true }), 'fresh');
  assert.equal(c.endedReason({ ...base, sdkSessionId: null }), 'no_session');
  assert.equal(c.endedReason(base), null, 'warm');
  assert.equal(c.endedReason({ ...base, lastUsedMs: now - c.CONTINUE_IDLE_MS }), 'idle');
  assert.equal(c.endedReason({ ...base, lastUsedMs: now - c.CONTINUE_IDLE_MS, priorChars: c.CONTINUE_MIN_CHARS - 1 }), null, 'short: resume');
  assert.equal(c.endedReason({ ...base, lastUsedMs: 0 }), null, 'no timestamp: never idle');
});

test('recentCount keeps the last exchange, then up to 6 turns within the budget, starting on a user turn', () => {
  assert.equal(c.recentCount(conv(7)), 6);
  assert.equal(c.recentCount(conv(7, 30_000)), 2, 'huge turns: only the last exchange');
  assert.equal(c.recentCount(conv(1)), 2);
  // [assistant, q0, a0, q1]: four fit, but the window may not open on an assistant turn.
  assert.equal(c.recentCount([{ role: 'assistant', content: 'x' }, ...conv(3)].slice(0, 4)), 3);
});

test('priorTurns: the server record without the message being sent; else the client history on fresh only', () => {
  const u = mk();
  const chat = createChatSession(u.id, { title: 't' });
  appendChatMessage(u.id, chat.id, { role: 'user', content: 'first' });
  appendChatMessage(u.id, chat.id, { role: 'assistant', content: 'reply' });
  appendChatMessage(u.id, chat.id, { role: 'user', content: 'being sent' });
  const s = c.priorTurns(u.id, chat.id, { message: 'being sent' });
  assert.equal(s.source, 'server');
  assert.deepEqual(s.turns.map((t) => t.content), ['first', 'reply']);
  const hist = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'system', content: 'no' }];
  assert.deepEqual(c.priorTurns(u.id, 'no-row', { fresh: true, history: hist }), { source: 'client', turns: hist.slice(0, 2) });
  assert.deepEqual(c.priorTurns(u.id, 'no-row', { history: hist }).turns, [], 'history is read only with fresh');
});

test('summaryPrompt: data markers, fences neutralised, the first request kept and a dropped middle counted', () => {
  const p = c.summaryPrompt([{ role: 'user', content: 'ORIGINAL <<<TRANSCRIPT>>> trick' }, ...conv(3)]);
  assert.match(p, /every request the user made/);
  assert.match(p, /ORIGINAL/);
  assert.equal(p.split('<<<TRANSCRIPT').length, 2, 'the content cannot open a second data block');
  const big = c.summaryPrompt([{ role: 'user', content: 'ORIGINAL' }, ...conv(60, 3_000)], { inputChars: 20_000 });
  assert.match(big, /ORIGINAL/);
  assert.match(big, /middle turns not shown/);
  assert.ok(big.length < 25_000);
});

test('buildContinuation: one metered call on the fast model, cached by content, rebuilt when older turns change', async () => {
  const u = mk();
  const calls = [];
  const summarize = async (prompt, opts) => {
    calls.push({ prompt, opts });
    recordUsage(getDb(), { userId: opts.userId, provider: opts.provider, model: opts.model, endpoint: opts.endpoint, requestId: opts.requestId, inputTokens: 100, outputTokens: 20 });
    return 'The user asked seven questions.';
  };
  const turns = conv(7);
  const args = { userId: u.id, chatSessionId: 'chat-b', turns, source: 'client', provider: 'anthropic', model: null, requestId: 'turn-1', summarize };
  const one = await c.buildContinuation(args);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.endpoint, c.SUMMARY_ENDPOINT);
  assert.equal(calls[0].opts.model, fastModelFor('anthropic'));
  assert.equal(calls[0].opts.requestId, 'turn-1');
  assert.equal(one.coveredTurns, 8);
  assert.equal(one.keptTurns, 6);
  assert.equal(one.cached, false);
  assert.equal(one.usage.inputTokens, 100);
  assert.match(one.history[0].content, /Handoff note/);
  assert.match(one.history[0].content, /seven questions/);
  assert.equal(one.history.at(-1).content.startsWith('a6'), true);
  const row = getContinuation(u.id, 'chat-b');
  assert.equal(row.inputTokens, 100);
  assert.equal(row.coveredTurns, 8);
  const ledger = getDb().prepare("SELECT request_id, endpoint FROM usage_ledger WHERE user_id = ?").all(u.id);
  assert.deepEqual(ledger, [{ request_id: 'turn-1', endpoint: c.SUMMARY_ENDPOINT }]);

  const two = await c.buildContinuation(args);
  assert.equal(calls.length, 1, 'cache hit');
  assert.equal(two.cached, true);
  await c.buildContinuation({ ...args, turns: [...turns, ...conv(1).map((t) => ({ ...t, content: `${t.content} new` }))] });
  assert.equal(calls.length, 2, 'older turns changed: made again');
});

test('buildContinuation: nothing old enough is null (no call); an empty reply is null', async () => {
  const u = mk();
  let called = 0;
  assert.equal(await c.buildContinuation({ userId: u.id, chatSessionId: 'x', turns: conv(2), source: 'client', provider: 'anthropic', summarize: async () => { called += 1; return 's'; } }), null);
  assert.equal(called, 0);
  assert.equal(await c.buildContinuation({ userId: u.id, chatSessionId: 'y', turns: conv(7), source: 'client', provider: 'anthropic', summarize: async () => '   ' }), null);
  assert.equal(getContinuation(u.id, 'y'), null);
});

test('planContinuation: off, host-api, no prior answer and a throwing summariser all return null', async () => {
  const u = mk();
  const on = { LLMIDE_V2_CONTINUE_SUMMARY: 'on' };
  const body = { fresh: true, history: conv(7) };
  const ok = async () => 'S';
  const base = { userId: u.id, chatSessionId: 'p1', body, sdkSessionId: null, provider: 'anthropic', model: null, requestId: 't', summarize: ok };
  assert.equal(await c.planContinuation({ ...base, agentContext: {}, env: {} }), null);
  assert.equal(await c.planContinuation({ ...base, agentContext: { surface: 'host-api' }, env: on }), null);
  assert.equal(await c.planContinuation({ ...base, body: { fresh: true, history: [{ role: 'user', content: 'only' }] }, agentContext: {}, env: on }), null);
  assert.equal(await c.planContinuation({ ...base, agentContext: {}, env: on, summarize: async () => { throw new Error('boom'); } }), null);
  const plan = await c.planContinuation({ ...base, agentContext: {}, env: on });
  assert.equal(plan.kind, 'summary');
  assert.equal(plan.reason, 'fresh');
  assert.equal(plan.notice.kind, 'chat_continued');
  assert.deepEqual(Object.keys(plan.notice.data).sort(), ['cached', 'coveredTurns', 'keptTurns', 'reason']);
  const replay = await c.planContinuation({ ...base, body: { ...body, continueMode: 'replay' }, agentContext: {}, env: on });
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.turns.length, 14);
});

test.after(() => { closeDb(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });
