// GET /kb/os/state (the System view aggregate): tenancy, token math, window
// filter, kit mapping from the feature set, empty-DB shape and timing. A temp
// DB per run; no server is spawned and no port is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_os-state-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

let _db;
async function freshDb() {
  if (!_db) _db = await import('../kb/db.mjs');
  _db.closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok */ }
  }
}

let seq = 0;
async function setup() {
  await freshDb();
  const { getDb } = await import('../kb/db.mjs');
  const { registerUser } = await import('../server/users.mjs');
  const db = getDb();
  const mk = () => registerUser(db, {
    email: `os-${process.pid}-${++seq}@example.com`, password: 'pw-12345678',
  }).id;
  return { db, userA: mk(), userB: mk() };
}

// A fake http response that captures what sendJSON writes.
function fakeRes() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(text) { this.body = text ? JSON.parse(text) : null; this.headersSent = true; },
  };
}

async function getState(userId, query = '') {
  const { handleOsRoutes } = await import('../routes/os.mjs');
  const res = fakeRes();
  const handled = await handleOsRoutes(
    { method: 'GET' },
    res,
    { userId, url: `/kb/os/state${query}` },
  );
  assert.equal(handled, true);
  return res;
}

function insertUsage(db, userId, row) {
  db.prepare(
    `INSERT INTO usage_ledger (user_id, provider, model, source, endpoint, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, runs, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now','localtime')))`,
  ).run(
    userId, row.provider, row.model, row.source, row.endpoint,
    row.input ?? null, row.output ?? null, row.cacheRead ?? null, row.cacheWrite ?? null,
    row.runs ?? 1, row.ts ?? null,
  );
}

// --- kit mapping (pure) ------------------------------------------------------

test('kitStatus — null features enables every kit; a Set disables only the kits it does not cover', async () => {
  const { kitStatus } = await import('../kb/os-state.mjs');
  const all = Object.fromEntries(kitStatus(null).map((k) => [k.id, k.enabled]));
  assert.ok(Object.values(all).every((v) => v === true));

  const some = new Set(['agent_chat', 'code_graph_3d', 'file_explorer']); // no terminal
  const off = Object.fromEntries(kitStatus(some).map((k) => [k.id, k.enabled]));
  assert.equal(off['graph-kit'], true);
  assert.equal(off['workspace-kit'], false, 'workspace-kit needs file_explorer AND terminal');
  assert.equal(off['automation-kit'], false);
  assert.equal(off['sync-kit'], false);
  assert.equal(off['docs-kit'], false);
  assert.equal(off['work-kit'], false);
  assert.equal(off['os-kit'], true, 'os-kit has no feature key');
  assert.equal(off['agent-kit'], true, 'agent_chat is always on');
});

test('kitStatus — requires lists the feature keys each kit depends on', async () => {
  const { kitStatus } = await import('../kb/os-state.mjs');
  const ws = kitStatus(null).find((k) => k.id === 'workspace-kit');
  assert.deepEqual(ws.requires, ['file_explorer', 'terminal']);
});

// --- route ---------------------------------------------------------------------

test('empty DB — the response has the full shape with zero counts', async () => {
  const { userA } = await setup();
  const { configureOsRoutes } = await import('../routes/os.mjs');
  configureOsRoutes({
    apiVersion: 79,
    health: async () => ({ status: 'ok', checks: { db: true, claude: true, skills: true } }),
  });
  const res = await getState(userA);
  assert.equal(res.statusCode, 200);
  const s = res.body;
  assert.equal(s.apiVersion, 79);
  assert.equal(typeof s.generatedAt, 'string');
  assert.equal(s.system.status, 'ok');
  assert.deepEqual(s.system.checks, { db: true, claude: true, skills: true });
  assert.deepEqual(s.running, { chatTurns: [], meetingAgentRuns: [], liveSessions: [] });
  assert.deepEqual(s.activity, { unread: 0, items: [] });
  assert.equal(s.tokens.window, 'day');
  assert.equal(s.tokens.windowHours, 24);
  assert.deepEqual(s.tokens.totals, { calls: 0, runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billable: 0 });
  assert.deepEqual(s.tokens.byModel, []);
  assert.equal(s.knowledge.sources.total, 0);
  assert.equal(s.knowledge.pendingReviews, 0);
  assert.equal(s.knowledge.outcomes.total, 0);
  assert.deepEqual(s.knowledge.projectMemory, []);
  assert.deepEqual(s.macOnly, { loop: 'on this Mac', autoTasks: 'on this Mac' });
  assert.equal(s.tokens.turnComposition.turns, 0);
  assert.equal(s.tokens.turnComposition.avgFirstCallPromptTokens, null);
  assert.ok(s.system.kits.some((k) => k.id === 'os-kit'));
});

test('token math — billable = input + output + 0.1 cache read + 1.25 cache write; NULLs count as 0', async () => {
  const { db, userA } = await setup();
  insertUsage(db, userA, { provider: 'anthropic', model: 'm-1', source: 'api', endpoint: '/agent/v2/stream',
    input: 1000, output: 200, cacheRead: 4000, cacheWrite: 100 });
  insertUsage(db, userA, { provider: 'anthropic', model: 'm-1', source: 'cli', endpoint: '/kb/loop/agent-run',
    runs: 2 }); // CLI run, no token counts
  const s = (await getState(userA)).body;
  assert.equal(s.tokens.totals.calls, 2);
  assert.equal(s.tokens.totals.runs, 3);
  assert.equal(s.tokens.totals.input, 1000);
  assert.equal(s.tokens.totals.billable, 1000 + 200 + 400 + 125);
  const m1 = s.tokens.byModel.find((m) => m.model === 'm-1');
  assert.equal(m1.billable, 1725);
  const cli = s.tokens.bySource.find((x) => x.source === 'cli');
  assert.equal(cli.calls, 1);
  assert.equal(cli.billable, 0);
  assert.equal(s.tokens.bySource[0].source, 'api', 'sorted by billable, largest first');
  assert.ok(s.tokens.byEndpoint.some((e) => e.endpoint === '/agent/v2/stream'));
});

