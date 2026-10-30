// Session router store (K1 Phase 6b T6b.1): the route row, compare-and-set, pending
// switches, token counters, validation, tenancy, and the purge paths (quit-archive,
// tombstone replay, account delete). Temp DB only; no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_chat-route-store-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const route = await import('../kb/chat-route.mjs');
const lc = await import('../kb/chat-lifecycle.mjs');
const { replaySessionPurges } = await import('../routes/lifecycle-routes.mjs');
const conn = db.getDb();
const mk = (n) => users.registerUser(conn, { email: `${n}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: n }).id;
const U = mk('cr1');
const V = mk('cr2');

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

const put = (chat, patch, opts, user = U) => route.putRoute(conn, user, chat, patch, opts);

test('create, read back, and a limit-only row is unpinned', () => {
  assert.equal(route.getRoute(conn, U, 'c-new'), null);
  const r = put('c-new', { tokenLimit: 5000 });
  assert.equal(r.route.pinned, false);
  assert.equal(r.route.tokenLimit, 5000);
  assert.equal(r.route.remaining, 5000);
  assert.equal(r.route.switchSeq, 1);
  const s = put('c-new', { provider: 'anthropic', model: 'claude-x' });
  assert.deepEqual(s.switched.to, { provider: 'anthropic', model: 'claude-x' });
  assert.equal(s.route.switchSeq, 2);
});

test('validation: negative, fractional, huge, string caps and half-set pairs are refused', () => {
  for (const bad of [-1, 1.5, 2e12, '100', NaN, Infinity, {}]) {
    assert.throws(() => put('c-val', { tokenLimit: bad }), (e) => e.code === 'VALIDATION_FAILED', String(bad));
  }
  assert.throws(() => put('c-val', { provider: 'p' }), /set together/);
  assert.throws(() => put('c-val', { provider: 'p', model: '' }), /both/);
  assert.throws(() => put('c-val', { provider: 'p\nq', model: 'm' }), /valid id/);
  assert.throws(() => put('c-val', { tokensUsed: -5 }), /tokensUsed/);
  assert.throws(() => route.getRoute(conn, U, ''), /chatSessionId/);
  assert.equal(put('c-val', { tokenLimit: 0 }).route.tokenLimit, null, '0 means no cap');
  assert.equal(put('c-val', { tokenLimit: null }).changed, false, 'clearing a cleared cap changes nothing');
});

test('compare-and-set: of two windows holding the same seq, one wins and the loser gets the current row', () => {
  const base = put('c-cas', { provider: 'anthropic', model: 'a' }).route;
  const win = put('c-cas', { provider: 'custom:cat-groq', model: 'g' }, { }, U);
  assert.ok(win.changed);
  void base;
  const first = put('c-cas2', { tokenLimit: 10 }).route.switchSeq;
  put('c-cas2', { tokenLimit: 20, ifSeq: first });
  assert.throws(() => put('c-cas2', { tokenLimit: 30, ifSeq: first }),
    (e) => e.code === 'ROUTE_CONFLICT' && e.status === 409 && e.extra.current.tokenLimit === 20);
  assert.throws(() => put('c-none', { tokenLimit: 1, ifSeq: 4 }), (e) => e.code === 'ROUTE_CONFLICT');
  assert.equal(put('c-none', { tokenLimit: 1, ifSeq: 0 }).route.switchSeq, 1, 'a missing row is seq 0');
});

test('a PUT while a turn runs is pending until the next turn start; the limit applies at once', () => {
  put('c-pend', { provider: 'anthropic', model: 'a', tokenLimit: 100 });
  const r = put('c-pend', { provider: 'custom:cat-groq', model: 'g', tokenLimit: 900 }, { inFlight: true });
  assert.equal(r.appliesAt, 'next_turn');
  assert.equal(r.route.provider, 'anthropic', 'the running turn keeps its model');
  assert.deepEqual({ p: r.route.pending.provider, m: r.route.pending.model }, { p: 'custom:cat-groq', m: 'g' });
  assert.equal(r.route.tokenLimit, 900);
  const a = route.applyPending(conn, U, 'c-pend');
  assert.equal(a.route.provider, 'custom:cat-groq');
  assert.deepEqual(a.switched.from, { provider: 'anthropic', model: 'a' });
  assert.equal(route.applyPending(conn, U, 'c-pend').switched, null, 'idempotent');
  // Re-pinning the current pick cancels a pending change.
  put('c-pend', { provider: 'anthropic', model: 'a' }, { inFlight: true });
  assert.ok(route.getRoute(conn, U, 'c-pend').pending);
  put('c-pend', { provider: 'custom:cat-groq', model: 'g' }, { inFlight: true });
  assert.equal(route.getRoute(conn, U, 'c-pend').pending, null);
});

test('counters are billable (in + out + cache write); cache reads are shown, never counted', () => {
  put('c-cnt', { provider: 'anthropic', model: 'a', tokenLimit: 1000 });
  const r = route.commitTurnUsage(conn, U, 'c-cnt', { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 25, cacheReadTokens: 9000 },
    { provider: 'anthropic', model: 'a', ttlMs: 60_000 });
  assert.equal(r.used.billable, 175);
  assert.equal(r.used.cacheRead, 9000);
  assert.equal(r.remaining, 825);
  assert.ok(r.stickyUntil && r.warm['anthropic|a']);
  const r2 = route.commitTurnUsage(conn, U, 'c-cnt', { inputTokens: 1, outputTokens: 1 }, { provider: 'anthropic', model: 'a' });
  assert.equal(r2.used.billable, 177, 'increments add up');
  route.commitTurnUsage(conn, U, 'c-cnt', { inputTokens: -50, outputTokens: NaN, cacheCreationTokens: 'x' }, {});
  assert.equal(route.getRoute(conn, U, 'c-cnt').used.billable, 177, 'garbage usage never subtracts');
});

test('a turn on a chat with no row creates one; the seed only fills an empty counter', () => {
  const r = route.commitTurnUsage(conn, U, 'c-lazy', { inputTokens: 7, outputTokens: 3 }, { provider: 'anthropic', model: 'a' });
  assert.equal(r.used.billable, 10);
  assert.equal(r.pinned, false);
  put('c-lazy', { tokensUsed: 99999 });
  assert.equal(route.getRoute(conn, U, 'c-lazy').used.billable, 10, 'the server counter is the truth');
  put('c-seed', { tokenLimit: 500, tokensUsed: 400 });
  assert.equal(route.getRoute(conn, U, 'c-seed').used.billable, 400, 'a fresh row takes the seed (re-seed after quit)');
});

test('tenancy: another user sees nothing and changes nothing', () => {
  put('c-ten', { provider: 'anthropic', model: 'a', tokenLimit: 10 });
  assert.equal(route.getRoute(conn, V, 'c-ten'), null);
  put('c-ten', { tokenLimit: 5 }, {}, V);
  assert.equal(route.getRoute(conn, U, 'c-ten').tokenLimit, 10);
  assert.equal(route.deleteRoute(conn, V, 'c-ten'), 1, 'V deleted only V\'s own row');
  assert.equal(route.getRoute(conn, U, 'c-ten').tokenLimit, 10);
});

test('quit-archive purge removes the route, is idempotent, and the tombstone replay does too', () => {
  put('c-purge', { provider: 'anthropic', model: 'a', tokenLimit: 10 });
  assert.deepEqual(lc.listWorkingState(U).sessions.filter((s) => s.chatSessionId === 'c-purge').length, 1, 'a route-only chat is working state');
  const first = lc.purgeWorkingState(U, ['c-purge']);
  assert.equal(first.purged, 1);
  assert.equal(route.getRoute(conn, U, 'c-purge'), null);
  assert.equal(lc.purgeWorkingState(U, ['c-purge']).purged, 0);

  put('c-replay', { tokenLimit: 10 });
  lc.enqueueSessionPurge(U, 'c-replay', 'user_delete');
  replaySessionPurges(U, { now: Date.now(), deleteTranscripts: () => {} });
  assert.equal(route.getRoute(conn, U, 'c-replay'), null, 'delete-everywhere replay removes the route');
});

test('account delete removes routes and learned limits', () => {
  const W = mk('cr3');
  put('c-del', { tokenLimit: 10 }, {}, W);
  conn.prepare("INSERT INTO provider_learned_limits (user_id, provider, model, rpm) VALUES (?, 'p', 'm', 5)").run(W);
  db.deleteUserCascade(W);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM chat_session_route WHERE user_id = ?').get(W).n, 0);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM provider_learned_limits WHERE user_id = ?').get(W).n, 0);
});

test('history events queue, list per user and chat, and never throw when the store is down', async () => {
  const agentDb = await import('../kb/agent-db.mjs');
  assert.equal(route.recordRouteEvent(U, 'c-hist', { kind: 'bogus' }), false);
  assert.ok(route.recordRouteEvent(U, 'c-hist', { kind: 'switch', fromProvider: 'anthropic', fromModel: 'a', toProvider: 'custom:cat-groq', toModel: 'g', reason: 'user', coldPrefillTokens: 1234 }));
  route.recordRouteEvent(V, 'c-hist', { kind: 'switch', reason: 'user' });
  const h = route.listRouteEvents(U, 'c-hist');
  assert.equal(h.degraded, false);
  assert.equal(h.events.length, 1, 'V\'s event is not U\'s');
  assert.equal(h.events[0].toModel, 'g');
  assert.equal(h.events[0].coldPrefillTokens, 1234);
  void agentDb;
});

test('seedRouteIfMissing: creates from a seed, only raises an existing row, ignores junk, is per user', () => {
  assert.equal(route.seedRouteIfMissing(conn, U, 's-none', null), null);
  assert.equal(route.seedRouteIfMissing(conn, U, 's-none', { tokenLimit: -1, tokensUsed: 'x' }), null, 'nothing usable in the seed: no row');
  const made = route.seedRouteIfMissing(conn, U, 's-1', { tokenLimit: 500, tokensUsed: 120, provider: 'anthropic', model: 'm' });
  assert.deepEqual([made.tokenLimit, made.used.billable, made.pinned], [500, 120, true]);
  const again = route.seedRouteIfMissing(conn, U, 's-1', { tokenLimit: 9, tokensUsed: 10, provider: 'custom:x', model: 'y' });
  assert.deepEqual([again.tokenLimit, again.used.billable, again.provider], [500, 120, 'anthropic'], 'an existing row is not lowered or re-pinned');
  assert.equal(route.seedRouteIfMissing(conn, U, 's-1', { tokensUsed: 300 }).used.billable, 300, 'but its used-count can be raised');
  assert.equal(route.getRoute(conn, V, 's-1'), null, 'another user never sees it');
  const noPin = route.seedRouteIfMissing(conn, U, 's-2', { tokenLimit: 5, provider: 'openai', model: 'x' });
  assert.equal(noPin.pinned, false, 'a provider the router cannot run is not pinned');
});

test('the route count per user is bounded and the oldest rows make room', () => {
  const W = mk('cr4');
  const ins = conn.prepare("INSERT INTO chat_session_route (user_id, chat_session_id, provider, model, updated_at) VALUES (?, ?, '', '', ?)");
  conn.transaction(() => { for (let i = 0; i < route.MAX_ROUTES_PER_USER; i += 1) ins.run(W, `c-${i}`, `2020-01-01T00:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`); })();
  route.commitTurnUsage(conn, W, 'fresh-one', { inputTokens: 1 }, { provider: 'anthropic', model: 'm' });
  const n = conn.prepare('SELECT COUNT(*) AS n FROM chat_session_route WHERE user_id = ?').get(W).n;
  assert.ok(n <= route.MAX_ROUTES_PER_USER);
  assert.ok(route.getRoute(conn, W, 'fresh-one'));
  assert.equal(route.getRoute(conn, W, 'c-0'), null, 'the oldest went first');
});

test('commitTurnUsage records the engine of the last turn and keeps it when a turn names no provider', () => {
  route.commitTurnUsage(conn, U, 'eng-1', { inputTokens: 1 }, { provider: 'custom:cat-groq', model: 'g' });
  assert.equal(route.getRoute(conn, U, 'eng-1').lastEngine, 'adapter');
  route.commitTurnUsage(conn, U, 'eng-1', { inputTokens: 1 }, {});
  assert.equal(route.getRoute(conn, U, 'eng-1').lastEngine, 'adapter', 'a classifier-only commit changes nothing');
  route.commitTurnUsage(conn, U, 'eng-1', { inputTokens: 1 }, { provider: 'anthropic', model: 'm' });
  assert.equal(route.getRoute(conn, U, 'eng-1').lastEngine, 'claude');
});
