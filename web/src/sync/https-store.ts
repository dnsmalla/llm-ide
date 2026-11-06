// The browser's view of the user's own sync server (design 8.1): plain HTTPS GET/PUT to https://<host>/sync/<path>,
// which nginx serves only inside this device's folder. No login: the random folder names in the path are the
// capability. Requests send no credentials and no referrer, skip the cache and refuse redirects. Writes create only
// new, uniquely named files in folders the desktop made; nginx refuses anything else.
import { checkPath, MAX_FILE_BYTES, SyncStoreError, type OpenedStore } from "./mega-store.ts";

export const WEB_HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/; // same as extension sftp.mjs
const PUT_MAX = 65536; // nginx client_max_body_size 64k
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const statusError = (s: number) =>
  new SyncStoreError(s === 429 || s === 503 ? "SYNC_RATE_LIMITED" : s === 413 ? "SYNC_TOO_LARGE" : s === 409 ? "SYNC_MISSING" : "SYNC_IO");

export function openHttpsStore(host: string, { fetchFn = (u, i) => globalThis.fetch(u, i) }: { fetchFn?: Fetch } = {}): OpenedStore {
  if (!WEB_HOST_RE.test(host)) throw new SyncStoreError("SYNC_BAD_PATH");
  let closed = false;
  const request = async (path: string, init: RequestInit) => {
    const url = `https://${host}/sync/${checkPath(path).join("/")}`;
    if (closed) throw new SyncStoreError("SYNC_IO");
    try { return await fetchFn(url, { ...init, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" }); }
    catch { throw new SyncStoreError("SYNC_UNREACHABLE"); }
  };
  return {
    async get(path) {
      const r = await request(path, { method: "GET" });
      if (r.status === 404) return null;
      if (r.status !== 200) throw statusError(r.status);
      if (Number(r.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) throw new SyncStoreError("SYNC_TOO_LARGE");
      return bytes;
    },
    async put(path, bytes) {
      checkPath(path);
      if (bytes.length > PUT_MAX) throw new SyncStoreError("SYNC_TOO_LARGE");
      const r = await request(path, { method: "PUT", body: bytes as unknown as BodyInit });
      if (r.status !== 201 && r.status !== 204) throw statusError(r.status);
    },
    async close() { closed = true; },
  };
}
