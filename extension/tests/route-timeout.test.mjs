// Tests for server/route-timeout.mjs — opt-in per-route handler budgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { routeTimeoutMs, withRouteTimeout } = await import('../server/route-timeout.mjs');

// Same res double as activity-routes.test.mjs.
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: '',
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
  };
}

test('routeTimeoutMs returns a budget for the short bounded POST routes (query stripped)', () => {
  assert.equal(routeTimeoutMs('/kb/dispatch', 'POST'), 60_000);
  assert.equal(routeTimeoutMs('/kb/providers/verify?x=1', 'POST'), 30_000);
});

test('routeTimeoutMs has NO budget for LLM generation routes', () => {
  // These carried 180 s–240 s budgets and were the last clock over AI work once
  // server.requestTimeout and the agent-loop deadline were removed. /kb/summarize
  // 504'd at 240 s on a long transcript, so the Mac summarizer threw away the
  // real AI summary and wrote its local fallback instead.
  for (const route of ['/kb/generate-plan', '/kb/analyze-risks', '/kb/summarize',
                       '/kb/conflict-questions', '/kb/generate-code']) {
    assert.equal(routeTimeoutMs(route, 'POST'), null, `${route} must have no wall-clock budget`);
  }
});

test('routeTimeoutMs has NO budget for routes that scale with the user\'s data', () => {
  // Both are bounded by their own input caps, not by a clock: how long indexing
  // takes is a function of how much the user asked to index.
  assert.equal(routeTimeoutMs('/kb/ingest', 'POST'), null);
  assert.equal(routeTimeoutMs('/kb/connect-box', 'POST'), null);
  // ingest-scip is bounded by loadScipIndex's own subprocess kill timer.
  assert.equal(routeTimeoutMs('/kb/ingest-scip', 'POST'), null);
});

test('routeTimeoutMs applies the /kb/delete budget on both DELETE and POST (the router accepts both verbs)', () => {
  assert.equal(routeTimeoutMs('/kb/delete', 'POST'), 30_000);
  assert.equal(routeTimeoutMs('/kb/delete', 'DELETE'), 30_000);
  assert.equal(routeTimeoutMs('/kb/dispatch', 'DELETE'), null, 'other routes remain POST-only');
});

test('routeTimeoutMs returns null for GETs, unlisted and streaming routes', () => {
  assert.equal(routeTimeoutMs('/kb/dispatch', 'GET'), null);
  assert.equal(routeTimeoutMs('/kb/live/abc/stream', 'GET'), null);
  assert.equal(routeTimeoutMs('/kb/live/abc/append', 'POST'), null);
  assert.equal(routeTimeoutMs('/code-assist', 'POST'), null);
  assert.equal(routeTimeoutMs('/kb/agent/dispatch', 'POST'), null);
});

test('withRouteTimeout returns the handler result when it settles in time', async () => {
  const res = makeRes();
  const out = await withRouteTimeout({ url: '/x' }, res, 1000, async () => 'done');
  assert.equal(out, 'done');
  assert.equal(res.ended, undefined, 'response untouched');
});

test('withRouteTimeout propagates a false handler result (dispatcher fall-through)', async () => {
  const res = makeRes();
  const out = await withRouteTimeout({ url: '/x' }, res, 1000, async () => false);
  assert.equal(out, false);
});

test('withRouteTimeout sends a 504 envelope when the handler exceeds the budget', async () => {
  const res = makeRes();
  // The budget timer inside withRouteTimeout is unref'd (so it can't keep the
  // server alive at shutdown), so the handler must hold the loop open with a
  // ref'd timer that outlives the budget; the timeout then wins the race.
  // Model the documented behavior: the abandoned handler settles afterwards —
  // await it so the test leaves nothing pending for node:test to flag.
  let slow;
  const handler = () => (slow = new Promise((resolve) => { setTimeout(resolve, 100); }));
  const out = await withRouteTimeout({ url: '/kb/ingest', log: { error() {}, warn() {} } }, res, 25, handler);
  assert.equal(out, true, 'reported handled');
  assert.equal(res.statusCode, 504);
  assert.match(res._body, /TIMEOUT/);
  await slow; // abandoned handler runs to completion after the 504
});

test('withRouteTimeout does not double-write if the handler already responded', async () => {
  const res = makeRes();
  // Handler writes headers then outlives its budget — the timeout path must no-op.
  let slow;
  const handler = () => { res.writeHead(200, {}); res.end('{"ok":true}'); return (slow = new Promise((resolve) => { setTimeout(resolve, 100); })); };
  const out = await withRouteTimeout({ url: '/kb/ingest', log: { error() {}, warn() {} } }, res, 25, handler);
  assert.equal(out, true);
  assert.equal(res.statusCode, 200, 'original status preserved');
  await slow;
});
