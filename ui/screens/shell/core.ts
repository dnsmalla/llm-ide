// Typed client for the Node core's HTTP API: login/refresh, JSON requests, SSE streams.
//
// Security rules (see ui/screens/README.md, plan section 5):
//  - Tokens live in this closure only: never localStorage, sessionStorage, cookies or the DOM,
//    and the public API never returns them. Callers get `request()` / `stream()`, which attach them.
//  - The bearer token is only ever sent to a loopback base URL (`isLoopbackUrl`), whatever the
//    host reports, and paths must be absolute ("/kb/...") so a caller cannot redirect it elsewhere.
//  - Every call is cancellable (AbortSignal) and has a timeout; streams have a connect timeout.
//  - Server text is returned as data; render it as text only.
//
// Auth contract (extension/server/auth-routes.mjs): POST /auth/login {email,password} and
// POST /auth/refresh {refreshToken} answer {user?, accessToken, refreshToken, accessTokenTTLSec};
// errors are {error:{code,message}}. The refresh token rotates, so refresh is single-flight.
//
// Packaged-app note: the Tauri origin (tauri://localhost, http://tauri.localhost) is not in the
// core's CORS allowlist and the CSP `connect-src` does not list the core yet. Until the host
// wiring lands (CSP + LLMIDE_CORS_ORIGINS, or a Rust relay), pass a custom `fetch` to
// `createCoreClient`; the default works in `vite dev` (127.0.0.1 origin) and in tests.

import { SseDecoder, SseError, type SseEvent } from "./sse";

export type { SseEvent } from "./sse";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

/** Token-free view of the login state. */
export interface SessionSnapshot {
  signedIn: boolean;
  user: SessionUser | null;
}

export type CoreErrorCode = "ABORTED" | "TIMEOUT" | "NETWORK" | "NO_SESSION" | "SESSION_EXPIRED" | "BAD_RESPONSE" | "BAD_REQUEST" | "UNSAFE_URL" | string;

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: CoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

/** True for a caller-initiated abort (effect cleanup, navigation): safe to ignore. */
export function isAbortError(e: unknown): boolean {
  return (e instanceof CoreError && e.code === "ABORTED") || (e instanceof Error && e.name === "AbortError");
}

/** Only `http(s)://127.0.0.1|localhost|[::1]:port` may receive credentials. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

export interface CoreClientOptions {
  /** Current core base URL (no trailing path), or `null` while the core is not up. */
  baseUrl: () => string | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh this long before the access token expires. Default 30 s. */
  refreshSkewMs?: number;
  /** Default request timeout. Default 30 s. */
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serialised unless it is a string (sent as given with `text/plain`). */
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Attach the bearer token (default true). Public routes (`/health`, `/auth/*`) pass false. */
  auth?: boolean;
  headers?: Record<string, string>;
}

export interface StreamOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  /** Time allowed to get response headers. Default 30 s. The stream itself has no deadline. */
  connectTimeoutMs?: number;
  /** Sent as `Last-Event-ID` to resume. */
  lastEventId?: string;
  headers?: Record<string, string>;
  /** Cap on one buffered event, in characters. */
  maxEventChars?: number;
}

interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
}

type Listener = () => void;

const SIGNED_OUT: SessionSnapshot = Object.freeze({ signedIn: false, user: null });

