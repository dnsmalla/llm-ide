// Device OAuth for direct reads (design 9, Q11, Q12): authorization code + PKCE (S256) in a pop-up; the same-origin
// callback page hands the code back over BroadcastChannel. Read-only scopes by default. Shared with SP6, which passes its
// own `scope`. Nothing here touches localStorage or sessionStorage: verifier and state live in the caller's memory.
export type Provider = "gitlab" | "box";
export interface ProviderConfig { clientId: string; clientSecret?: string }
export interface Tokens { access: string; refresh: string | null; expiresAt: number }

export const ENDPOINTS = {
  gitlab: { authorize: "https://gitlab.com/oauth/authorize", token: "https://gitlab.com/oauth/token", revoke: "https://gitlab.com/oauth/revoke", scope: "read_api read_repository" },
  box: { authorize: "https://account.box.com/api/oauth2/authorize", token: "https://api.box.com/oauth2/token", revoke: "https://api.box.com/oauth2/revoke", scope: "root_readonly" },
} as const;
export const CHANNEL = "llmide-oauth";
export const CALLBACK_PATH = "oauth-callback.html";
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "OAuthError"; }
}

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const realRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomString = (bytes = 32, rand: (n: number) => Uint8Array = realRandom): string => b64url(rand(bytes));
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SECRET = /^[A-Za-z0-9]{16,128}$/;
export function checkConfig(p: Provider, c: ProviderConfig): ProviderConfig {
  if (!CLIENT_ID.test(c?.clientId ?? "")) throw new OAuthError("bad_client_id");
  if (p === "gitlab") return { clientId: c.clientId };
  if (!SECRET.test(c.clientSecret ?? "")) throw new OAuthError("bad_client_secret");
  return { clientId: c.clientId, clientSecret: c.clientSecret };
}

export function authorizeUrl(p: Provider, cfg: ProviderConfig, redirectUri: string, state: string, challenge: string, scope: string = ENDPOINTS[p].scope): string {
  const u = new URL(ENDPOINTS[p].authorize);
  u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: "code", state, scope, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return u.toString();
}
export const callbackUrl = (baseURI: string): string => new URL(CALLBACK_PATH, baseURI).toString();

export interface ChannelLike { onmessage: ((e: { data: unknown }) => void) | null; close(): void }
export type Every = (fn: () => void, ms: number) => () => void;
const realEvery: Every = (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); };
const CODE = /^[A-Za-z0-9._~-]{8,2048}$/;

/** Resolves the code for `state` from the callback page; a 1 s ticker notices a closed pop-up or the timeout. */
export function waitForCode(state: string, channel: ChannelLike, o: { timeoutMs?: number; isClosed?: () => boolean; every?: Every } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let ticks = 0;
    let stop: () => void = () => {};
    const end = (fn: () => void) => { stop(); channel.close(); fn(); };
    stop = (o.every ?? realEvery)(() => {
      ticks += 1;
      if (o.isClosed?.()) end(() => reject(new OAuthError("sign_in_cancelled")));
      else if (ticks * 1000 >= (o.timeoutMs ?? SIGN_IN_TIMEOUT_MS)) end(() => reject(new OAuthError("sign_in_timeout")));
    }, 1000);
    channel.onmessage = (e) => {
      const d = e.data as { state?: unknown; code?: unknown; error?: unknown } | null;
      if (!d || d.state !== state) return; // another tab's sign-in: not ours
      if (typeof d.code === "string" && CODE.test(d.code)) { const c = d.code; end(() => resolve(c)); }
      else end(() => reject(new OAuthError(d.error === "access_denied" ? "sign_in_cancelled" : "sign_in_failed")));
    };
  });
}

// Allowlist, not a blocklist: a granted scope outside the requested set (for example GitLab's `sudo`) is refused. GitLab
// always reports its scope, so a missing one is refused too; Box's token response has no scope field, so Box passes.
export function parseTokens(json: unknown, now: number, requested: string, requireScope: boolean): Tokens {
  const j = json as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
  const access = j?.access_token, refresh = j?.refresh_token, exp = j?.expires_in;
  if (typeof access !== "string" || access.length < 8 || access.length > 4096) throw new OAuthError("bad_token_response");
  if (refresh != null && (typeof refresh !== "string" || refresh.length > 4096)) throw new OAuthError("bad_token_response");
  if (typeof j?.scope === "string") {
    const ok = requested.split(" ");
    if (j.scope.split(/\s+/).some((s) => s !== "" && !ok.includes(s))) throw new OAuthError("scope_too_wide");
  } else if (requireScope) throw new OAuthError("scope_too_wide");
  const ttl = typeof exp === "number" && exp > 0 ? Math.min(exp, 86_400) : 3600;
  return { access, refresh: typeof refresh === "string" ? refresh : null, expiresAt: now + ttl * 1000 - 60_000 };
}

async function post(url: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<unknown> {
  let r: Response;
  try {
    r = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(),
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch { throw new OAuthError("unreachable"); }
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new OAuthError(r.status === 400 || r.status === 401 ? ((json as { error?: unknown } | null)?.error === "invalid_grant" ? "grant_expired" : "client_refused") : "provider_error");
  return json;
}

export async function exchangeCode(p: Provider, cfg: ProviderConfig, code: string, verifier: string, redirectUri: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<Tokens> {
  const form: Record<string, string> = { grant_type: "authorization_code", code, client_id: cfg.clientId, redirect_uri: redirectUri, code_verifier: verifier };
  // Box documents no PKCE and requires its secret (spec 8.2); the verifier is sent anyway and is harmless.
  if (p === "box") form.client_secret = cfg.clientSecret ?? "";
  return parseTokens(await post(ENDPOINTS[p].token, form, fetchImpl), now(), ENDPOINTS[p].scope, p === "gitlab");
}

export async function refreshTokens(p: Provider, cfg: ProviderConfig, refresh: string, redirectUri: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<Tokens> {
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refresh, client_id: cfg.clientId };
  if (p === "gitlab") form.redirect_uri = redirectUri;
  else form.client_secret = cfg.clientSecret ?? "";
  return parseTokens(await post(ENDPOINTS[p].token, form, fetchImpl), now(), ENDPOINTS[p].scope, p === "gitlab");
}

/** Best effort: a failed revoke still ends the session here, and the token expires on its own. */
export async function revokeToken(p: Provider, cfg: ProviderConfig, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const form: Record<string, string> = { client_id: cfg.clientId, token };
  if (p === "box") form.client_secret = cfg.clientSecret ?? "";
  try { await post(ENDPOINTS[p].revoke, form, fetchImpl); } catch { /* see above */ }
}
