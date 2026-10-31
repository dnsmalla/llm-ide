// The only way the core talks to Google. Every request goes through the pinned fetch (server/pinned-fetch.mjs: one
// DNS resolution, every address classified, the socket dials the checked one), restricted to a fixed host
// allowlist over https:443 without userinfo. Redirects are followed by hand (3 hops, each hop re-validated and
// re-pinned, the bearer dropped on an origin change; the Box rule). Bodies are read with a hard streaming byte cap,
// not only content-length. Errors carry a stable `code`, never a token or a response body.
//
// The core NEVER fetches a URL it found in content (a message, event or file field): callers build every URL from a
// fixed base plus ids, and the allowlist is the backstop if one ever does not.
//
// Tests: `_setGoogleFetchForTests` installs the fixture transport. With NODE_ENV=test and no transport installed the
// call throws GOOGLE_TEST_TRIPWIRE instead of reaching the network, so a test that forgot to stub can never touch a
// real Google host.
import { makePinnedFetch } from '../../server/pinned-fetch.mjs';
import { GOOGLE_HOSTS } from './google-scopes.mjs';

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const DEADLINE_MS = 30_000;
const MAX_RETRIES = 3;

let testTransport = null;
/** Test seam (NODE_ENV=test only). `fn(url, init)` answers like fetch. Pass null to remove. */
export function _setGoogleFetchForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setGoogleFetchForTests is test-only');
  testTransport = fn;
}

let sleepFn = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
/** Test seam (NODE_ENV=test only): replace the backoff sleep. Pass null to restore. */
export function _setGoogleSleepForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setGoogleSleepForTests is test-only');
  sleepFn = fn || ((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
}

export class GoogleApiError extends Error {
  /** @param {string} code stable machine code  @param {string} message safe text  @param {{status?: number, reason?: string, retryAfterMs?: number|null}} [x] */
  constructor(code, message, x = {}) {
    super(message);
    this.name = 'GoogleApiError';
    this.code = code;
    this.status = x.status ?? null;
    this.reason = x.reason ?? null;
    this.retryAfterMs = x.retryAfterMs ?? null;
  }
}

/** https, port 443, no userinfo, host in the allowlist. */
export function isAllowedGoogleUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  return GOOGLE_HOSTS.includes(url.hostname.toLowerCase());
}

function transport() {
  if (testTransport) return testTransport;
  if (process.env.NODE_ENV === 'test') throw new GoogleApiError('GOOGLE_TEST_TRIPWIRE', 'a test reached the Google transport without a fixture transport installed');
  return makePinnedFetch();
}

const refuse = (msg) => new GoogleApiError('GOOGLE_FETCH_REFUSED', `Google fetch refused: ${msg}`);

