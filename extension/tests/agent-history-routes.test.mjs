// The agent-history routes (Stage 1c, plan section 3.1): storage report,
// retention settings, clear with a signed preview, compact. Per-user isolation
// and the previewId checks are the point of these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-history-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* first run */ } }

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId }, _chunks: chunks,
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
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}

const db = await import('../kb/db.mjs');
const agent = await import('../kb/agent-db.mjs');
const store = await import('../kb/agent-store.mjs');
const api = await import('../kb/agent-history-api.mjs');
const { handleKB } = await import('../routes/router.mjs');
const { registerUser } = await import('../server/users.mjs');
const { config } = await import('../core/config.mjs');

const agentFiles = [config.agentDbPath, `${config.agentDbPath}-wal`, `${config.agentDbPath}-shm`];
function freshAgent() {
  agent.closeAgentDb();
  for (const f of agentFiles) fs.rmSync(f, { force: true });
  const handle = agent.getAgentDb();
  assert.ok(handle);
  return handle;
}
const count = (handle, sql, ...a) => handle.prepare(sql).get(...a).n;
const user = (tag) => registerUser(db.getDb(), { email: `ah-${tag}-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: tag }).id;

// Seed: A has one recent run with 2 tool events, and one run 40 days old with 1
// tool event. B has one recent run. Totals: A = 2 runs + 3 events = 5 rows.
function seed(a, b) {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  store.openRun(a, { runId: 'a-new', source: 'chat', engine: 'v2' });
  store.enqueueRunClose(a, 'a-new', { status: 'ok', inputTokens: 5 });
  store.enqueueToolEvents(a, 'a-new', { engine: 'v2', events: [{ tool: 'Read', resultChars: 1 }, { tool: 'Grep', resultChars: 2 }] });
  store.openRun(a, { runId: 'a-old', source: 'chat', engine: 'v2' }, { now: old });
  store.enqueueRunClose(a, 'a-old', { status: 'ok' });
  store.enqueueToolEvents(a, 'a-old', { engine: 'v2', day: '2026-09-01', events: [{ tool: 'Read', resultChars: 3 }] });
  store.openRun(b, { runId: 'b-new', source: 'chat', engine: 'v2' });
  store.enqueueRunClose(b, 'b-new', { status: 'ok' });
  agent.flushAgentQueue();
}

async function call(method, url, body, userId) {
  const res = makeRes();
  const req = makeReq({ method, url, body, userId });
  const handled = await handleKB(req, res);
  assert.equal(handled, true, `${method} ${url} is routed`);
  return res;
}

test('GET /kb/storage: the agent-history group counts only the caller\'s rows', async () => {
  freshAgent();
  const a = user('a1');
  const b = user('b1');
  seed(a, b);
  const res = await call('GET', '/kb/storage', null, a);
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  const agentGroup = body.groups.find((g) => g.key === 'agent_history');
  assert.equal(agentGroup.rows, 5, 'A: 2 runs and 3 tool events, not B\'s row');
  assert.deepEqual(agentGroup.actions, ['clear', 'compact']);
  assert.equal(body.groups.find((g) => g.key === 'meetings').actions.length, 0, 'main-DB groups have no actions');
  assert.equal(body.agentHistory.rawRows, 5);
  assert.ok(Array.isArray(body.groups) && body.groups.length === 5);
  const resB = (await call('GET', '/kb/storage', null, b)).json();
  assert.equal(resB.groups.find((g) => g.key === 'agent_history').rows, 1, 'B sees only B\'s row');
});

test('GET /kb/agent-history/settings reads the caller\'s retention, with the 7..365 bounds', async () => {
  freshAgent();
  const a = user('s1');
  const res = await call('GET', '/kb/agent-history/settings', null, a);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.retentionDays, 30);
  assert.equal(body.min, 7);
  assert.equal(body.max, 365);
});

test('PUT /kb/agent-history/settings clamps to 7..365 and is per user', async () => {
  freshAgent();
  const a = user('s2');
  const b = user('s3');
  const high = await call('PUT', '/kb/agent-history/settings', { retentionDays: 1000 }, a);
  assert.equal(high.statusCode, 200, high._body);
  assert.equal(high.json().retentionDays, 365);
  const low = await call('PUT', '/kb/agent-history/settings', { retentionDays: 2 }, a);
  assert.equal(low.json().retentionDays, 7);
  assert.equal((await call('GET', '/kb/agent-history/settings', null, b)).json().retentionDays, 30, 'B keeps the default');
  const bad = await call('PUT', '/kb/agent-history/settings', { retentionDays: 'thirty' }, a);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, 'VALIDATION_FAILED');
});

test('POST /kb/agent-history/clear dry run returns the counts and a signed previewId', async () => {
  freshAgent();
  const a = user('c1');
  seed(a, user('c2'));
  const res = await call('POST', '/kb/agent-history/clear', { scope: 'raw', beforeDays: 30, dryRun: true }, a);
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.wouldDelete.agent_runs, 1, 'only the 40-day-old run is older than 30 days');
  assert.equal(body.wouldDelete.agent_tool_events, 1);
  assert.equal(typeof body.previewId, 'string');
  assert.ok(body.previewId.includes('.'));
  assert.ok(body.expiresAt);
  // A dry run deletes nothing.
  assert.equal(count(agent.getAgentDb(), 'SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ?', a), 2);
});

test('a real clear with the matching previewId deletes exactly the previewed rows, and nothing of another user', async () => {
  freshAgent();
  const a = user('c3');
  const b = user('c4');
  seed(a, b);
  const handle = agent.getAgentDb();
  const preview = (await call('POST', '/kb/agent-history/clear', { scope: 'raw', beforeDays: 30, dryRun: true }, a)).json();
  const res = await call('POST', '/kb/agent-history/clear', { scope: 'raw', beforeDays: 30, dryRun: false, previewId: preview.previewId }, a);
  assert.equal(res.statusCode, 200, res._body);
  assert.equal(res.json().deleted.agent_runs, 1);
  assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ?', a), 1, 'A keeps the recent run');
  assert.equal(count(handle, 'SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ?', b), 1, 'B is untouched');
});

test('a real clear without a previewId is refused', async () => {
  freshAgent();
  const a = user('c5');
  const res = await call('POST', '/kb/agent-history/clear', { scope: 'raw', dryRun: false }, a);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'PREVIEW_REQUIRED');
});

test('a previewId is refused for another user, another scope, another cutoff, or a tampered token', async () => {
  freshAgent();
  const a = user('c6');
  const b = user('c7');
  seed(a, b);
  const preview = (await call('POST', '/kb/agent-history/clear', { scope: 'raw', beforeDays: 30, dryRun: true }, a)).json();
  const cases = [
    ['another user', b, { scope: 'raw', beforeDays: 30, dryRun: false, previewId: preview.previewId }],
    ['another scope', a, { scope: 'all', beforeDays: 30, dryRun: false, previewId: preview.previewId }],
    ['another cutoff', a, { scope: 'raw', beforeDays: 31, dryRun: false, previewId: preview.previewId }],
    ['a tampered token', a, { scope: 'raw', beforeDays: 30, dryRun: false, previewId: `${preview.previewId.slice(0, -2)}xx` }],
  ];
  for (const [label, who, body] of cases) {
    const res = await call('POST', '/kb/agent-history/clear', body, who);
    assert.equal(res.statusCode, 400, `${label} is refused`);
    assert.equal(res.json().error.code, 'PREVIEW_INVALID', label);
  }
  // Nothing was deleted by the refused attempts.
  assert.equal(count(agent.getAgentDb(), 'SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ?', a), 2);
});

test('a real clear refuses with preview_stale when the rows moved since the preview', async () => {
  freshAgent();
  const a = user('c8');
  seed(a, user('c9'));
  const preview = (await call('POST', '/kb/agent-history/clear', { scope: 'raw', beforeDays: 30, dryRun: true }, a)).json();
  // A new old run appears after the preview.
  store.openRun(a, { runId: 'a-late', source: 'chat', engine: 'v2' }, { now: new Date(Date.now() - 41 * 24 * 60 * 60 * 1000) });
  store.enqueueRunClose(a, 'a-late', { status: 'ok' });
  agent.flushAgentQueue();
  const res = await call('POST', '/kb/agent-history/clear', { scope: 'raw', beforeDays: 30, dryRun: false, previewId: preview.previewId }, a);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'preview_stale');
  assert.equal(count(agent.getAgentDb(), 'SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND run_id = ?', a, 'a-old'), 1, 'nothing was deleted');
});

test('an expired preview is refused, and the preview module reports the reason', () => {
  const a = 'u-expiry';
  const issued = api.issuePreview(a, { scope: 'raw', beforeDays: 30, counts: { agent_runs: 1 }, now: Date.now() - 10 * 60 * 1000 });
  const checked = api.checkPreview(a, issued.previewId, { scope: 'raw', beforeDays: 30 });
  assert.deepEqual(checked, { ok: false, reason: 'expired' });
  const fresh = api.issuePreview(a, { scope: 'raw', beforeDays: 30, counts: { agent_runs: 1 } });
  assert.deepEqual(api.checkPreview(a, fresh.previewId, { scope: 'raw', beforeDays: 30 }).counts, { agent_runs: 1 });
});

test('POST /kb/agent-history/clear validates scope and beforeDays', async () => {
  freshAgent();
  const a = user('c10');
  assert.equal((await call('POST', '/kb/agent-history/clear', { scope: 'everything' }, a)).statusCode, 400);
  assert.equal((await call('POST', '/kb/agent-history/clear', { scope: 'raw', beforeDays: -1 }, a)).statusCode, 400);
});

test('POST /kb/agent-history/compact runs when nothing is in flight', async () => {
  freshAgent();
  const a = user('p1');
  seed(a, user('p2'));
  const res = await call('POST', '/kb/agent-history/compact', {}, a);
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'incremental');
});

test('POST /kb/agent-history/compact answers 409 busy while a meeting-agent run is attached', async () => {
  freshAgent();
  const a = user('p3');
  const liveSessions = await import('../agents/live-sessions.mjs');
  const meetingAgent = await import('../agents/meeting-agent.mjs');
  liveSessions.appendCaptions(a, 'sess-busy', [{ speaker: 'Alice', text: 'hi', ts: Date.now(), source: 'extension-cc' }]);
  await meetingAgent.dispatchAgent({ userId: a, sessionId: 'sess-busy' });
  const res = await call('POST', '/kb/agent-history/compact', {}, a);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, 'busy');
  await meetingAgent.stopAgent({ userId: a, sessionId: 'sess-busy' });
});
