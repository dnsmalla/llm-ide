// The browser's view of the Box sync folder (design 8.2, SP6; the desktop side is extension/connectors/sync-store/box.mjs).
// Sign-in: Box OAuth 2.0 with the user's OWN Box app, whose client id and secret came in the pairing link (Box documents
// no public-client flow, SP6 D2). A popup carries the consent. The tokens live in this page's memory only and the refresh
// token is revoked on close (per app session, D4). PKCE is sent too (undocumented by Box: accepted or ignored). Writes
// create only new, uniquely named files and never replace or delete anything (one writer per file, design 3). The OAuth
// and the byte cap are SP7's guarded code (sources/oauth.ts, sources/http.ts) with Box's read-write scope.
import { b64u } from "../relay/wire.ts";
import { readCapped } from "../sources/http.ts";
import { authorizeUrl, challengeFor, CHANNEL, exchangeCode, OAuthError, randomString, refreshTokens, revokeToken, waitForCode,
  type ChannelLike, type Every, type ProviderConfig, type Tokens } from "../sources/oauth.ts";
import { checkPath, MAX_FILE_BYTES, SyncStoreError, type OpenedStore } from "./mega-store.ts";

const API = "https://api.box.com/2.0";
const UPLOAD = "https://upload.box.com/api/2.0";
const SCOPE = "root_readwrite";
// The hosts a Box response may land on: the API, the upload host and Box's two pre-signed download hosts (SP7's list).
const HOSTS = ["api.box.com", "upload.box.com", "dl.boxcloud.com", "public.boxcloud.com"];
const LIST_CAP = 4 * 1048576;
const TIMEOUT_MS = 60_000;
const APP_RE = /^[A-Za-z0-9]{16,128}$/;
const SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;
export interface Authorize { run(url: string): Promise<URLSearchParams>; close(): void }
interface Entry { type: string; id: string; name: string; size?: number }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The redirect page, next to the app whatever base path it is served under (VITE_BASE=/ or /app/). */
export const callbackUrl = (baseURI: string) => new URL("box-callback.html", baseURI).toString();
const rand = (n: number) => b64u(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const OAUTH_CODE: Record<string, string> = {
  unreachable: "SYNC_UNREACHABLE", client_refused: "SYNC_BAD_CLIENT", provider_error: "SYNC_IO",
  sign_in_cancelled: "SYNC_AUTH_CANCELLED", sign_in_timeout: "SYNC_AUTH_CANCELLED",
};
const syncError = (e: unknown) => (e instanceof SyncStoreError ? e : new SyncStoreError(e instanceof OAuthError ? OAUTH_CODE[e.code] ?? "SYNC_AUTH_FAILED" : "SYNC_AUTH_FAILED"));
const landedOk = (r: Response) => { try { return !r.url || HOSTS.includes(new URL(r.url).hostname) && new URL(r.url).protocol === "https:"; } catch { return false; } };

/** Opens the popup NOW (call it inside the click, or the browser blocks it) and points it at Box once the URL is ready.
 *  box-callback.html posts { state, code, error } on SP7's same-origin channel; waitForCode takes only our state, checks
 *  the code's shape, and gives up when the popup closes or after SP7's sign-in timeout. */
export function popupAuthorize(o: { channel?: () => ChannelLike; every?: Every; timeoutMs?: number } = {}): Authorize {
  const popup = (globalThis as { open?: (u: string, n: string, f: string) => Window | null }).open?.("", "llmide-box-auth", "popup,width=520,height=720") ?? null;
  return {
    run: async (url) => {
      if (!popup) throw new SyncStoreError("SYNC_POPUP_BLOCKED");
      const state = new URL(url).searchParams.get("state") ?? "";
      const code = waitForCode(state, (o.channel ?? (() => new BroadcastChannel(CHANNEL) as unknown as ChannelLike))(),
        { isClosed: () => popup.closed, every: o.every, timeoutMs: o.timeoutMs });
      code.catch(() => {}); // awaited below; this only stops an early rejection being reported as unhandled
      popup.location.href = url;
      try { return new URLSearchParams({ state, code: await code }); } catch (e) { throw syncError(e); }
    },
    close: () => { try { if (popup && !popup.closed) popup.close(); } catch { /* cross-origin or gone */ } },
  };
}

function multipart(attributes: object, data: Uint8Array): { body: Uint8Array; type: string } {
  const boundary = `llmide${rand(12).replace(/[-_]/g, "x")}`;
  const te = new TextEncoder();
  const head = te.encode(`--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\n\r\n${JSON.stringify(attributes)}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = te.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + data.length + tail.length);
  body.set(head); body.set(data, head.length); body.set(tail, head.length + data.length);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

export async function openBoxStore({ clientId, clientSecret, folder }: { clientId: string; clientSecret: string; folder: string },
  { fetch: f = globalThis.fetch.bind(globalThis) as Fetch, authorize, baseURI = globalThis.document?.baseURI ?? "" }:
  { fetch?: Fetch; authorize?: Authorize; baseURI?: string } = {}): Promise<OpenedStore> {
  const auth = authorize ?? popupAuthorize();
  if (!APP_RE.test(clientId) || !APP_RE.test(clientSecret)) { auth.close(); throw new SyncStoreError("SYNC_BAD_CLIENT"); }
  if (!SEGMENT.test(folder) || folder === "." || folder === "..") { auth.close(); throw new SyncStoreError("SYNC_BAD_PATH"); }
  const app: ProviderConfig = { clientId, clientSecret };
  const ff = f as typeof fetch;
  const withRefresh = (t: Tokens): Tokens & { refresh: string } => { if (!t.refresh) throw new SyncStoreError("SYNC_AUTH_FAILED"); return t as Tokens & { refresh: string }; };

  const verifier = randomString(32);
  const state = `w.${rand(16)}`;
  const redirect = callbackUrl(baseURI);
  let back: URLSearchParams;
  try { back = await auth.run(authorizeUrl("box", app, redirect, state, await challengeFor(verifier), SCOPE)); } finally { auth.close(); }
  if (back.get("state") !== state) throw new SyncStoreError("SYNC_AUTH_FAILED");
  if (back.get("error")) throw new SyncStoreError("SYNC_AUTH_CANCELLED");
  let tokens: (Tokens & { refresh: string }) | null;
  try { tokens = withRefresh(await exchangeCode("box", app, back.get("code") ?? "", verifier, redirect, ff)); } catch (e) { throw syncError(e); }

  // Box refresh tokens are single use: one refresh in flight; concurrent 401s wait for it and retry with its token.
  let renewing: Promise<void> | null = null;
  function renew(sent: string): Promise<void> {
    if (tokens && tokens.access !== sent) return Promise.resolve(); // rotated since this request was sent
    return (renewing ??= (async () => {
      await Promise.resolve(); // runs after `renewing` is assigned, so `finally` always clears it
      const t = tokens;
      try {
        if (!t) throw new SyncStoreError("SYNC_SESSION_EXPIRED");
        const next = withRefresh(await refreshTokens("box", app, t.refresh, redirect, ff));
        if (tokens !== t) { void revokeToken("box", app, next.refresh, ff); throw new SyncStoreError("SYNC_SESSION_EXPIRED"); } // closed meanwhile
        tokens = next;
      } catch (e) { throw syncError(e); }
      finally { renewing = null; }
    })());
  }
  async function api(url: string, init: RequestInit = {}): Promise<Response> {
    for (let again = true; ; again = false) {
      if (renewing) await renewing.catch(() => {});
      if (!tokens) throw new SyncStoreError("SYNC_SESSION_EXPIRED");
      const sent = tokens.access;
      let r: Response;
      // The browser drops Authorization on the cross-origin hop to Box's pre-signed download host.
      try { r = await f(url, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${sent}` },
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) }); }
      catch { throw new SyncStoreError("SYNC_UNREACHABLE"); }
      if (!landedOk(r)) throw new SyncStoreError("SYNC_IO");
      if (r.status === 401 && again) { await renew(sent); continue; }
      if (r.status === 401) throw new SyncStoreError("SYNC_SESSION_EXPIRED");
      if (r.status === 429) throw new SyncStoreError("SYNC_RATE_LIMITED");
      return r;
    }
  }
  async function json(r: Response): Promise<unknown> {
    const { bytes, truncated } = await readCapped(r, LIST_CAP);
    if (truncated) throw new SyncStoreError("SYNC_TOO_LARGE");
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
  }
  const ids = new Map<string, string>(); // folder path below the sync folder ("" = the sync folder) -> Box id
  async function items(id: string): Promise<Entry[] | null> {
    const out: Entry[] = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await api(`${API}/folders/${encodeURIComponent(id)}/items?fields=id,name,type,size&limit=1000&offset=${offset}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new SyncStoreError("SYNC_IO");
      const e = ((await json(r)) as { entries?: Entry[] }).entries ?? [];
      out.push(...e);
      if (e.length < 1000) return out;
    }
  }
  async function mkdir(parent: string, name: string): Promise<string> {
    const r = await api(`${API}/folders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, parent: { id: parent } }) });
    const j = await json(r) as { id?: string; context_info?: { conflicts?: { id?: string } | Array<{ id?: string }> } };
    if (r.ok && j.id) return String(j.id);
    const c = j.context_info?.conflicts;
    const id = Array.isArray(c) ? c[0]?.id : c?.id;
    if (r.status === 409 && id) return String(id);
    throw new SyncStoreError("SYNC_IO");
  }
  /** Folders below the sync folder; segments at index >= mkdirFrom may be created, the rest must exist. */
  async function walk(segs: string[], mkdirFrom: number): Promise<string | null> {
    let id = ids.get("");
    if (!id) {
      const f = (await items("0"))?.find((e) => e.type === "folder" && e.name === folder);
      if (!f) return null; // the desktop creates the sync folder; a device never does
      id = String(f.id); ids.set("", id);
    }
    let key = "";
    for (let i = 0; i < segs.length; i++) {
      key = key ? `${key}/${segs[i]}` : segs[i];
      let next = ids.get(key);
      if (!next) {
        const kids = await items(id);
        if (!kids) { ids.clear(); return null; }
        const f = kids.find((e) => e.type === "folder" && e.name === segs[i]);
        if (f) next = String(f.id);
        else if (i >= mkdirFrom) next = await mkdir(id, segs[i]);
        else return null;
        ids.set(key, next);
      }
      id = next;
    }
    return id;
  }

  return {
    get: async (path) => {
      const segs = checkPath(path);
      const dir = await walk(segs.slice(0, -1), Infinity);
      if (!dir) return null;
      const kids = await items(dir);
      if (!kids) { ids.clear(); return null; }
      const file = kids.find((e) => e.type === "file" && e.name === segs[segs.length - 1]);
      if (!file) return null;
      if ((file.size ?? 0) > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      const r = await api(`${API}/files/${encodeURIComponent(file.id)}/content`);
      if (r.status === 404) return null;
      if (!r.ok) throw new SyncStoreError("SYNC_IO");
      const { bytes, truncated } = await readCapped(r, MAX_FILE_BYTES); // capped while it downloads
      if (truncated) throw new SyncStoreError("SYNC_TOO_LARGE");
      return bytes;
    },
    put: async (path, bytes, mkdirFrom = Infinity) => {
      const segs = checkPath(path);
      if (bytes.length > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      const dir = await walk(segs.slice(0, -1), mkdirFrom);
      if (!dir) throw new SyncStoreError("SYNC_MISSING");
      const { body, type } = multipart({ name: segs[segs.length - 1], parent: { id: dir } }, bytes);
      const r = await api(`${UPLOAD}/files/content`, { method: "POST", headers: { "Content-Type": type }, body: body as unknown as BodyInit });
      if (r.ok || r.status === 409) return; // 409: names are unique per write, so this is a retry of a write that landed
      if (r.status === 404) { ids.clear(); throw new SyncStoreError("SYNC_MISSING"); }
      const j = await json(r).catch(() => ({})) as { code?: string };
      throw new SyncStoreError(j.code === "storage_limit_exceeded" ? "SYNC_QUOTA" : "SYNC_IO");
    },
    async close() {
      const t = tokens; tokens = null;
      if (t) await revokeToken("box", app, t.refresh, ff);
    },
  };
}
