// One guarded GET for direct reads (design 9, 10): https to the four allowed hosts only, a per-provider pace, a byte cap,
// 401 -> one token refresh, 429/202 -> Retry-After (at most 2 waits, each at most 60 s). Callers get codes, not text.
export type SourceErrorCode = "offline" | "unreachable" | "timeout" | "signed_out" | "forbidden" | "not_found" | "rate_limited"
  | "too_large" | "cors_origin" | "not_ready" | "refused_host" | "bad_response" | "provider_error" | "bad_query";
export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly retryAfterSec: number | null;
  constructor(code: SourceErrorCode, retryAfterSec: number | null = null) { super(code); this.code = code; this.retryAfterSec = retryAfterSec; this.name = "SourceError"; }
}

/** Exact hosts. The CSP connect-src lists the same four (scaffold test). */
export const ALLOWED_HOSTS: readonly string[] = ["gitlab.com", "api.box.com", "dl.boxcloud.com", "public.boxcloud.com"];
export function isAllowedUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password && (x.port === "" || x.port === "443") && ALLOWED_HOSTS.includes(x.hostname);
  } catch { return false; }
}

export interface Auth { token(): Promise<string>; refresh(): Promise<string | null> }
export interface Pacer { wait(): Promise<void> }
export interface HttpDeps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; online?: () => boolean; now?: () => number }
export interface Got { status: number; headers: Headers; bytes: Uint8Array; truncated: boolean }

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function createPacer(perMinute: number, d: HttpDeps = {}): Pacer {
  const gap = 60_000 / perMinute; const now = d.now ?? Date.now; const sleep = d.sleep ?? realSleep;
  let nextAt = 0;
  return { async wait() { const t = now(); const at = Math.max(t, nextAt); nextAt = at + gap; if (at > t) await sleep(at - t); } };
}

const concat = (parts: Uint8Array[], n: number) => { const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const parts: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: concat(parts, n), truncated: false };
    if (n + value.length > cap) {
      parts.push(value.subarray(0, cap - n));
      await reader.cancel().catch(() => {});
      return { bytes: concat(parts, cap), truncated: true };
    }
    parts.push(value); n += value.length;
  }
}

async function statusCode(res: Response): Promise<SourceErrorCode> {
  if (res.status === 401) return "signed_out";
  if (res.status === 403) return ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code === "cors_origin_not_whitelisted" ? "cors_origin" : "forbidden";
  if (res.status === 404) return "not_found";
  if (res.status >= 300 && res.status < 400) return "refused_host";
  return "provider_error";
}

export async function guardedGet(url: string, auth: Auth, pacer: Pacer, cap: number, d: HttpDeps = {}, headers: Record<string, string> = {}): Promise<Got> {
  if (!isAllowedUrl(url)) throw new SourceError("refused_host");
  if (d.online && !d.online()) throw new SourceError("offline");
  const f = d.fetchImpl ?? fetch; const sleep = d.sleep ?? realSleep;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    await pacer.wait();
    const token = await auth.token();
    let res: Response;
    try {
      // The browser drops Authorization on the cross-origin hop to Box's pre-signed download host.
      res = await f(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(20_000) });
    } catch (e) { throw new SourceError((e as Error | undefined)?.name === "TimeoutError" ? "timeout" : "unreachable"); }
    if (res.url && !isAllowedUrl(res.url)) throw new SourceError("refused_host");
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      if (!(await auth.refresh())) throw new SourceError("signed_out");
      continue;
    }
    if (res.status === 429 || res.status === 202) {
      const sec = Math.min(Math.max(Number(res.headers.get("retry-after")) || 2, 1), 60);
      if (attempt < 2) { await sleep(sec * 1000); continue; }
      throw new SourceError(res.status === 202 ? "not_ready" : "rate_limited", sec);
    }
    if (!res.ok) throw new SourceError(await statusCode(res));
    const { bytes, truncated } = await readCapped(res, cap);
    return { status: res.status, headers: res.headers, bytes, truncated };
  }
}

export function parseJson(g: Pick<Got, "bytes" | "truncated">): unknown {
  if (g.truncated) throw new SourceError("too_large");
  try { return JSON.parse(new TextDecoder().decode(g.bytes)); } catch { throw new SourceError("bad_response"); }
}

export const MAX_QUERY = 200;
export function checkQuery(q: string): string {
  const t = q.trim();
  if (t.length < 1 || t.length > MAX_QUERY) throw new SourceError("bad_query");
  return t;
}
