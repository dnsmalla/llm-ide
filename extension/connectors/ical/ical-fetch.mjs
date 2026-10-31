// The only outbound path of the iCal feed connector. Spec: docs/spec/calendar-ical.md.
//
// The feed URL is a bearer secret (Google's "Secret address in iCal format"): it is validated here, held only in the
// vault, and never logged, audited, returned or put in an error. Every error message passes redactIcalSecrets.
//
// Rules: https only, port 443, no userinfo, host in the allowlist (calendar.google.com plus exact hosts named in the
// operator env LLMIDE_ICAL_HOSTS; never a pattern, never an IP literal). The request goes through the pinned fetch
// (DNS resolved once, every address classified, no private-address opt-in). Redirects are followed by hand, at most 2
// hops, and only to the SAME host (re-validated each hop). The body is read under a streaming cap (5 MiB), the whole
// request has a 20 s deadline. Conditional GET with ETag / Last-Modified. 429 and 5xx back off and retry.
import { makePinnedFetch } from '../../server/pinned-fetch.mjs';

export const ICAL_FETCH_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, deadlineMs: 20_000, maxRedirects: 2, maxRetries: 3, maxUrlChars: 2048 });
export const DEFAULT_ICAL_HOSTS = Object.freeze(['calendar.google.com']);

export class IcalError extends Error {
  /** @param {string} code stable machine code  @param {string} message safe text  @param {{status?: number, retryAfterMs?: number|null}} [x] */
  constructor(code, message, x = {}) {
    super(redactIcalSecrets(message));
    this.name = 'IcalError';
    this.code = code;
    this.status = x.status ?? null;
    this.retryAfterMs = x.retryAfterMs ?? null;
  }
}

/** Removes feed URLs and `private-<token>` segments from any text (logs, errors, notes). */
export function redactIcalSecrets(s) {
  return String(s ?? '')
    .replace(/(?:https?|webcal):\/\/[^\s"'<>)]*\/calendar\/ical\/[^\s"'<>)]*/gi, '[ical-url]')
    .replace(/private-[A-Za-z0-9_-]{6,}/g, 'private-[redacted]');
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Allowlist: calendar.google.com plus the exact valid hostnames in LLMIDE_ICAL_HOSTS (comma list). */
export function allowedIcalHosts(env = process.env) {
  const extra = String(env.LLMIDE_ICAL_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => HOST_RE.test(h) && !/^\d+(\.\d+)*$/.test(h));
  return [...new Set([...DEFAULT_ICAL_HOSTS, ...extra])];
}

const GOOGLE_PATH_RE = /^\/calendar\/ical\/([^/]{1,300})\/(private-[A-Za-z0-9_-]{8,200}|private|public)\/basic\.ics$/;

/**
 * Validate a feed URL. Returns { url, host, idPrefix } or throws IcalError ICAL_URL_INVALID / ICAL_HOST_NOT_ALLOWED.
 * `webcal://` is accepted and read as https.
 */
export function validateIcalUrl(raw, env = process.env) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > ICAL_FETCH_LIMITS.maxUrlChars) throw new IcalError('ICAL_URL_INVALID', 'The calendar address is missing or too long.');
  let s = raw.trim();
  if (/[\u0000- \u007f]/.test(s)) throw new IcalError('ICAL_URL_INVALID', 'The calendar address contains invalid characters.');
  if (/^webcal:\/\//i.test(s)) s = `https://${s.slice(9)}`;
  let u;
  try { u = new URL(s); } catch { throw new IcalError('ICAL_URL_INVALID', 'The calendar address is not a valid URL.'); }
  if (u.protocol !== 'https:') throw new IcalError('ICAL_URL_INVALID', 'The calendar address must start with https://.');
  if (u.username || u.password) throw new IcalError('ICAL_URL_INVALID', 'The calendar address must not contain a user name or password.');
  if (u.port && u.port !== '443') throw new IcalError('ICAL_URL_INVALID', 'The calendar address must use the standard HTTPS port.');
  if (u.hash) throw new IcalError('ICAL_URL_INVALID', 'The calendar address must not contain a fragment.');
  const host = u.hostname.toLowerCase();
  if (!allowedIcalHosts(env).includes(host)) throw new IcalError('ICAL_HOST_NOT_ALLOWED', 'Only Google Calendar secret iCal addresses (calendar.google.com) are supported.');
  let idPrefix = '';
  if (host === 'calendar.google.com') {
    const m = GOOGLE_PATH_RE.exec(u.pathname);
    if (!m) throw new IcalError('ICAL_URL_INVALID', 'That is not a Google Calendar iCal address. Use "Secret address in iCal format" from the calendar settings.');
    let id = m[1];
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    idPrefix = id.replace(/[^\x21-\x7e]/g, '').slice(0, 8);
  }
  u.hash = '';
  return { url: u.toString(), host, idPrefix };
}

let testTransport = null;
/** Test seam (NODE_ENV=test only): `fn(url, init)` answers like fetch. Pass null to remove. */
export function _setIcalFetchForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setIcalFetchForTests is test-only');
  testTransport = fn;
}
let sleepFn = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
/** Test seam (NODE_ENV=test only): replace the backoff sleep. Pass null to restore. */
export function _setIcalSleepForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setIcalSleepForTests is test-only');
  sleepFn = fn || ((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
}

function transport() {
  if (testTransport) return testTransport;
  if (process.env.NODE_ENV === 'test') throw new IcalError('ICAL_TEST_TRIPWIRE', 'a test reached the iCal transport without a fixture transport installed');
  return makePinnedFetch();
}

async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > max) { try { await res.body?.cancel?.(); } catch { /* ignore */ } throw new IcalError('ICAL_TOO_LARGE', 'The calendar feed is larger than the 5 MB limit.'); }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw new IcalError('ICAL_TOO_LARGE', 'The calendar feed is larger than the 5 MB limit.');
    return t;
  }
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new IcalError('ICAL_TOO_LARGE', 'The calendar feed is larger than the 5 MB limit.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfter(res) {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs, 120) * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, Math.min(when - Date.now(), 120_000)) : null;
}