async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) { try { await res.body?.cancel?.(); } catch { /* ignore */ } throw refuse(`response larger than ${max} bytes`); }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw refuse(`response larger than ${max} bytes`);
    return t;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw refuse(`response larger than ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfterMs(res) {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs, 120) * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, Math.min(when - Date.now(), 120_000)) : null;
}

/**
 * One request, no retry. Resolves `{ status, ok, headers, text }` with the body already read under the cap.
 * @param {string} url  @param {{ method?: string, token?: string|null, headers?: Record<string,string>, form?: Record<string,string>,
 *   json?: unknown, maxBytes?: number, signal?: AbortSignal }} [o]
 */
export async function googleOnce(url, { method = 'GET', token = null, headers = {}, form, json, maxBytes = MAX_JSON_BYTES, signal } = {}) {
  const doFetch = transport();
  const ctrl = signal ? null : new AbortController();
  const timer = ctrl ? setTimeout(() => ctrl.abort(), DEADLINE_MS) : null;
  try {
    let current = String(url);
    let bearer = token;
    for (let hop = 0; ; hop++) {
      if (!isAllowedGoogleUrl(current)) throw refuse(`host not allowed (${hop ? 'redirect' : 'request'})`);
      const h = { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers };
      let body;
      if (form) { body = new URLSearchParams(form); }
      else if (json !== undefined) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
      let res;
      try {
        res = await doFetch(current, { method: hop === 0 ? method : 'GET', headers: h, body: hop === 0 ? body : undefined, redirect: 'manual', signal: signal || ctrl.signal });
      } catch (e) {
        if (e instanceof GoogleApiError) throw e;
        if (e?.code === 'SSRF_BLOCKED') throw refuse('address refused');
        if (e?.name === 'AbortError') throw new GoogleApiError('GOOGLE_TIMEOUT', 'Google request timed out');
        throw new GoogleApiError('GOOGLE_NETWORK', 'Could not reach Google');
      }
      if (REDIRECT_STATUSES.has(res.status)) {
        const loc = res.headers?.get?.('location');
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        if (!loc) throw refuse('redirect without a location');
        if (hop >= MAX_REDIRECTS) throw refuse('too many redirects');
        const next = new URL(loc, current).toString();
        if (new URL(next).origin !== new URL(current).origin) bearer = null;
        current = next;
        continue;
      }
      const text = await readCapped(res, maxBytes);
      return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text, retryAfterMs: retryAfterMs(res) };
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Parse a capped body as JSON; a malformed body is an error with a stable code, never the body text. */
export function parseJsonBody(text) {
  try { return text ? JSON.parse(text) : {}; } catch { throw new GoogleApiError('GOOGLE_BAD_JSON', 'Google answered with a malformed response'); }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'backendError']);
function errorInfo(text) {
  try {
    const e = JSON.parse(text)?.error;
    if (e && typeof e === 'object') return { reason: e.errors?.[0]?.reason || e.status || null, message: typeof e.message === 'string' ? e.message : '' };
    if (typeof e === 'string') return { reason: e, message: '' };
  } catch { /* not JSON */ }
  return { reason: null, message: '' };
}

/**
 * An authenticated API call with the retry rules: one token refresh on 401, 429 / 403 rate-limit / 5xx backoff with
 * jitter honouring Retry-After (MAX_RETRIES attempts), nothing retried on other 4xx. Resolves the parsed JSON, or
 * with `raw: true` the text. Throws GoogleApiError with `status` and `reason` (Google's error reason, not its text).
 * @param {{ ensure: () => Promise<string>, refresh: () => Promise<string> }} session
 * @param {string} url  @param {{ method?: string, headers?: object, json?: unknown, maxBytes?: number, raw?: boolean,
 *   sleepImpl?: (ms: number) => Promise<void>, allow404?: boolean }} [o]
 */
export async function googleCall(session, url, { method = 'GET', headers, json, maxBytes, raw = false, sleepImpl = (ms) => sleepFn(ms), allow404 = false } = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await session.ensure();
    const r = await googleOnce(url, { method, token, headers, json, maxBytes: maxBytes ?? (raw ? MAX_TEXT_BYTES : MAX_JSON_BYTES) });
    if (r.ok) return raw ? r.text : parseJsonBody(r.text);
    if (r.status === 401 && !refreshed) { refreshed = true; await session.refresh(); continue; }
    const { reason } = errorInfo(r.text);
    const rateLimited = r.status === 429 || (r.status === 403 && RATE_REASONS.has(reason)) || r.status >= 500;
    if (rateLimited && attempt < MAX_RETRIES) {
      const base = r.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 16_000);
      await sleepImpl(base + Math.floor(Math.random() * 250));
      continue;
    }
    if (r.status === 404 && allow404) return null;
    const code = r.status === 401 ? 'GOOGLE_UNAUTHORIZED' : r.status === 403 ? (rateLimited ? 'GOOGLE_RATE_LIMITED' : 'GOOGLE_FORBIDDEN')
      : r.status === 404 ? 'GOOGLE_NOT_FOUND' : r.status === 410 ? 'GOOGLE_GONE' : rateLimited ? 'GOOGLE_RATE_LIMITED' : 'GOOGLE_HTTP_ERROR';
    throw new GoogleApiError(code, `Google API answered ${r.status}${reason ? ` (${String(reason).slice(0, 60)})` : ''}`, { status: r.status, reason, retryAfterMs: r.retryAfterMs });
  }
}

/** Google API URL builder: fixed base plus encoded ids and params. Undefined/null params are dropped; arrays repeat. */
export function apiUrl(base, params = {}) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}