/** Links a caller signal and a timeout into one signal; `dispose` must always run. */
function linkSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (parent) {
    if (parent.aborted) ctl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function errorFromResponse(res: Response): Promise<CoreError> {
  let code = "HTTP_ERROR";
  let message = `Request failed (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const env = (b.error && typeof b.error === "object" ? b.error : b) as Record<string, unknown>;
      if (typeof env.code === "string") code = env.code;
      else if (typeof b.error === "string") code = b.error;
      if (typeof env.message === "string") message = env.message;
    }
  } catch {
    // not JSON: keep the generic message
  }
  return new CoreError(res.status, code, message);
}

function parseSession(body: unknown): { tokens: Omit<Tokens, "expiresAt"> & { ttlSec: number }; user: SessionUser | null } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const access = b.accessToken;
  const refresh = b.refreshToken;
  if (typeof access !== "string" || typeof refresh !== "string" || access === "" || refresh === "") {
    throw new CoreError(502, "BAD_RESPONSE", "The core returned an invalid session.");
  }
  const ttl = typeof b.accessTokenTTLSec === "number" && b.accessTokenTTLSec > 0 ? b.accessTokenTTLSec : 900;
  let user: SessionUser | null = null;
  const u = b.user;
  if (u && typeof u === "object") {
    const o = u as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.email === "string") {
      user = { id: o.id, email: o.email, displayName: typeof o.displayName === "string" ? o.displayName : null };
    }
  }
  return { tokens: { access, refresh, ttlSec: ttl }, user };
}

/** Status and decoded body of an answer, success or not (for callers that map error envelopes themselves). */
export interface RawResponse {
  status: number;
  /** Parsed JSON, or `undefined` for an empty body, or `null` when the body is not JSON. */
  body: unknown;
}

/** Receives the access token each time it is issued (login, refresh) and `null` on sign-out. */
export type AccessTokenListener = (token: string | null) => void;

export interface CoreClient {
  request<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  /** Like `request` but never throws on a non-2xx answer: returns the status and body. Transport errors still throw `CoreError`. */
  requestRaw(path: string, opts?: RequestOptions): Promise<RawResponse>;
  /**
   * Hand-off of the current access token to the desktop host (the chat store binding needs it in host memory).
   * The only door a token leaves this closure through; the listener is called at once with the current token
   * (if signed in), then on every refresh and with `null` on sign-out. Never pass it to anything but the host.
   */
  subscribeAccessToken(listener: AccessTokenListener): () => void;
  /** Re-sends the current access token to the listeners (after a core restart the host must bind again). No-op when signed out. */
  republishAccessToken(): void;
  /** Async iterable of SSE events; ends when the server closes, throws `CoreError` on failure/abort. */
  stream(path: string, opts?: StreamOptions): AsyncGenerator<SseEvent, void, void>;
  login(email: string, password: string, signal?: AbortSignal): Promise<SessionSnapshot>;
  register(email: string, password: string, displayName?: string, signal?: AbortSignal): Promise<void>;
  /** `registrationOpen` from GET /auth/well-known (false when it cannot be read). */
  registrationOpen(signal?: AbortSignal): Promise<boolean>;
  logout(): Promise<void>;
  /** Drop the session locally without telling the server (e.g. when the core restarted). */
  clearSession(): void;
  /** `useSyncExternalStore` pair. The snapshot object only changes when the login state does. */
  subscribe(listener: Listener): () => void;
  getSnapshot(): SessionSnapshot;
}

export function createCoreClient(options: CoreClientOptions): CoreClient {
  const doFetch: typeof fetch = options.fetch ?? ((...a) => globalThis.fetch(...a));
  const now = options.now ?? Date.now;
  const skew = options.refreshSkewMs ?? 30_000;
  const defaultTimeout = options.timeoutMs ?? 30_000;

  let tokens: Tokens | null = null;
  let snapshot: SessionSnapshot = SIGNED_OUT;
  let refreshing: Promise<void> | null = null;
  const listeners = new Set<Listener>();
  const tokenListeners = new Set<AccessTokenListener>();
  const emitToken = (t: string | null) => {
    for (const l of [...tokenListeners]) {
      try {
        l(t);
      } catch {
        // a listener must not break the session
      }
    }
  };

  const emit = (next: SessionSnapshot) => {
    if (next.signedIn === snapshot.signedIn && next.user?.id === snapshot.user?.id) return;
    snapshot = next;
    for (const l of [...listeners]) l();
  };

  const base = (): string => {
    const url = options.baseUrl();
    if (!url) throw new CoreError(0, "NETWORK", "The core is not running.");
    const trimmed = url.replace(/\/+$/, "");
    if (!isLoopbackUrl(trimmed)) throw new CoreError(0, "UNSAFE_URL", "Refusing to contact a non-loopback core address.");
    return trimmed;
  };

  const urlFor = (path: string): string => {
    if (!/^\/(?![/\\])/.test(path) || /[\r\n]/.test(path)) throw new CoreError(0, "BAD_REQUEST", "Core paths must start with a single '/'.");
    return base() + path;
  };

  const setTokens = (t: Omit<Tokens, "expiresAt"> & { ttlSec: number }, user: SessionUser | null) => {
    tokens = { access: t.access, refresh: t.refresh, expiresAt: now() + t.ttlSec * 1000 };
    // Older servers omit `user` on refresh: keep the one we have.
    emit({ signedIn: true, user: user ?? snapshot.user });
    emitToken(t.access);
  };

  const drop = () => {
    const had = tokens !== null;
    tokens = null;
    emit(SIGNED_OUT);
    if (had) emitToken(null);
  };

  const rawFetch = async (path: string, init: RequestInit, timeoutMs: number, parent: AbortSignal | undefined): Promise<Response> => {
    const link = linkSignal(parent, timeoutMs);
    try {
      return await doFetch(urlFor(path), { ...init, signal: link.signal, credentials: "omit", cache: "no-store", redirect: "error" });
    } catch (e) {
      if (e instanceof CoreError) throw e;
      if (link.timedOut()) throw new CoreError(0, "TIMEOUT", "The core did not answer in time.");
      if (parent?.aborted || (e instanceof Error && e.name === "AbortError")) throw new CoreError(0, "ABORTED", "Request cancelled.");
      throw new CoreError(0, "NETWORK", "Cannot reach the core.");
    } finally {
      link.dispose();
    }
  };

  const doRefresh = (): Promise<void> => {
    refreshing ??= (async () => {
      const current = tokens;
      if (!current) throw new CoreError(401, "NO_SESSION", "Not signed in.");
      const res = await rawFetch(
        "/auth/refresh",
        { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ refreshToken: current.refresh }) },
        defaultTimeout,
        undefined,
      );
      if (res.status === 401 || res.status === 400 || res.status === 403) {
        drop();
        throw new CoreError(401, "SESSION_EXPIRED", "Your session expired. Sign in again.");
      }
      if (!res.ok) throw await errorFromResponse(res); // transient (5xx, 429): keep the session
      let parsed;
      try {
        parsed = parseSession(await res.json());
      } catch (e) {
        if (e instanceof CoreError) throw e;
        throw new CoreError(502, "BAD_RESPONSE", "The core returned an invalid session.");
      }
      setTokens(parsed.tokens, parsed.user);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const authHeader = async (): Promise<Record<string, string>> => {
    if (!tokens) throw new CoreError(401, "NO_SESSION", "Not signed in.");
    if (tokens.expiresAt - now() <= skew) await doRefresh();
    // `tokens` may have been cleared by a failed refresh, which already threw.
    return tokens ? { Authorization: `Bearer ${tokens.access}` } : {};
  };

  const encodeBody = (body: unknown): { body?: string; type?: string } => {
    if (body === undefined) return {};
    if (typeof body === "string") return { body, type: "text/plain;charset=utf-8" };
    return { body: JSON.stringify(body), type: "application/json" };
  };

  async function send(path: string, opts: RequestOptions, retried: boolean, streamInit?: { accept: string }): Promise<Response> {
    const auth = opts.auth !== false;
    const headers: Record<string, string> = { Accept: streamInit?.accept ?? "application/json", ...opts.headers };
    const enc = encodeBody(opts.body);
    if (enc.type) headers["Content-Type"] = enc.type;
    if (auth) Object.assign(headers, await authHeader());
    const res = await rawFetch(path, { method: opts.method ?? "GET", headers, body: enc.body }, opts.timeoutMs ?? defaultTimeout, opts.signal);
    if (res.status === 401 && auth && !retried && tokens) {
      await res.body?.cancel().catch(() => undefined);
      await doRefresh();
      return send(path, opts, true, streamInit);
    }
    if (res.status === 401 && auth) {
      drop();
      throw new CoreError(401, "SESSION_EXPIRED", "Your session expired. Sign in again.");
    }
    return res;
  }

  const client: CoreClient = {
    async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
      const res = await send(path, opts, false);
      if (!res.ok) throw await errorFromResponse(res);
      if (res.status === 204) return undefined as T;
      try {
        return (await res.json()) as T;
      } catch {
        throw new CoreError(502, "BAD_RESPONSE", "The core returned a body that is not JSON.");
      }
    },

    async requestRaw(path: string, opts: RequestOptions = {}): Promise<RawResponse> {
      const res = await send(path, opts, false);
      if (res.status === 204) return { status: 204, body: undefined };
      let body: unknown = null;
      try {
        const text = await res.text();
        body = text === "" ? undefined : JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: res.status, body };
    },

    republishAccessToken() {
      if (tokens) emitToken(tokens.access);
    },

    subscribeAccessToken(listener) {
      tokenListeners.add(listener);
      if (tokens) {
        try {
          listener(tokens.access);
        } catch {
          // see emitToken
        }
      }
      return () => tokenListeners.delete(listener);
    },

    async *stream(path: string, opts: StreamOptions = {}): AsyncGenerator<SseEvent, void, void> {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;
      const res = await send(
        path,
        { method: opts.method ?? "GET", body: opts.body, signal: opts.signal, timeoutMs: opts.connectTimeoutMs ?? defaultTimeout, headers },
        false,
        { accept: "text/event-stream" },
      );
      if (!res.ok) throw await errorFromResponse(res);
      if (!res.body) throw new CoreError(502, "BAD_RESPONSE", "The core sent no stream body.");
      const reader = res.body.getReader();
      const text = new TextDecoder("utf-8");
      const decoder = new SseDecoder(opts.maxEventChars);
      const onAbort = () => void reader.cancel().catch(() => undefined);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            if (opts.signal?.aborted) throw new CoreError(0, "ABORTED", "Stream cancelled.");
            throw new CoreError(0, "NETWORK", "The stream was interrupted.");
          }
          if (opts.signal?.aborted) throw new CoreError(0, "ABORTED", "Stream cancelled.");
          if (chunk.done) {
            for (const ev of decoder.push(text.decode())) yield ev;
            for (const ev of decoder.end()) yield ev;
            return;
          }
          let events: SseEvent[];
          try {
            events = decoder.push(text.decode(chunk.value, { stream: true }));
          } catch (e) {
            if (e instanceof SseError) throw new CoreError(502, "BAD_RESPONSE", e.message);
            throw e;
          }
          for (const ev of events) yield ev;
        }
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        await reader.cancel().catch(() => undefined);
      }
    },

    async login(email, password, signal) {
      const res = await rawFetch(
        "/auth/login",
        { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ email, password }) },
        defaultTimeout,
        signal,
      );
      if (!res.ok) throw await errorFromResponse(res);
      let parsed;
      try {
        parsed = parseSession(await res.json());
      } catch (e) {
        if (e instanceof CoreError) throw e;
        throw new CoreError(502, "BAD_RESPONSE", "The core returned an invalid session.");
      }
      setTokens(parsed.tokens, parsed.user);
      return snapshot;
    },

    async register(email, password, displayName, signal) {
      const res = await rawFetch(
        "/auth/register",
        { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ email, password, displayName }) },
        defaultTimeout,
        signal,
      );
      if (!res.ok) throw await errorFromResponse(res);
      await res.body?.cancel().catch(() => undefined);
    },

    async registrationOpen(signal) {
      try {
        const res = await rawFetch("/auth/well-known", { method: "GET", headers: { Accept: "application/json" } }, 10_000, signal);
        if (!res.ok) return false;
        const b = (await res.json()) as { registrationOpen?: unknown };
        return b.registrationOpen === true;
      } catch {
        return false;
      }
    },

    async logout() {
      const t = tokens;
      drop(); // local sign-out never waits on the network
      if (!t) return;
      try {
        await rawFetch(
          "/auth/logout",
          { method: "POST", headers: { Authorization: `Bearer ${t.access}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ refreshToken: t.refresh }) },
          5_000,
          undefined,
        );
      } catch {
        // best effort: the server expires the session on its own
      }
    },

    clearSession: drop,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,
  };
  return client;
}