test('window filter — day excludes a row older than 24 h; week includes it', async () => {
  const { db, userA } = await setup();
  insertUsage(db, userA, { provider: 'anthropic', model: 'm-1', source: 'api', endpoint: '/a', input: 10, output: 0 });
  insertUsage(db, userA, { provider: 'anthropic', model: 'm-1', source: 'api', endpoint: '/a', input: 100, output: 0,
    ts: null });
  db.prepare(`UPDATE usage_ledger SET ts = datetime('now','localtime','-3 days') WHERE input_tokens = 100`).run();
  const day = (await getState(userA, '?window=day')).body.tokens;
  const week = (await getState(userA, '?window=week')).body.tokens;
  assert.equal(day.window, 'day');
  assert.equal(day.totals.input, 10);
  assert.equal(week.window, 'week');
  assert.equal(week.windowHours, 168);
  assert.equal(week.totals.input, 110);
});

test('window validation — an unknown window is a 400 VALIDATION_FAILED', async () => {
  const { userA } = await setup();
  const res = await getState(userA, '?window=year');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
});

test('tenancy — user B sees none of user A’s usage, activity, memory or sources', async () => {
  const { db, userA, userB } = await setup();
  const { recordActivity } = await import('../kb/activity.mjs');
  const { recordMemoryLedger } = await import('../kb/memory-ledger.mjs');
  insertUsage(db, userA, { provider: 'anthropic', model: 'm-A', source: 'api', endpoint: '/a', input: 500, output: 0 });
  recordActivity(db, { userId: userA, kind: 'meeting_added', title: 'A meeting' });
  recordMemoryLedger(userA, '/example/repo-a', { confirmed: ['[decision] use sqlite'] });
  db.prepare(`INSERT INTO sources (kind, ref, chunk_idx, title, body, user_id) VALUES ('code', 'a.mjs', 0, 'A', 'x', ?)`)
    .run(userA);
  recordActivity(db, { userId: userB, kind: 'meeting_added', title: 'B meeting' });

  const b = (await getState(userB)).body;
  assert.equal(b.tokens.totals.input, 0);
  assert.equal(b.activity.items.length, 1);
  assert.equal(b.activity.items[0].title, 'B meeting');
  assert.deepEqual(b.knowledge.projectMemory, []);
  assert.equal(b.knowledge.sources.total, 0);

  const a = (await getState(userA)).body;
  assert.equal(a.tokens.totals.input, 500);
  assert.equal(a.knowledge.projectMemory.length, 1);
  assert.equal(a.knowledge.projectMemory[0].repoRoot, '/example/repo-a');
  assert.equal(a.knowledge.projectMemory[0].facts, 1);
  assert.equal(a.knowledge.sources.total, 1);
  assert.equal(a.activity.items[0].title, 'A meeting');
});

test('activity — the limit parameter bounds the feed and the unread count is reported', async () => {
  const { db, userA } = await setup();
  const { recordActivity } = await import('../kb/activity.mjs');
  for (let i = 0; i < 40; i += 1) recordActivity(db, { userId: userA, kind: 'meeting_added', title: `m${i}` });
  const def = (await getState(userA)).body.activity;
  assert.equal(def.items.length, 30);
  assert.equal(def.unread, 40);
  const small = (await getState(userA, '?activity=5')).body.activity;
  assert.equal(small.items.length, 5);
});

test('knowledge — code-graph freshness, pending reviews and outcome counts are per user', async () => {
  const { db, userA } = await setup();
  db.prepare(`INSERT INTO code_graph_meta (user_id, repo_id, commit_sha, generated_at) VALUES (?, 'example-repo', 'abc123', '2026-10-01')`)
    .run(userA);
  db.prepare(`INSERT INTO review_items (id, kind, title, payload, status, user_id) VALUES ('r1', 'dispatch', 't', '{}', 'pending', ?)`)
    .run(userA);
  db.prepare(`INSERT INTO review_items (id, kind, title, payload, status, user_id) VALUES ('r2', 'dispatch', 't', '{}', 'approved', ?)`)
    .run(userA);
  const k = (await getState(userA)).body.knowledge;
  assert.equal(k.pendingReviews, 1);
  assert.deepEqual(k.codeGraph, [{ repoId: 'example-repo', commitSha: 'abc123', generatedAt: '2026-10-01' }]);
  assert.equal(k.outcomes.total, 0);
});

test('timing — a few hundred rows are answered in under 50 ms', async () => {
  const { db, userA } = await setup();
  const { recordActivity } = await import('../kb/activity.mjs');
  db.transaction(() => {
    for (let i = 0; i < 400; i += 1) {
      insertUsage(db, userA, { provider: 'anthropic', model: `m-${i % 4}`, source: 'api',
        endpoint: `/e/${i % 5}`, input: 100 + i, output: 10, cacheRead: 50, cacheWrite: 5 });
    }
  })();
  for (let i = 0; i < 200; i += 1) recordActivity(db, { userId: userA, kind: 'meeting_added', title: `t${i}` });
  await getState(userA); // warm the statement cache
  const t0 = performance.now();
  const res = await getState(userA);
  const ms = performance.now() - t0;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tokens.totals.calls, 400);
  assert.ok(ms < 50, `GET /kb/os/state took ${ms.toFixed(1)} ms`);
});
