// The browser's view of the Box sync folder (design 8.2, SP6; the desktop side is extension/connectors/sync-store/box.mjs).
// Sign-in: Box OAuth 2.0 with the user's OWN Box app, whose client id and secret came in the pairing link (Box documents
// no public-client flow, SP6 D2). A popup carries the consent. The tokens live in this page's memory only and the refresh
// token is revoked on close (per app session, D4). PKCE is sent too (undocumented by Box: accepted or ignored). Writes
// create only new, uniquely named files and never replace or delete anything (one writer per file, design 3).
import { b64u } from "../relay/wire.ts";
import { checkPath, MAX_FILE_BYTES, SyncStoreError, type OpenedStore } from "./mega-store.ts";

const API = "https://api.box.com/2.0";
const UPLOAD = "https://upload.box.com/api/2.0";
const TOKEN = "https://api.box.com/oauth2/token";
const REVOKE = "https://api.box.com/oauth2/revoke";
const AUTHORIZE = "https://account.box.com/api/oauth2/authorize";
const APP_RE = /^[A-Za-z0-9]{16,128}$/;
const SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;
const CHANNEL = "llmide-box-auth";
export interface Authorize { run(url: string): Promise<URLSearchParams>; close(): void }
interface Entry { type: string; id: string; name: string; size?: number }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const callbackUrl = (origin: string) => `${origin}/box-callback.html`;
const rand = (n: number) => b64u(globalThis.crypto.getRandomValues(new Uint8Array(n)));

/** Opens the popup NOW (call it inside the click, or the browser blocks it) and points it at Box once the URL is ready.
 *  box-callback.html posts the redirect's query on a same-origin BroadcastChannel and closes itself. */
export function popupAuthorize(): Authorize {
  const popup = (globalThis as { open?: (u: string, n: string, f: string) => Window | null }).open?.("", "llmide-box-auth", "popup,width=520,height=720") ?? null;
  return {
    run: (url) => new Promise((resolve, reject) => {
      if (!popup) { reject(new SyncStoreError("SYNC_POPUP_BLOCKED")); return; }
      const ch = new BroadcastChannel(CHANNEL);
      let closedTicks = 0;
      const stop = () => { clearInterval(timer); ch.close(); };
      const timer = setInterval(() => { if (popup.closed && ++closedTicks > 1) { stop(); reject(new SyncStoreError("SYNC_AUTH_CANCELLED")); } }, 1000);
      ch.onmessage = (ev) => { if (typeof ev.data === "string") { stop(); resolve(new URLSearchParams(ev.data)); } };
      popup.location.href = url;
    }),
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
  { fetch: f = globalThis.fetch.bind(globalThis) as Fetch, authorize = popupAuthorize(), origin = globalThis.location?.origin ?? "" }:
  { fetch?: Fetch; authorize?: Authorize; origin?: string } = {}): Promise<OpenedStore> {
  if (!APP_RE.test(clientId) || !APP_RE.test(clientSecret)) { authorize.close(); throw new SyncStoreError("SYNC_BAD_CLIENT"); }
  if (!SEGMENT.test(folder) || folder === "." || folder === "..") { authorize.close(); throw new SyncStoreError("SYNC_BAD_PATH"); }

  async function token(form: Record<string, string>): Promise<{ access: string; refresh: string }> {
    let r: Response;
    try {
      r = await f(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...form, client_id: clientId, client_secret: clientSecret }).toString() });
    } catch { throw new SyncStoreError("SYNC_UNREACHABLE"); }
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (r.status === 429) throw new SyncStoreError("SYNC_RATE_LIMITED");
    if (!r.ok || typeof j.access_token !== "string" || typeof j.refresh_token !== "string") throw new SyncStoreError(j.error === "invalid_client" ? "SYNC_BAD_CLIENT" : "SYNC_AUTH_FAILED");
    return { access: j.access_token, refresh: j.refresh_token };
  }

  const verifier = rand(32);
  const challenge = b64u(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = `w.${rand(16)}`;
  const redirect = callbackUrl(origin);
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: "S256" });
  let back: URLSearchParams;
  try { back = await authorize.run(`${AUTHORIZE}?${q}`); } finally { authorize.close(); }
  if (back.get("state") !== state) throw new SyncStoreError("SYNC_AUTH_FAILED");
  if (back.get("error")) throw new SyncStoreError("SYNC_AUTH_CANCELLED");
  let tokens: { access: string; refresh: string } | null = await token({ grant_type: "authorization_code", code: back.get("code") ?? "", redirect_uri: redirect, code_verifier: verifier });

  async function api(url: string, init: RequestInit = {}): Promise<Response> {
    for (let again = true; ; again = false) {
      if (!tokens) throw new SyncStoreError("SYNC_SESSION_EXPIRED");
      let r: Response;
      try { r = await f(url, { ...init, headers: { ...((init.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${tokens.access}` } }); }
      catch { throw new SyncStoreError("SYNC_UNREACHABLE"); }
      if (r.status === 401 && again) { tokens = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh }); continue; }
      if (r.status === 401) throw new SyncStoreError("SYNC_SESSION_EXPIRED");
      if (r.status === 429) throw new SyncStoreError("SYNC_RATE_LIMITED");
      return r;
    }
  }
  const ids = new Map<string, string>(); // folder path below the sync folder ("" = the sync folder) -> Box id
  async function items(id: string): Promise<Entry[] | null> {
    const out: Entry[] = [];
    for (let offset = 0; ; offset += 1000) {
      const r = await api(`${API}/folders/${encodeURIComponent(id)}/items?fields=id,name,type,size&limit=1000&offset=${offset}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new SyncStoreError("SYNC_IO");
      const e = ((await r.json()) as { entries?: Entry[] }).entries ?? [];
      out.push(...e);
      if (e.length < 1000) return out;
    }
  }
  async function mkdir(parent: string, name: string): Promise<string> {
    const r = await api(`${API}/folders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, parent: { id: parent } }) });
    const j = await r.json().catch(() => ({})) as { id?: string; context_info?: { conflicts?: { id?: string } | Array<{ id?: string }> } };
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
      const r = await api(`${API}/files/${encodeURIComponent(file.id)}/content`); // the browser follows Box's redirect and drops the bearer cross-origin
      if (r.status === 404) return null;
      if (!r.ok) throw new SyncStoreError("SYNC_IO");
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
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
      const j = await r.json().catch(() => ({})) as { code?: string };
      throw new SyncStoreError(j.code === "storage_limit_exceeded" ? "SYNC_QUOTA" : "SYNC_IO");
    },
    async close() {
      const t = tokens; tokens = null;
      if (t) await f(REVOKE, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: t.refresh }).toString() }).catch(() => undefined);
    },
  };
}