const safeHeader = (v) => (typeof v === 'string' && v.length <= 300 && /^[\x20-\x7e]+$/.test(v) ? v : null);

async function once(url, { etag, lastModified, env }) {
  const doFetch = transport();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ICAL_FETCH_LIMITS.deadlineMs);
  try {
    const origin = validateIcalUrl(url, env);
    let current = origin.url;
    for (let hop = 0; ; hop++) {
      const headers = { Accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1', 'User-Agent': 'LLM-IDE-ical/1' };
      if (etag && safeHeader(etag)) headers['If-None-Match'] = etag;
      if (lastModified && safeHeader(lastModified)) headers['If-Modified-Since'] = lastModified;
      let res;
      try {
        res = await doFetch(current, { method: 'GET', headers, redirect: 'manual', signal: ctrl.signal });
      } catch (e) {
        if (e instanceof IcalError) throw e;
        if (e?.code === 'SSRF_BLOCKED') throw new IcalError('ICAL_HOST_NOT_ALLOWED', 'The calendar host resolves to a refused address.');
        if (e?.name === 'AbortError') throw new IcalError('ICAL_FETCH_FAILED', 'The calendar request timed out.');
        throw new IcalError('ICAL_FETCH_FAILED', 'Could not reach the calendar host.');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers?.get?.('location');
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        if (!loc || hop >= ICAL_FETCH_LIMITS.maxRedirects) throw new IcalError('ICAL_FETCH_FAILED', 'The calendar host redirected too many times.');
        let next;
        try { next = new URL(loc, current); } catch { throw new IcalError('ICAL_FETCH_FAILED', 'The calendar host sent an invalid redirect.'); }
        let checked;
        try { checked = validateIcalUrl(next.toString(), env); } catch { throw new IcalError('ICAL_HOST_NOT_ALLOWED', 'The calendar host redirected somewhere that is not allowed.'); }
        if (checked.host !== origin.host) throw new IcalError('ICAL_HOST_NOT_ALLOWED', 'The calendar host redirected to a different host.');
        current = checked.url;
        continue;
      }
      if (res.status === 304) { try { await res.body?.cancel?.(); } catch { /* ignore */ } return { status: 304, notModified: true }; }
      if (res.status >= 200 && res.status < 300) {
        const text = await readCapped(res, ICAL_FETCH_LIMITS.maxBytes);
        return { status: res.status, text, etag: safeHeader(res.headers?.get?.('etag')), lastModified: safeHeader(res.headers?.get?.('last-modified')) };
      }
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      return { status: res.status, error: true, retryAfterMs: retryAfter(res) };
    }
  } finally { clearTimeout(timer); }
}

/**
 * Fetch a feed. Resolves { text, etag, lastModified } or { notModified: true } or { revoked: true } (404 or 410).
 * Throws IcalError: ICAL_URL_INVALID, ICAL_HOST_NOT_ALLOWED, ICAL_FETCH_FAILED, ICAL_TOO_LARGE, ICAL_RATE_LIMITED.
 * @param {string} url  @param {{ etag?: string|null, lastModified?: string|null, sleepImpl?: (ms:number)=>Promise<void>, env?: object }} [o]
 */
export async function fetchIcal(url, { etag = null, lastModified = null, sleepImpl = (ms) => sleepFn(ms), env = process.env } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await once(url, { etag, lastModified, env });
    if (r.notModified) return { notModified: true };
    if (!r.error) return { text: r.text, etag: r.etag, lastModified: r.lastModified };
    if (r.status === 404 || r.status === 410) return { revoked: true, status: r.status };
    const retryable = r.status === 429 || r.status >= 500;
    if (retryable && attempt < ICAL_FETCH_LIMITS.maxRetries) {
      await sleepImpl((r.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 16_000)) + Math.floor(Math.random() * 250));
      continue;
    }
    if (r.status === 429) throw new IcalError('ICAL_RATE_LIMITED', 'The calendar host is rate limiting requests. Try again later.', { status: 429, retryAfterMs: r.retryAfterMs });
    throw new IcalError('ICAL_FETCH_FAILED', `The calendar host answered ${r.status}.`, { status: r.status });
  }
}
