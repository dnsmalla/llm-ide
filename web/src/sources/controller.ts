// Direct reads at the source (design 9; no React): sign in to GitLab or Box with read-only OAuth in a pop-up, then
// browse, search and open one file read-only. Tokens live in this controller's memory only (decision D4); app settings
// come from config.ts (D5). Nothing read from a provider is stored.
import { authorizeUrl, callbackUrl, challengeFor, checkConfig, CHANNEL, exchangeCode, OAuthError, randomString, refreshTokens, revokeToken, waitForCode,
  type ChannelLike, type Every, type Provider, type ProviderConfig, type Tokens } from "./oauth.ts";
import { MAX_QUERY, SourceError, type Auth } from "./http.ts";
import { createGitLabClient } from "./gitlab.ts";
import { createBoxClient } from "./box.ts";
import { indexedDbSourcesConfig, memorySourcesConfig, type SourcesConfig, type SourcesConfigStore } from "./config.ts";
import type { Entry, Opened, SourceClient } from "./model.ts";

export const TEXT: Record<string, string> = {
  offline: "You are offline. Documents and code are read live from Box and GitLab and are not kept on this device.",
  unreachable: "The provider is not reachable. Check the network. For Box, also check that this site is in your Box app's CORS domains.",
  timeout: "The provider took too long to answer.",
  signed_out: "Your sign-in ended. Sign in again.",
  forbidden: "The provider refused access to this item.",
  not_found: "Not found. It may have moved or been deleted.",
  rate_limited: "The provider asked us to slow down. Wait a minute and try again.",
  too_large: "Too large to show here. Open it on the provider's site.",
  cors_origin: "Box refused this site. Add this site's address to your Box app's CORS domains.",
  not_ready: "Box is still preparing this file. Try again in a moment.",
  refused_host: "The provider sent us to an address this app does not trust.",
  bad_response: "The provider sent an answer this app cannot read.",
  provider_error: "The provider had an error. Try again later.",
  bad_query: `Enter 1 to ${MAX_QUERY} characters to search.`,
  popup_blocked: "Allow pop-ups for this site to sign in.",
  sign_in_timeout: "Sign-in took too long. Try again.",
  sign_in_cancelled: "Sign-in was cancelled.",
  sign_in_failed: "Sign-in failed.",
  grant_expired: "The sign-in code expired. Try again.",
  client_refused: "The provider refused this app's ID or secret. Check the app settings.",
  bad_client_id: "Enter the application (client) ID from the provider's developer settings.",
  bad_client_secret: "Enter the Box app's client secret.",
  bad_token_response: "The provider sent a sign-in answer this app cannot read.",
  scope_too_wide: "The provider granted more than read access. Use an app limited to read scopes.",
  not_configured: "Set up the app first.",
  not_saved: "This browser cannot keep the app settings (private window or blocked site data). They last for this page only.",
};

export interface PopupLike { location: { href: string }; close(): void; readonly closed: boolean }
export interface SourcesDeps {
  config: SourcesConfigStore; fetchImpl: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void>;
  online: () => boolean; onNetwork: (fn: (online: boolean) => void) => () => void;
  openPopup: () => PopupLike | null; channel: () => ChannelLike; every?: Every; baseURI: () => string; random: (n: number) => Uint8Array;
}
export interface SourcesState {
  loaded: boolean; configured: Record<Provider, boolean>; signedIn: Record<Provider, boolean>;
  provider: Provider | null; online: boolean; busy: boolean; status: string; error: string | null;
  trail: Entry[]; entries: Entry[]; next: string | null; query: string | null; opened: Opened | null;
}
export interface SourcesController {
  subscribe(fn: () => void): () => void; getState(): SourcesState; start(): Promise<void>; dispose(): void;
  configure(p: Provider, c: ProviderConfig): Promise<boolean>; forgetConfig(p: Provider): Promise<void>;
  signIn(p: Provider): Promise<void>; signOut(p: Provider): Promise<void>; choose(p: Provider | null): Promise<void>;
  openEntry(e: Entry): Promise<void>; toCrumb(i: number): Promise<void>; more(): Promise<void>;
  search(q: string): Promise<void>; clearSearch(): Promise<void>; closeFile(): void; redirectUri(): string;
}

