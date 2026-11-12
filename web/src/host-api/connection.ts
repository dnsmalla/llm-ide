// Host API v1 client connection: one WebSocket, request/response correlation by client id, hello then token or PIN
// auth, pushed events with rev-gap resync, reconnect with backoff. Framework- and DOM-free: Node tests and the e2e
// drive it with the global WebSocket. Never logs frames (they can carry the token or the PIN).
import {
  HOST_API_CAPABILITIES, HOST_API_COMMANDS, HOST_API_ERROR_CODES, HOST_API_EVENT_NAMES, HOST_API_LIMITS, HOST_API_VERSION,
  type HostApiCapability, type HostApiCommandName, type HostApiErrorCode, type HostApiEventMap, type HostApiEventName,
  type HostApiRequest, type HostApiResult,
} from "./types.generated.ts";

export type ConnectionState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "needsPin" }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number; inMs: number; unopened: number } // unopened: consecutive attempts whose socket never opened
  | { kind: "failed"; code: HostApiErrorCode; message: string };

export class HostApiError extends Error {
  readonly code: HostApiErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(code: HostApiErrorCode, message: string, retryable = false, retryAfterMs: number | null = null) {
    super(message);
    this.name = "HostApiError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export type HostEvent = {
  [E in HostApiEventName]: { command: E; payload: HostApiEventMap[E]; rev: number; replyTo: string | null };
}[HostApiEventName];

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface TokenStore { get(): string | null; set(token: string | null): void }

export interface HostConnectionOptions {
  url: string;
  clientName: string;
  clientVersion: string;
  tokens: TokenStore;
  createSocket?: (url: string) => SocketLike;
  timeoutMs?: number;
  backoffMs?: (attempt: number) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  pingMs?: number;
  /** Calls fn when the page becomes visible again or the network comes back; returns an unsubscribe. */
  onWake?: (fn: () => void) => () => void;
}

export interface HostLink {
  readonly capabilities: ReadonlySet<HostApiCapability>;
  send<C extends HostApiCommandName>(command: C, payload: HostApiRequest<C>): { id: string; done: Promise<HostApiResult<C>> };
  onEvent(fn: (e: HostEvent) => void): () => void;
  onResync(fn: () => void): () => void;
  onState(fn: (s: ConnectionState) => void): () => void;
}

export const ORIGIN_HINT =
  "Cannot reach the host. Check the address, that the desktop app runs with the Host API enabled, " +
  "and that this page's origin is listed in LLMIDE_HOST_API_WEB_ORIGINS.";
/** Shown after UNOPENED_LIMIT attempts in a row where the socket never opened (origin refused, certificate, port). */
export const CERT_HINT =
  "If the address uses wss://, open its https:// address in this browser once and trust the certificate. " +
  "If the desktop's port or address changed, forget this host and enter the new address.";
export const UNOPENED_LIMIT = 3;
// A ping while idle finds a half-open socket (sleep, network change) before the user's next request does.
export const PING_MS = 25_000;
export const defaultBackoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);

