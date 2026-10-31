// Fixture transport for the Google connector tests. No test reaches a real Google host: the connector's fetch seam
// (connectors/google/google-fetch.mjs) is replaced by `makeTransport`, and `installTripwire` additionally makes any
// direct attempt to reach a *.google.com / *.googleapis.com host through fetch, http or https throw, so a code path
// that bypassed the seam fails the test instead of leaving the machine.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

const GOOGLE_RE = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|googleusercontent\.com)$/i;

export function installTripwire() {
  const hits = [];
  const orig = { fetch: globalThis.fetch, hreq: https.request, hget: https.get, req: http.request };
  const guardHost = (h) => { if (h && GOOGLE_RE.test(String(h).replace(/:\d+$/, ''))) { hits.push(String(h)); throw new Error(`TRIPWIRE: test reached real Google host ${h}`); } };
  globalThis.fetch = (input, init) => { try { guardHost(new URL(String(input?.url || input)).hostname); } catch (e) { if (/TRIPWIRE/.test(e.message)) throw e; } return orig.fetch(input, init); };
  const wrap = (fn) => function patched(...a) {
    const o = a[0];
    try { guardHost(typeof o === 'string' ? new URL(o).hostname : (o?.hostname || o?.host || (o instanceof URL ? o.hostname : ''))); } catch (e) { if (/TRIPWIRE/.test(e.message)) throw e; }
    return fn.apply(this, a);
  };
  https.request = wrap(orig.hreq); https.get = wrap(orig.hget); http.request = wrap(orig.req);
  return {
    hits,
    restore() { globalThis.fetch = orig.fetch; https.request = orig.hreq; https.get = orig.hget; http.request = orig.req; },
  };
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
export const jsonResponse = json;
export const textResponse = (status, text, headers = {}) => new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });

/**
 * A fetch stand-in. `routes` is an array of `{ match: (url: URL, init) => boolean, reply: (url, init, call) => Response | Promise<Response> }`
 * tried in order; an unmatched request is recorded and answered 599 (the test then asserts `unmatched` is empty).
 * Every call is recorded: `{ url, method, headers, body, host }`.
 */
export function makeTransport(routes = []) {
  const calls = [];
  const unmatched = [];
  const t = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = {};
    for (const [k, v] of new Headers(init.headers || {})) headers[k.toLowerCase()] = v;
    let body = init.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    const call = { url: url.toString(), method: init.method || 'GET', headers, body, host: url.hostname, path: url.pathname, query: url.searchParams };
    calls.push(call);
    for (const r of t.routes) if (r.match(url, init)) return r.reply(url, init, call);
    unmatched.push(call);
    return new Response('unmatched fixture request', { status: 599 });
  };
  t.routes = routes;
  t.calls = calls;
  t.unmatched = unmatched;
  t.on = (match, reply) => { t.routes.push({ match: typeof match === 'function' ? match : (u) => u.pathname === match, reply }); return t; };
  t.callsTo = (pathPart) => calls.filter((c) => c.path.includes(pathPart));
  return t;
}

/** An unsigned ID token as the token endpoint would return it (the connector reads claims, not the signature). */
export function makeIdToken({ sub, email, aud, nonce, iss = 'https://accounts.google.com', exp = Math.floor(Date.now() / 1000) + 3000 }) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'RS256', typ: 'JWT' })}.${b({ iss, aud, sub, email, nonce, exp })}.${crypto.randomBytes(8).toString('base64url')}`;
}

/** Read a fixture file under tests/fixtures/google. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'google');
export function fixture(rel) { return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8')); }
export function fixtureText(rel) { return fs.readFileSync(path.join(FIX, rel), 'utf8'); }
