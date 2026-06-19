/**
 * Centralized configuration for the extension.
 * All tunable values live here — no magic numbers scattered in the code.
 */

// Local AI server — configurable via chrome.storage.local.set({ serverUrl: '...' })
const DEFAULT_SERVER_URL = 'http://localhost:3456';

// Only http://localhost or http://127.0.0.1 on the expected llmide
// port are accepted. The server is designed to bind to 127.0.0.1 only
// and is unauthenticated, so pointing this at a remote host would both
// leak transcripts and invite CORS/SSRF surprises. Wildcard ports are
// rejected to keep an attacker process bound to another local port
// from receiving extension requests.
const ALLOWED_SERVER_PORTS = new Set(['3456']);
function isSafeServerUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
    // Default-port URLs (e.g. http://localhost without an explicit
    // port) leave u.port empty — those are not 3456 and should be
    // rejected.
    return ALLOWED_SERVER_PORTS.has(u.port);
  } catch {
    return false;
  }
}

export async function getServerUrl(): Promise<string> {
  try {
    const result = await chrome.storage?.local?.get('serverUrl');
    const raw = result?.serverUrl;
    if (isSafeServerUrl(raw)) {
      // Strip any trailing slash so callers can concat paths cleanly.
      return raw.replace(/\/+$/, '');
    }
    return DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

// Request timeouts
export const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes for AI operations
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

// ---- Session-based auth (v3+) ---------------------------------------
//
// The server requires a JWT access token.  The user obtains one by
// logging in via /auth/login, which returns { accessToken,
// refreshToken, accessTokenTTLSec }.  We keep the access token in
// memory only (lost on extension reload — fine, it's short-lived) and
// the refresh token in chrome.storage so reload-or-restart silently
// re-mints a fresh access token.
//
// All requests go through `authFetch`, which:
//   1. Attaches `Authorization: Bearer <accessToken>` if we have one.
//   2. On 401, attempts a single refresh-and-retry.
//   3. On refresh failure, clears the session and emits a 'session.lost'
//      event the React layer subscribes to (to bounce to a login screen).

const REFRESH_KEY = 'auth.refreshToken';

interface SessionState {
  accessToken: string | null;
  refreshToken: string | null;
  user: { id: string; email: string; displayName: string; role: string } | null;
}

const session: SessionState = {
  accessToken: null,
  refreshToken: null,
  user: null,
};

type SessionListener = (s: SessionState) => void;
const listeners = new Set<SessionListener>();

export function onSessionChange(fn: SessionListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emitSessionChange() {
  const snapshot = { ...session };
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      /* ignore */
    }
  }
}

export function getSession(): Readonly<SessionState> {
  return session;
}

export async function loadStoredSession(): Promise<void> {
  try {
    const r = await chrome.storage?.local?.get(REFRESH_KEY);
    const tok = r?.[REFRESH_KEY];
    if (typeof tok === 'string' && tok) {
      session.refreshToken = tok;
      // Try to mint an access token straight away so the UI can skip
      // the login screen.  Failure is silent — the user just gets the
      // login screen instead.
      try {
        await refreshAccessToken();
      } catch {
        clearSession();
      }
    }
  } catch {
    /* chrome.storage unavailable in tests */
  }
}

export function setSession(next: { accessToken: string; refreshToken: string; user: SessionState['user'] }): void {
  session.accessToken = next.accessToken;
  session.refreshToken = next.refreshToken;
  session.user = next.user;
  // Clear the refresh backoff so a 401 right after manual login can
  // attempt refresh immediately. Without this, a failed refresh that
  // set `_refreshFailedAt` in the previous 30s would gate the first
  // post-login token refresh, presenting a stale-session error to the
  // user even though their explicit login just succeeded.
  _refreshFailedAt = 0;
  chrome.storage?.local?.set({ [REFRESH_KEY]: next.refreshToken }).catch(() => {});
  emitSessionChange();
}

export function clearSession(): void {
  session.accessToken = null;
  session.refreshToken = null;
  session.user = null;
  // Mirror setSession — clearing the session also clears the backoff
  // so the next login attempt is unimpeded.
  _refreshFailedAt = 0;
  chrome.storage?.local?.remove(REFRESH_KEY).catch(() => {});
  emitSessionChange();
}

let _refreshPromise: Promise<string | null> | null = null;
// Remember the last failed-refresh timestamp.  When the refresh
// endpoint returns 401 (token revoked, expired, or invalidated) we
// short-circuit any subsequent 401 retries for REFRESH_BACKOFF_MS
// instead of hammering the server on every queued request.  A
// successful refresh clears the gate.
let _refreshFailedAt = 0;
const REFRESH_BACKOFF_MS = 30_000;
const REFRESH_TIMEOUT_MS = 10_000;

async function refreshAccessToken(): Promise<string | null> {
  if (!session.refreshToken) return null;
  if (_refreshPromise) return _refreshPromise;
  if (_refreshFailedAt && Date.now() - _refreshFailedAt < REFRESH_BACKOFF_MS) {
    return null;
  }
  const url = await getServerUrl();
  _refreshPromise = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
    try {
      const r = await fetch(`${url}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        _refreshFailedAt = Date.now();
        return null;
      }
      const data = await r.json();
      session.accessToken = data.accessToken;
      session.refreshToken = data.refreshToken;
      chrome.storage?.local?.set({ [REFRESH_KEY]: data.refreshToken }).catch(() => {});
      _refreshFailedAt = 0;
      emitSessionChange();
      return data.accessToken;
    } catch {
      _refreshFailedAt = Date.now();
      return null;
    } finally {
      clearTimeout(timer);
      // Defer the null-out one microtask. Without this, the
      // `finally` runs BEFORE the awaiter of _refreshPromise resumes —
      // a parallel `authFetch` reading `if (_refreshPromise && …)`
      // between the `finally` and the outer resolve would see `null`
      // and proceed with the still-stale `session.accessToken`.
      // Queueing a microtask defers the clear until after every
      // currently-pending then-handler has run, eliminating that
      // window.
      queueMicrotask(() => {
        _refreshPromise = null;
      });
    }
  })();
  return _refreshPromise;
}

interface AuthFetchInit extends RequestInit {
  noRetry?: boolean;
  /** Per-call timeout override in ms. Defaults to AUTH_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

// Default timeout for any authFetch call. Hooks that previously called
// fetch() with no signal could hang forever when the local server was
// unreachable; this gives every request a bounded lifetime.
const AUTH_FETCH_TIMEOUT_MS = 15_000;

export class ServerError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function attach(init: RequestInit, token: string | null): RequestInit {
  if (!token) return init;
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * Wrap a RequestInit with an AbortController-backed timeout.
 *
 * Defaulting rules (matter for long-running endpoints like SSE streams,
 * /generate-plan, /code-assist, /generate-docx):
 *
 *   1. If the caller passes an explicit `timeoutMs`, honour it
 *      (including `0` meaning "no timeout").
 *   2. Else if the caller already supplied their own `signal` (every
 *      hook that wraps `AbortController` + a long REQUEST_TIMEOUT_MS
 *      does this), TRUST IT — do NOT layer the 15s default on top, or
 *      we'd hard-abort the caller's deliberate long timeout.
 *   3. Otherwise apply `AUTH_FETCH_TIMEOUT_MS` (15s) as a guardrail
 *      for hooks that forgot to set their own timeout.
 *
 * The caller's signal is still chained in either case so a manual
 * cancel propagates.
 */
function withTimeout(init: AuthFetchInit): { init: RequestInit; cleanup: () => void } {
  const callerProvidedSignal = !!init.signal;
  let timeoutMs: number | undefined;
  if (init.timeoutMs !== undefined) {
    timeoutMs = init.timeoutMs > 0 ? init.timeoutMs : undefined;
  } else if (!callerProvidedSignal) {
    timeoutMs = AUTH_FETCH_TIMEOUT_MS;
  } // else: caller owns the timeout, we don't add one
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  // Forward caller-supplied signal aborts into our controller.
  if (init.signal) {
    if (init.signal.aborted) ctrl.abort();
    else init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  const merged: RequestInit = { ...init, signal: ctrl.signal };
  // Strip our extension fields before handing to fetch().
  delete (merged as AuthFetchInit).noRetry;
  delete (merged as AuthFetchInit).timeoutMs;
  return {
    init: merged,
    cleanup: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

// Circuit breaker — when the server is clearly down (consecutive 5xx
// or network errors), stop hammering and fail fast for a cooldown
// period.  Resets automatically when a request succeeds.
const _breaker = {
  failures: 0,
  openUntil: 0,
  threshold: 5,
  cooldownMs: 10_000,
};

function breakerRecordSuccess() {
  _breaker.failures = 0;
  _breaker.openUntil = 0;
}

function breakerRecordFailure() {
  _breaker.failures += 1;
  if (_breaker.failures >= _breaker.threshold) {
    _breaker.openUntil = Date.now() + _breaker.cooldownMs;
  }
}

function breakerIsOpen(): boolean {
  return _breaker.openUntil > 0 && Date.now() < _breaker.openUntil;
}

export async function authFetch(input: string, init: AuthFetchInit = {}): Promise<Response> {
  if (breakerIsOpen()) {
    return new Response(JSON.stringify({ error: 'Server is temporarily unreachable. Please try again shortly.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (_refreshPromise && !init.noRetry) {
    try {
      await _refreshPromise;
    } catch {
      /* refresh failure is handled below */
    }
  }
  const first = withTimeout(init);
  let r: Response;
  try {
    r = await fetch(input, attach(first.init, session.accessToken));
  } catch (err) {
    first.cleanup();
    breakerRecordFailure();
    throw err;
  } finally {
    first.cleanup();
  }
  if (r.status >= 500) {
    breakerRecordFailure();
  } else {
    breakerRecordSuccess();
  }
  if (r.status === 401 && !init.noRetry && session.refreshToken) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      const retry = withTimeout({ ...init, noRetry: true });
      try {
        r = await fetch(input, attach(retry.init, fresh));
      } finally {
        retry.cleanup();
      }
    } else {
      clearSession();
    }
  }
  return r;
}

// ---- Auth API helpers ------------------------------------------------

interface LoginResponse {
  user: { id: string; email: string; displayName: string; role: string };
  accessToken: string;
  refreshToken: string;
  accessTokenTTLSec: number;
}

export async function apiLogin(email: string, password: string): Promise<LoginResponse> {
  const url = await getServerUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${url}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: ctrl.signal,
    });
    return parseJsonResponse<LoginResponse>(r);
  } finally {
    clearTimeout(timer);
  }
}

export async function apiRegister(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ user: LoginResponse['user'] }> {
  const url = await getServerUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUTH_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${url}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName }),
      signal: ctrl.signal,
    });
    return parseJsonResponse(r);
  } finally {
    clearTimeout(timer);
  }
}

export async function apiLogout(allDevices = false): Promise<void> {
  if (!session.refreshToken && !allDevices) return;
  const url = await getServerUrl();
  const init: AuthFetchInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken, allDevices }),
    noRetry: true,
  };
  await authFetch(`${url}/auth/logout`, init).catch(() => {});
  clearSession();
}

export async function apiWellKnown(): Promise<{ registrationOpen: boolean; vaultKeys: string[] }> {
  const url = await getServerUrl();
  const r = await fetch(`${url}/auth/well-known`);
  return parseJsonResponse(r);
}

// Parse a fetch Response that may carry the new error envelope or the
// legacy { error: "string" } shape.  Throws ServerError on !ok.
export async function parseJsonResponse<T = unknown>(r: Response): Promise<T> {
  let data: unknown;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  if (!r.ok) {
    const env = (data as { error?: unknown })?.error;
    if (env && typeof env === 'object' && 'code' in env) {
      const e = env as { code: string; message: string; details?: unknown };
      throw new ServerError(e.message, e.code, r.status, e.details);
    }
    const legacy = typeof env === 'string' ? env : `Server error ${r.status}`;
    throw new ServerError(legacy, 'UPSTREAM_ERROR', r.status);
  }
  return data as T;
}

// Debug logging — enable by running `localStorage.setItem('LLMIDE_DEBUG', '1')` in devtools
const DEBUG = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('LLMIDE_DEBUG') === '1';
  } catch {
    return false;
  }
})();

export function debug(...args: unknown[]): void {
  if (DEBUG) console.log('[LLM IDE]', ...args);
}

// Timing constants used across the extension
export const TIMING = {
  SESSION_GAP_MS: 5_000,
  MAX_SESSION_DURATION_MS: 2 * 60 * 1_000,
  UPDATE_THROTTLE_MS: 800,
  RECENT_DEDUP_WINDOW_MS: 2_000,
  CC_ENABLE_RETRY_MS: [2_000, 5_000],
  CAPTION_CLEANUP_MS: 60_000,
  SERVER_HEALTH_CHECK_INTERVAL_MS: 30_000,
  CONTENT_SCRIPT_INJECT_DELAY_MS: 200,
} as const;
