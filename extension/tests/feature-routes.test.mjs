// Feature-owned route groups (routes/feature-routes.mjs). With a feature
// disabled (LLMIDE_FEATURES, mirroring the Mac build's feature set) its route
// module must never be imported — the point is a smaller, faster server — and
// its paths must answer a recognisable 404 so a client fails loudly instead of
// reading a generic "no such route".
//
// Order matters in this file: the agent_chat-only tests run first, while the
// module-load sentinel can still prove loop-agent was never imported; the
// all-features tests at the end then load everything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeModule from 'node:module';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
delete process.env.LLMIDE_FEATURES;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-feature-routes-'));
process.env.LLMIDE_DB_PATH = path.join(tmpDir, 'kb.db');

// Records every module URL this process loads. registerHooks is Node ≥ 22.15;
// on an older runtime the sentinel assertions are skipped (loadedGroups() still
// covers the table's own bookkeeping).
const loadedUrls = [];
const hasLoadHooks = typeof nodeModule.registerHooks === 'function';
if (hasLoadHooks) {
  nodeModule.registerHooks({ load(url, ctx, next) { loadedUrls.push(url); return next(url, ctx); } });
}
const wasLoaded = (suffix) => loadedUrls.some((u) => u.endsWith(suffix));

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleKB, initFeatureRoutes } = await import('../routes/router.mjs');
const {
  FEATURE_ROUTE_GROUPS, loadFeatureRoutes, featureDisabledFor, enabledEndpoints, loadedGroups,
} = await import('../routes/feature-routes.mjs');

process.on('exit', () => {
  try { db.closeDb(); } catch { /* already closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId }, headers: {},
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
    once() { return req; },
    off() { return req; },
    removeListener() { return req; },
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
    on() { return this; }, once() { return this; }, off() { return this; }, removeListener() { return this; },
  };
}
async function call(method, url, body, userId) {
  const res = makeRes();
  const handled = await handleKB(makeReq({ method, url, body, userId }), res);
  return { handled, status: res.statusCode, body: res._body ? JSON.parse(res._body) : null };
}

const CHAT_ONLY = new Set(['agent_chat']);
let userId;

test('setup: a user', () => {
  userId = users.registerUser(db.getDb(), {
    email: `features-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'f',
  }).id;
  assert.ok(userId);
});

test('featureDisabledFor maps a disabled group\'s paths to its feature key', () => {
  assert.equal(featureDisabledFor('/kb/loop/agent-run', CHAT_ONLY), 'auto_tasks');
  assert.equal(featureDisabledFor('/kb/issue-schedule?provider=github&repo=o/r', CHAT_ONLY), 'gantt_issues');
  assert.equal(featureDisabledFor('/kb/ingest-code-graph', CHAT_ONLY), 'code_graph_3d');
  assert.equal(featureDisabledFor('/kb/search', CHAT_ONLY), null, 'always-on route');
  assert.equal(featureDisabledFor('/kb/loop/agent-run', null), null, 'null = all features');
  assert.equal(featureDisabledFor('/kb/loop/agent-run', new Set(['agent_chat', 'auto_tasks'])), null);
});

test('loadFeatureRoutes resolves handlers only for enabled groups', async () => {
  const { handlers, disabledPrefixes } = await loadFeatureRoutes(CHAT_ONLY);
  assert.deepEqual(Object.keys(handlers), []);
  for (const group of Object.values(FEATURE_ROUTE_GROUPS)) {
    for (const prefix of group.prefixes) assert.ok(disabledPrefixes.includes(prefix), prefix);
  }
});

test('with only agent_chat, feature routes answer 404 feature_disabled', async () => {
  await initFeatureRoutes(CHAT_ONLY);
  const loop = await call('POST', '/kb/loop/agent-run', { message: 'x' }, userId);
  assert.equal(loop.status, 404);
  assert.deepEqual(loop.body, { error: 'feature_disabled', feature: 'auto_tasks' });

  const sched = await call('GET', '/kb/issue-schedule?provider=github&repo=o/r', null, userId);
  assert.equal(sched.status, 404);
  assert.deepEqual(sched.body, { error: 'feature_disabled', feature: 'gantt_issues' });

  const graph = await call('POST', '/kb/ingest-code-graph', { repoPath: '/x', graph: {} }, userId);
  assert.equal(graph.status, 404);
  assert.deepEqual(graph.body, { error: 'feature_disabled', feature: 'code_graph_3d' });
});

test('with only agent_chat, always-on routes are unaffected', async () => {
  const stats = await call('GET', '/kb/stats', null, userId);
  assert.equal(stats.status, 200);
  const unknown = await call('GET', '/kb/no-such-route', null, userId);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'NOT_FOUND', 'a plain unknown route keeps the old envelope');
});

test('with only agent_chat, the disabled route modules were never imported', { skip: !hasLoadHooks }, () => {
  assert.equal(wasLoaded('/routes/loop-agent.mjs'), false);
  assert.equal(wasLoaded('/llm_agent/sdk/loop-agent.mjs'), false);
  assert.equal(wasLoaded('/routes/issue-schedule.mjs'), false);
  assert.equal(wasLoaded('/routes/code-graph.mjs'), false);
  assert.equal(wasLoaded('/connectors/structure-graph.mjs'), false);
  assert.deepEqual(loadedGroups(), []);
});

test('enabledEndpoints drops a disabled group\'s endpoints and keeps the rest', () => {
  const all = ['/kb/search', '/kb/loop/agent-run', '/kb/issue-schedule', '/kb/ingest-code-graph', '/generate-doc'];
  assert.deepEqual(enabledEndpoints(all, CHAT_ONLY), ['/kb/search', '/generate-doc']);
  assert.deepEqual(enabledEndpoints(all, null), all);
});

test('with every feature (null), the feature routes behave exactly as before', async () => {
  await initFeatureRoutes(null);
  // Reaches the real loop-agent handler: its own validation answers, not a 404.
  const loop = await call('POST', '/kb/loop/agent-run', {}, userId);
  assert.equal(loop.status, 400);
  assert.equal(loop.body.error.code, 'VALIDATION_FAILED');

  const sched = await call('GET', '/kb/issue-schedule?provider=github&repo=o/r', null, userId);
  assert.equal(sched.status, 200);
  assert.deepEqual(sched.body.schedules, []);

  const graph = await call('POST', '/kb/ingest-code-graph', {}, userId);
  assert.equal(graph.status, 400);
  assert.equal(graph.body.error.code, 'VALIDATION_FAILED');

  assert.deepEqual(loadedGroups().sort(), Object.keys(FEATURE_ROUTE_GROUPS).sort());
  // The sentinel does see these dynamic imports — so its "never imported"
  // verdict above is real, not a hook that observes nothing.
  if (hasLoadHooks) {
    assert.ok(wasLoaded('/routes/loop-agent.mjs'));
    assert.ok(wasLoaded('/connectors/structure-graph.mjs'));
  }
});