const both = <T>(v: T): Record<Provider, T> => ({ gitlab: v, box: v });
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function onNetworkEvents(fn: (online: boolean) => void): () => void {
  if (typeof addEventListener !== "function") return () => {};
  const on = () => fn(true), off = () => fn(false);
  addEventListener("online", on); addEventListener("offline", off);
  return () => { removeEventListener("online", on); removeEventListener("offline", off); };
}

export function createSourcesController(given: Partial<SourcesDeps> = {}): SourcesController {
  // Defaults are built lazily per key, so the server-side render in tests never touches `document` or `window`.
  const d: SourcesDeps = {
    config: given.config ?? indexedDbSourcesConfig() ?? memorySourcesConfig(),
    fetchImpl: given.fetchImpl ?? ((i, init) => fetch(i, init)),
    now: given.now ?? Date.now, sleep: given.sleep ?? realSleep,
    online: given.online ?? (() => globalThis.navigator?.onLine !== false),
    onNetwork: given.onNetwork ?? onNetworkEvents,
    openPopup: given.openPopup ?? (() => window.open("about:blank", "llmide-oauth", "popup,width=520,height=720")),
    channel: given.channel ?? (() => new BroadcastChannel(CHANNEL) as unknown as ChannelLike),
    every: given.every,
    baseURI: given.baseURI ?? (() => document.baseURI),
    random: given.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
  };
  let s: SourcesState = { loaded: false, configured: both(false), signedIn: both(false), provider: null, online: d.online(), busy: false,
    status: "", error: null, trail: [], entries: [], next: null, query: null, opened: null };
  const subs = new Set<() => void>();
  const set = (p: Partial<SourcesState>) => { s = { ...s, ...p }; for (const f of subs) f(); };
  let cfg: SourcesConfig = { v: 1, gitlab: null, box: null };
  const tokens: Record<Provider, Tokens | null> = both(null);
  const refreshing: Partial<Record<Provider, Promise<string | null>>> = {};
  const clients: Partial<Record<Provider, SourceClient>> = {};
  let gen = 0;
  let off: (() => void) | null = null;
  const redirect = () => callbackUrl(d.baseURI());
  const markSigned = () => set({ signedIn: { gitlab: !!tokens.gitlab, box: !!tokens.box } });
  const fail = (e: unknown) => { set({ busy: false, status: "", error: TEXT[(e as { code?: string } | null)?.code ?? ""] ?? TEXT.provider_error }); markSigned(); };

  function refresh(p: Provider): Promise<string | null> {
    return (refreshing[p] ??= (async () => {
      await Promise.resolve(); // runs after `refreshing[p]` is assigned, so `finally` always clears it
      try {
        const t = tokens[p], c = cfg[p];
        if (!t?.refresh || !c) { tokens[p] = null; return null; }
        // Box refresh tokens are single use: one refresh in flight per provider, and any failure ends the sign-in.
        const n = await refreshTokens(p, c, t.refresh, redirect(), d.fetchImpl, d.now);
        tokens[p] = n;
        return n.access;
      } catch { tokens[p] = null; return null; }
      finally { delete refreshing[p]; markSigned(); }
    })());
  }
  const auth = (p: Provider): Auth => ({
    async token() {
      const t = tokens[p]; if (!t) throw new SourceError("signed_out");
      if (t.expiresAt > d.now()) return t.access;
      const n = await refresh(p); if (!n) throw new SourceError("signed_out");
      return n;
    },
    refresh: () => refresh(p),
  });
  const http = () => ({ fetchImpl: d.fetchImpl, sleep: d.sleep, online: d.online, now: d.now });
  const client = (p: Provider): SourceClient => (clients[p] ??= p === "gitlab" ? createGitLabClient(auth(p), http()) : createBoxClient(auth(p), http()));

  async function load(dir: Entry | null, cursor: string | null) {
    const p = s.provider; if (!p) return;
    const g = ++gen;
    set({ busy: true, status: "Loading…", error: null });
    try {
      const page = await client(p).list(dir, cursor);
      if (g === gen) set({ busy: false, status: "", entries: cursor ? [...s.entries, ...page.entries] : page.entries, next: page.next });
    } catch (e) { if (g === gen) fail(e); }
  }
  async function save() { try { await d.config.save(cfg); } catch { set({ error: TEXT.not_saved }); } }
  const valid = (p: Provider, c: unknown): ProviderConfig | null => { try { return c ? checkConfig(p, c as ProviderConfig) : null; } catch { return null; } };

  const api: SourcesController = {
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    getState: () => s,
    async start() {
      off ??= d.onNetwork((online) => set({ online }));
      let raw: SourcesConfig | null = null;
      try { raw = await d.config.load(); } catch { /* unreadable storage: start empty */ }
      cfg = { v: 1, gitlab: valid("gitlab", raw?.gitlab), box: valid("box", raw?.box) };
      set({ loaded: true, configured: { gitlab: !!cfg.gitlab, box: !!cfg.box } });
    },
    dispose() { off?.(); off = null; },
    async configure(p, c) {
      try { cfg = { ...cfg, [p]: checkConfig(p, c) }; } catch (e) { fail(e); return false; }
      delete clients[p];
      set({ configured: { ...s.configured, [p]: true }, error: null });
      await save();
      return true;
    },
    async forgetConfig(p) {
      await api.signOut(p);
      cfg = { ...cfg, [p]: null }; delete clients[p];
      set({ configured: { ...s.configured, [p]: false } });
      await save();
    },
    signIn(p) {
      const popup = d.openPopup(); // synchronously, inside the click, or the browser blocks it
      if (!popup) { set({ error: TEXT.popup_blocked }); return Promise.resolve(); }
      return (async () => {
        try {
          const c = cfg[p]; if (!c) throw new OAuthError("not_configured");
          if (!d.online()) throw new SourceError("offline");
          set({ busy: true, error: null, status: "Waiting for you to sign in in the pop-up window…" });
          const verifier = randomString(32, d.random), state = randomString(16, d.random);
          const code = waitForCode(state, d.channel(), { isClosed: () => popup.closed, every: d.every });
          code.catch(() => {}); // awaited below; this only stops an early rejection being reported as unhandled
          popup.location.href = authorizeUrl(p, c, redirect(), state, await challengeFor(verifier));
          tokens[p] = await exchangeCode(p, c, await code, verifier, redirect(), d.fetchImpl, d.now);
          delete refreshing[p];
          set({ busy: false, status: "" }); markSigned();
        } catch (e) { fail(e); }
        finally { try { popup.close(); } catch { /* already closed */ } }
      })();
    },
    async signOut(p) {
      const t = tokens[p]; tokens[p] = null; delete refreshing[p]; markSigned();
      if (s.provider === p) { gen++; set({ provider: null, trail: [], entries: [], next: null, query: null, opened: null, busy: false, status: "" }); }
      const c = cfg[p];
      if (t && c) await revokeToken(p, c, t.access, d.fetchImpl);
    },
    async choose(p) {
      gen++;
      set({ provider: p, trail: [], entries: [], next: null, query: null, opened: null, error: null, busy: false, status: "" });
      if (p) await load(null, null);
    },
    async openEntry(e) {
      const p = s.provider; if (!p) return;
      if (e.kind !== "file") { set({ trail: [...s.trail, e], query: null, opened: null }); return load(e, null); }
      const g = ++gen;
      set({ busy: true, status: `Opening ${e.name}…`, error: null });
      try { const o = await client(p).open(e); if (g === gen) set({ busy: false, status: "", opened: o }); } catch (err) { if (g === gen) fail(err); }
    },
    async toCrumb(i) { const trail = s.trail.slice(0, i + 1); set({ trail, query: null, opened: null }); await load(trail.at(-1) ?? null, null); },
    async more() { if (s.next && s.query === null) await load(s.trail.at(-1) ?? null, s.next); },
    async search(q) {
      const p = s.provider; if (!p) return;
      const g = ++gen;
      set({ busy: true, status: "Searching…", error: null, opened: null });
      try { const page = await client(p).search(q, s.trail.at(-1) ?? null); if (g === gen) set({ busy: false, status: "", query: q.trim(), entries: page.entries, next: null }); }
      catch (e) { if (g === gen) fail(e); }
    },
    async clearSearch() { set({ query: null }); await load(s.trail.at(-1) ?? null, null); },
    closeFile() { set({ opened: null }); },
    redirectUri: redirect,
  };
  return api;
}