const EVENTS = new Set<string>(HOST_API_EVENT_NAMES);
const CAPS = new Set<string>(HOST_API_CAPABILITIES);
const CODES = new Set<string>(HOST_API_ERROR_CODES);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const unreachable = (m: string) => new HostApiError("host_unreachable", m, true);
const refused = (e: HostApiError): { id: string; done: Promise<never> } => {
  const done = Promise.reject(e);
  done.catch(() => {});
  return { id: "", done };
};
function browserWake(fn: () => void): () => void {
  const g = globalThis as unknown as {
    addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void;
    document?: { visibilityState?: string; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
  };
  const visible = () => { if (g.document?.visibilityState === "visible") fn(); };
  g.addEventListener?.("online", fn);
  g.document?.addEventListener?.("visibilitychange", visible);
  return () => { g.removeEventListener?.("online", fn); g.document?.removeEventListener?.("visibilitychange", visible); };
}
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

interface Pending { frame: string; idempotent: boolean; retried: boolean; timer: unknown; resolve: (r: never) => void; reject: (e: HostApiError) => void }
type Settle = { resolve: (r: "ready" | "needsPin") => void; reject: (e: HostApiError) => void };

export class HostConnection implements HostLink {
  #o: Required<HostConnectionOptions>;
  #socket: SocketLike | null = null;
  #state: ConnectionState = { kind: "idle" };
  #caps = new Set<HostApiCapability>();
  #pending = new Map<string, Pending>();
  #onEvent = new Set<(e: HostEvent) => void>();
  #onResync = new Set<() => void>();
  #onState = new Set<(s: ConnectionState) => void>();
  #rev = -1;
  #attempt = 0;
  #retryTimer: unknown = null;
  #pingTimer: unknown = null;
  #unopened = 0;
  #offWake: (() => void) | null = null;
  #wanted = false;
  #pin: string | null = null;
  #settle: Settle | null = null;
  #hello: HostApiResult<"host.hello"> | null = null;

  constructor(o: HostConnectionOptions) {
    this.#o = {
      timeoutMs: 15_000,
      backoffMs: defaultBackoff,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      pingMs: PING_MS,
      onWake: browserWake,
      ...o,
    } as Required<HostConnectionOptions>;
  }

  get state(): ConnectionState { return this.#state; }
  get capabilities(): ReadonlySet<HostApiCapability> { return this.#caps; }
  get hello(): HostApiResult<"host.hello"> | null { return this.#hello; }

  onEvent(fn: (e: HostEvent) => void) { this.#onEvent.add(fn); return () => { this.#onEvent.delete(fn); }; }
  onResync(fn: () => void) { this.#onResync.add(fn); return () => { this.#onResync.delete(fn); }; }
  onState(fn: (s: ConnectionState) => void) { this.#onState.add(fn); return () => { this.#onState.delete(fn); }; }

  // Contract: the promise settles on the first outcome (ready, needsPin or an error). With a stored token the client
  // keeps reconnecting after a rejection, so callers watch onState; a rejection nobody awaits is not "unhandled".
  connect(pin?: string): Promise<"ready" | "needsPin"> {
    this.#reject(unreachable("Superseded by a new connect()."));
    const old = this.#socket;
    this.#socket = null; // the old socket's handlers are now stale
    this.#rejectAll("The connection was restarted.");
    old?.close(1000);
    this.#wanted = true;
    this.#pin = pin ?? null;
    this.#offWake ??= this.#o.onWake(() => this.#wake());
    const p = new Promise<"ready" | "needsPin">((resolve, reject) => { this.#settle = { resolve, reject }; });
    p.catch(() => {});
    this.#open();
    return p;
  }

  async pair(pin: string): Promise<void> {
    if (this.#state.kind !== "needsPin") throw new HostApiError("denied", "Pairing needs a connected host that asked for a PIN.");
    const r = await this.#request("host.auth.pair", { pin }).done;
    if (typeof r?.token !== "string" || !Array.isArray(r.capabilities)) throw new HostApiError("internal", "The host sent an invalid pairing reply.");
    this.#o.tokens.set(r.token);
    this.#caps = this.#known(r.capabilities);
    this.#ready();
  }

  send<C extends HostApiCommandName>(command: C, payload: HostApiRequest<C>): { id: string; done: Promise<HostApiResult<C>> } {
    if (this.#state.kind !== "ready") return refused(unreachable("Not connected to the host."));
    if (!this.#caps.has(HOST_API_COMMANDS[command].capability)) {
      return refused(new HostApiError("capability_unavailable", "This host does not serve that feature."));
    }
    return this.#request(command, payload);
  }

  close(): void {
    this.#wanted = false;
    this.#pin = null;
    this.#clearRetry();
    this.#clearPing();
    this.#offWake?.(); this.#offWake = null;
    const s = this.#socket;
    this.#socket = null;
    this.#rejectAll("The connection was closed.");
    s?.close(1000);
    this.#setState({ kind: "idle" });
  }

  async forget(): Promise<boolean> {
    const token = this.#o.tokens.get();
    let revoked = false;
    if (token && this.#state.kind === "ready") {
      try { revoked = (await this.#request("host.auth.revoke", { token }).done).revoked; } catch { /* host gone: revoke it in desktop Settings */ }
    }
    this.#o.tokens.set(null);
    this.close();
    return revoked;
  }

  /** Back on screen or online: retry now instead of waiting out the backoff; when ready, check the socket at once. */
  #wake() {
    if (!this.#wanted) return;
    if (this.#state.kind === "reconnecting") return this.#open();
    if (this.#state.kind === "ready") this.#ping();
  }

  #schedulePing() {
    this.#clearPing();
    if (this.#o.pingMs > 0) this.#pingTimer = this.#o.setTimer(() => { this.#pingTimer = null; this.#ping(); }, this.#o.pingMs);
  }

  #ping() {
    this.#clearPing();
    const s = this.#socket;
    if (this.#state.kind !== "ready" || !s) return;
    // #arm already drops the socket when the ping (resent once) gets no answer; any reply means the link is alive.
    this.#request("host.ping", {}).done.then(() => {}, () => {}).finally(() => { if (this.#socket === s && this.#state.kind === "ready") this.#schedulePing(); });
  }

  #open() {
    this.#clearRetry();
    this.#clearPing();
    this.#rev = -1;
    this.#setState({ kind: "connecting" });
    let s: SocketLike;
    try { s = this.#o.createSocket(this.#o.url); } catch { this.#lost(false); return; }
    this.#socket = s;
    let opened = false;
    s.onopen = () => { if (this.#socket !== s) return; opened = true; void this.#handshake(); };
    s.onmessage = (e) => { if (this.#socket === s) this.#receive(e.data); };
    s.onclose = () => { if (this.#socket === s) this.#lost(opened); };
    s.onerror = () => {}; // a close always follows
  }

  async #handshake() {
    try {
      const hello = await this.#request("host.hello", {
        clientName: this.#o.clientName, clientVersion: this.#o.clientVersion, platform: "web", apiVersions: [HOST_API_VERSION],
      }).done;
      if (hello.apiVersion !== HOST_API_VERSION || !hello.apiVersions.includes(HOST_API_VERSION)) {
        return this.#fail(new HostApiError("internal", "This host does not speak Host API v1."));
      }
      this.#hello = hello;
      this.#caps = this.#known(hello.capabilities);
      if (!hello.requiresAuth) return this.#ready();
      const token = this.#o.tokens.get();
      if (token) {
        try {
          this.#caps = this.#known((await this.#request("host.auth.token", { token }).done).capabilities);
          return this.#ready();
        } catch (e) {
          if (!(e instanceof HostApiError) || e.code !== "auth_failed" || e.retryable) throw e;
          this.#o.tokens.set(null); // revoked or expired: pair again
        }
      }
      const pin = this.#pin;
      this.#pin = null;
      this.#setState({ kind: "needsPin" });
      if (!pin) return this.#resolve("needsPin");
      try { await this.pair(pin); } catch (e) { this.#reject(e instanceof HostApiError ? e : new HostApiError("internal", "Pairing failed.")); }
    } catch (e) {
      const err = e instanceof HostApiError ? e : new HostApiError("internal", "The host answered with something this page cannot read.");
      if (err.code === "host_unreachable") { // #lost owns this path; a timeout leaves the socket open, so close it
        if (this.#socket?.readyState === 1) this.#socket.close();
        return;
      }
      if (err.retryable && this.#o.tokens.get()) { this.#socket?.close(); return; } // throttled: back off and retry
      this.#fail(err);
    }
  }

  #ready() {
    this.#attempt = 0;
    this.#unopened = 0;
    this.#schedulePing();
    this.#pin = null;
    this.#setState({ kind: "ready" });
    this.#resolve("ready");
    for (const fn of this.#onResync) fn();
  }

  #fail(err: HostApiError) {
    this.#wanted = false;
    this.#clearPing();
    const s = this.#socket;
    this.#socket = null;
    this.#rejectAll(err.message);
    s?.close(1000);
    this.#setState({ kind: "failed", code: err.code, message: err.message });
    this.#reject(err);
  }

  #lost(opened: boolean) {
    const askedPin = this.#state.kind === "needsPin";
    this.#socket = null;
    this.#clearPing();
    this.#unopened = opened ? 0 : this.#unopened + 1;
    this.#rejectAll("The connection to the host closed.");
    this.#reject(unreachable(opened ? "The connection to the host closed." : ORIGIN_HINT));
    if (!this.#wanted) return this.#setState({ kind: "idle" });
    if (!this.#o.tokens.get()) {
      this.#wanted = false; // never paired: nothing to resume
      return this.#setState(askedPin ? { kind: "idle" } : { kind: "failed", code: "host_unreachable", message: ORIGIN_HINT });
    }
    this.#attempt += 1;
    const inMs = this.#o.backoffMs(this.#attempt);
    this.#setState({ kind: "reconnecting", attempt: this.#attempt, inMs, unopened: this.#unopened });
    this.#retryTimer = this.#o.setTimer(() => { this.#retryTimer = null; this.#open(); }, inMs);
  }

  #request<C extends HostApiCommandName>(command: C, payload: HostApiRequest<C>): { id: string; done: Promise<HostApiResult<C>> } {
    const id = `c-${crypto.randomUUID()}`;
    const frame = JSON.stringify({ apiVersion: HOST_API_VERSION, id, type: "request", command, payload, ts: Date.now() });
    const done = new Promise<HostApiResult<C>>((resolve, reject) => {
      const s = this.#socket;
      if (!s || s.readyState !== 1) return reject(unreachable("Not connected to the host."));
      if (utf8Bytes(frame) > HOST_API_LIMITS.maxFrameBytes) return reject(new HostApiError("invalid_payload", "The message is larger than 1 MiB."));
      const p: Pending = { frame, idempotent: HOST_API_COMMANDS[command].idempotent, retried: false, timer: null, resolve: resolve as (r: never) => void, reject };
      this.#pending.set(id, p);
      this.#arm(id, p);
      s.send(frame);
    });
    done.catch(() => {}); // callers that await still see the rejection; ones that drop it do not crash
    return { id, done };
  }

  #arm(id: string, p: Pending) {
    p.timer = this.#o.setTimer(() => {
      if (p.idempotent && !p.retried && this.#socket?.readyState === 1) {
        p.retried = true;
        this.#socket.send(p.frame);
        return this.#arm(id, p);
      }
      this.#pending.delete(id);
      p.reject(unreachable("The host did not answer in time."));
      // A silent host while "ready" is likely a half-open socket (e.g. after sleep). Treat it as lost now: the browser
      // may take minutes to report a dead TCP socket closed, so do not wait for its onclose.
      const s = this.#socket;
      if (this.#state.kind === "ready" && s?.readyState === 1) { this.#socket = null; s.close(); this.#lost(true); }
    }, this.#o.timeoutMs);
  }

  #receive(data: unknown) {
    if (typeof data !== "string" || data.length > HOST_API_LIMITS.maxFrameBytes) return;
    let f: unknown;
    try { f = JSON.parse(data); } catch { return; }
    if (!isObj(f) || f.apiVersion !== HOST_API_VERSION) return;
    const rev = Number.isInteger(f.rev) && (f.rev as number) >= 0 ? (f.rev as number) : null;
    const replyTo = typeof f.replyTo === "string" ? f.replyTo : null;
    if (f.type === "response" || f.type === "error") {
      if (rev !== null) this.#rev = Math.max(this.#rev, rev);
      const p = replyTo ? this.#pending.get(replyTo) : undefined;
      if (!p || !replyTo) return;
      this.#pending.delete(replyTo);
      this.#o.clearTimer(p.timer);
      if (f.type === "response") {
        return isObj(f.result) ? p.resolve(f.result as never) : p.reject(new HostApiError("internal", "The host sent an unreadable reply."));
      }
      const e = isObj(f.error) ? f.error : {};
      const d = isObj(e.details) ? e.details : {};
      return p.reject(new HostApiError(
        CODES.has(e.code as string) ? (e.code as HostApiErrorCode) : "internal",
        typeof e.message === "string" && e.message ? e.message.slice(0, 500) : "The host refused the request.",
        e.retryable === true,
        Number.isInteger(d.retryAfterMs) ? (d.retryAfterMs as number) : null,
      ));
    }
    if (f.type !== "event" || typeof f.command !== "string" || !EVENTS.has(f.command) || !isObj(f.payload) || rev === null) return;
    const gap = this.#rev >= 0 && rev > this.#rev + 1;
    this.#rev = Math.max(this.#rev, rev);
    if (f.command === "host.capabilities" && Array.isArray(f.payload.capabilities)) this.#caps = this.#known(f.payload.capabilities);
    const ev = { command: f.command, payload: f.payload, rev, replyTo } as HostEvent;
    for (const fn of this.#onEvent) fn(ev);
    if (gap) for (const fn of this.#onResync) fn();
  }

  #known(list: readonly unknown[]): Set<HostApiCapability> {
    return new Set(list.filter((c): c is HostApiCapability => typeof c === "string" && CAPS.has(c)));
  }

  #rejectAll(message: string) {
    for (const p of this.#pending.values()) { this.#o.clearTimer(p.timer); p.reject(unreachable(message)); }
    this.#pending.clear();
  }

  #resolve(r: "ready" | "needsPin") { const s = this.#settle; this.#settle = null; s?.resolve(r); }
  #reject(e: HostApiError) { const s = this.#settle; this.#settle = null; s?.reject(e); }
  #clearPing() { if (this.#pingTimer !== null) { this.#o.clearTimer(this.#pingTimer); this.#pingTimer = null; } }
  #clearRetry() { if (this.#retryTimer !== null) { this.#o.clearTimer(this.#retryTimer); this.#retryTimer = null; } }
  #setState(s: ConnectionState) { this.#state = s; for (const fn of this.#onState) fn(s); }
}
