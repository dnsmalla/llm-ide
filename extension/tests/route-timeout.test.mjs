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

test('routeTimeoutMs returns a budget for listed POST routes (query stripped)', () => {
  assert.equal(routeTimeoutMs('/kb/ingest', 'POST'), 60_000);
  assert.equal(routeTimeoutMs('/kb/summarize?x=1', 'POST'), 240_000);
});

test('routeTimeoutMs applies the /kb/delete budget on both DELETE and POST (the router accepts both verbs)', () => {
  assert.equal(routeTimeoutMs('/kb/delete', 'POST'), 30_000);
  assert.equal(routeTimeoutMs('/kb/delete', 'DELETE'), 30_000);
  assert.equal(routeTimeoutMs('/kb/ingest', 'DELETE'), null, 'other routes remain POST-only');
});

test('routeTimeoutMs returns null for GETs, unlisted and streaming routes', () => {
  assert.equal(routeTimeoutMs('/kb/ingest', 'GET'), null);
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
  const never = () => new Promise(() => { /* never settles */ });
  const out = await withRouteTimeout({ url: '/kb/ingest', log: { error() {}, warn() {} } }, res, 50, never);
  assert.equal(out, true, 'reported handled');
  assert.equal(res.statusCode, 504);
  assert.match(res._body, /TIMEOUT/);
});

test('withRouteTimeout does not double-write if the handler already responded', async () => {
  const res = makeRes();
  // Handler writes headers then hangs — the timeout path must no-op.
  const fn = () => { res.writeHead(200, {}); res.end('{"ok":true}'); return new Promise(() => {}); };
  const out = await withRouteTimeout({ url: '/kb/ingest', log: { error() {}, warn() {} } }, res, 50, fn);
  assert.equal(out, true);
  assert.equal(res.statusCode, 200, 'original status preserved');
});
